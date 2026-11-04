'use strict';
const $ = (id) => document.getElementById(id);
let authenticated = false;
let polling = false;
let busy = false;
let serverState = 'unknown';
let lastLogs = null;
let history = [];
let historyIndex = 0;
let pendingUntil = 0;

async function api(op, extra = {}) {
  const response = await fetch('/api/panel', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Panel-Request': '1' },
    credentials: 'same-origin', cache: 'no-store',
    body: JSON.stringify({ op, ...extra }), signal: AbortSignal.timeout(17000)
  });
  const data = await response.json();
  if (response.status === 401 && op !== 'login') showLogin();
  if (!response.ok) throw new Error(data.error || 'Nie udało się wykonać operacji.');
  return data;
}

function showLogin() {
  authenticated = false;
  $('panel').hidden = true;
  $('boot').hidden = true;
  $('login').hidden = false;
  $('password').focus();
}

function showPanel() {
  authenticated = true;
  $('login').hidden = true;
  $('boot').hidden = true;
  $('panel').hidden = false;
}

function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('notice-error', error);
}

function controls() {
  const active = serverState === 'active';
  const transitioning = serverState === 'activating' || serverState === 'deactivating' || Date.now() < pendingUntil;
  $('start').disabled = busy || transitioning || active || serverState === 'unknown';
  $('stop').disabled = busy || transitioning || !active;
  $('command').disabled = busy || transitioning || !active;
  $('send').disabled = busy || transitioning || !active;
}

function render(data) {
  serverState = data.state;
  const labels = { active: 'Serwer włączony', inactive: 'Serwer wyłączony', activating: 'Uruchamianie…', deactivating: 'Zapisywanie i wyłączanie…', failed: 'Serwer zatrzymany' };
  $('state').textContent = labels[data.state] || 'Nieznany stan';
  $('state-dot').className = 'state-dot ' + data.state;
  if (data.logs !== lastLogs) {
    lastLogs = data.logs;
    const output = $('output');
    const fragment = document.createDocumentFragment();
    for (const line of (data.logs || 'Brak logów. Uruchom serwer, żeby zobaczyć jego konsolę.').split('\n')) {
      const span = document.createElement('span');
      span.className = 'log-line';
      if (/\b(ERROR|SEVERE|Exception)\b/.test(line)) span.classList.add('error');
      else if (/\bWARN(?:ING)?\b/.test(line)) span.classList.add('warning');
      else if (/\bDone \(|Stopping server|Saved the game/.test(line)) span.classList.add('success');
      span.textContent = line || ' ';
      fragment.append(span);
    }
    const previousScroll = output.scrollTop;
    output.replaceChildren(fragment);
    output.scrollTop = $('follow').checked ? output.scrollHeight : previousScroll;
  }
  controls();
}

async function refresh(initial = false) {
  if (polling || (!initial && !authenticated) || (document.hidden && !initial)) return;
  polling = true;
  try {
    const data = await api('status');
    if (initial) showPanel();
    render(data);
    notice('Ostatnia aktualizacja: ' + new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date()));
  } catch (error) {
    if (initial && !$('login').hidden) return;
    if (initial) { showLogin(); $('login-error').textContent = error.message; }
    else if (authenticated) { notice(error.message, true); serverState = 'unknown'; controls(); }
  } finally { polling = false; }
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('login-submit').disabled = true;
  $('login-error').textContent = '';
  try {
    await api('login', { password: $('password').value });
    $('password').value = '';
    $('password').type = 'password';
    showPanel();
    await refresh();
  } catch (error) { $('login-error').textContent = error.message; }
  finally { $('login-submit').disabled = false; }
});

$('show-password').addEventListener('click', () => {
  const show = $('password').type === 'password';
  $('password').type = show ? 'text' : 'password';
  $('show-password').setAttribute('aria-label', show ? 'Ukryj hasło' : 'Pokaż hasło');
  $('show-password').setAttribute('aria-pressed', String(show));
});

$('logout').addEventListener('click', async () => {
  try { await api('logout'); showLogin(); lastLogs = null; $('output').textContent = ''; history = []; }
  catch (error) { notice(error.message, true); }
});

async function power(op) {
  busy = true;
  controls();
  notice(op === 'start' ? 'Uruchamianie serwera…' : 'Serwer zapisuje świat i kończy pracę…');
  try {
    await api(op);
    pendingUntil = Date.now() + 3500;
    serverState = op === 'start' ? 'activating' : 'deactivating';
    $('state').textContent = op === 'start' ? 'Uruchamianie…' : 'Zapisywanie i wyłączanie…';
    $('state-dot').className = 'state-dot ' + serverState;
    await refresh();
  } catch (error) { notice(error.message, true); }
  finally { busy = false; controls(); }
}
$('start').addEventListener('click', () => power('start'));
$('stop').addEventListener('click', () => power('stop'));

$('command-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const command = $('command').value.trim();
  if (!command || busy) return;
  busy = true;
  controls();
  try {
    await api('command', { command });
    history = [...history.slice(-49), command];
    historyIndex = history.length;
    $('command').value = '';
    notice('Komenda wysłana. Odpowiedź pojawi się w konsoli.');
    setTimeout(() => refresh(), 700);
  } catch (error) { notice(error.message, true); }
  finally { busy = false; controls(); $('command').focus(); }
});
$('command').addEventListener('keydown', (event) => {
  if (!['ArrowUp', 'ArrowDown'].includes(event.key) || !history.length) return;
  event.preventDefault();
  historyIndex = Math.max(0, Math.min(history.length, historyIndex + (event.key === 'ArrowUp' ? -1 : 1)));
  $('command').value = history[historyIndex] || '';
});
$('follow').addEventListener('change', () => { if ($('follow').checked) $('output').scrollTop = $('output').scrollHeight; });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(() => refresh(), 3000);
refresh(true);
