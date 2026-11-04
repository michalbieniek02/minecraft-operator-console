"""Forced SSH command: Minecraft operations only; never executes client shell input."""
import base64
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
import fcntl

CONFIG = Path('/etc/minecraft-panel.json')
STATE = Path('/var/lib/minecraft-panel')
FIFO = '/run/minecraft-console'


def redact(text):
    text = re.sub(r'\x1b\[[0-9;]*[A-Za-z]', '', str(text))
    text = re.sub(r'(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?', '[adres ukryty]', text)
    text = re.sub(r'\bvps-[\w-]+(?:\.vps\.ovh\.net)?\b', '[serwer]', text, flags=re.I)
    def ipv6(match):
        value = match.group().strip('[]')
        try:
            ipaddress.IPv6Address(value)
            return '[adres ukryty]'
        except ValueError:
            return match.group()
    text = re.sub(r'\[?[0-9a-fA-F]*:[0-9a-fA-F:]+\]?', ipv6, text)
    return ''.join(c for c in text if c in '\n\t' or ord(c) >= 32)


def token(config):
    payload = base64.urlsafe_b64encode(json.dumps({'exp': int(time.time()) + 28800, 'id': secrets.token_hex(16)}).encode()).decode()
    sig = hmac.new(bytes.fromhex(config['session_key']), payload.encode(), 'sha256').hexdigest()
    return payload + '.' + sig


def authorized(value, config):
    try:
        payload, sig = value.split('.')
        expected = hmac.new(bytes.fromhex(config['session_key']), payload.encode(), 'sha256').hexdigest()
        data = json.loads(base64.urlsafe_b64decode(payload))
        return hmac.compare_digest(sig, expected) and time.time() < data['exp'] <= time.time() + 28800 and bool(data['id'])
    except (ValueError, TypeError, KeyError):
        return False


def limited(key, maximum, window):
    """One root-owned rate file per bucket, with locking across SSH processes."""
    STATE.mkdir(mode=0o700, exist_ok=True)
    path = STATE / hashlib.sha256(key.encode()).hexdigest()
    now = time.time()
    with path.open('a+') as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.seek(0)
        try:
            data = json.load(f)
        except ValueError:
            data = []
        data = [t for t in data if now - t < window]
        blocked = len(data) >= maximum
        if not blocked:
            data.append(now)
        f.seek(0)
        f.truncate()
        json.dump(data, f)
        return blocked


def command(value):
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= 300:
        raise ValueError('Komenda musi mieć od 1 do 300 znaków.')
    value = value.strip().removeprefix('/')
    if not value or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError('Komenda musi mieścić się w jednym wierszu.')
    return value


def run(*args):
    return subprocess.run(args, capture_output=True, text=True, timeout=8)


def handle(request, config):
    op = request.get('op')
    if op == 'login':
        client = str(request.get('client', 'unknown'))[:100]
        if limited('login-global', 100, 900) or limited('login-' + client, 8, 900):
            return {'error': 'Za dużo prób. Spróbuj ponownie za 15 minut.', 'code': 429}
        password = request.get('password', '')
        if not isinstance(password, str) or len(password) > 128:
            return {'error': 'Nieprawidłowe hasło.', 'code': 401}
        actual = hashlib.scrypt(password.encode(), salt=bytes.fromhex(config['salt']), n=16384, r=8, p=1).hex()
        if not hmac.compare_digest(actual, config['password_hash']):
            return {'error': 'Nieprawidłowe hasło.', 'code': 401}
        return {'token': token(config)}
    session = request.get('session', '')
    if not isinstance(session, str) or len(session) > 700 or not authorized(session, config):
        return {'error': 'Zaloguj się do panelu.', 'code': 401}
    if limited('session-' + session, 100, 60):
        return {'error': 'Zwolnij na chwilę i spróbuj ponownie.', 'code': 429}
    if op == 'status':
        state = run('/usr/bin/systemctl', 'is-active', 'minecraft.service').stdout.strip()
        raw = run('/usr/bin/journalctl', '-u', 'minecraft.service', '-n', '140', '--no-pager', '-o', 'cat').stdout
        logs = redact(raw)[-26000:]
        return {'state': state if state in ('active', 'activating', 'deactivating', 'failed') else 'inactive', 'logs': logs}
    if op in ('start', 'stop'):
        if limited('power', 8, 60):
            return {'error': 'Poczekaj chwilę przed kolejną zmianą.', 'code': 429}
        result = run('/usr/bin/systemctl', '--no-block', op, 'minecraft.service')
        if result.returncode:
            return {'error': 'Nie udało się zmienić stanu serwera.', 'code': 503}
        return {'ok': True}
    if op == 'command':
        value = command(request.get('command'))
        if limited('console', 30, 60):
            return {'error': 'Limit 30 komend na minutę.', 'code': 429}
        if run('/usr/bin/systemctl', 'is-active', 'minecraft.service').stdout.strip() != 'active':
            return {'error': 'Najpierw uruchom serwer.', 'code': 409}
        fd = os.open(FIFO, os.O_WRONLY | os.O_NONBLOCK)
        try:
            os.write(fd, (value + '\n').encode())
        finally:
            os.close(fd)
        return {'ok': True}
    return {'error': 'Nieznana operacja.', 'code': 400}


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(8193)
        if len(raw) > 8192:
            raise ValueError('Żądanie jest zbyt duże.')
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise ValueError('Nieprawidłowe żądanie.')
        response = handle(request, json.loads(CONFIG.read_text()))
    except ValueError as error:
        response = {'error': redact(str(error)), 'code': 400}
    except Exception:
        response = {'error': 'Serwer nie może teraz wykonać operacji.', 'code': 503}
    print(json.dumps(response, ensure_ascii=True))
