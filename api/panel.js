const { Client } = require('ssh2');
const { createHash } = require('node:crypto');

function bridge(payload) {
  return new Promise((resolve, reject) => {
    const connection = new Client();
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.end();
      if (error) reject(new Error('Bridge unavailable'));
      else resolve(result);
    };
    const timer = setTimeout(() => finish(true), 13000);
    connection.on('ready', () => {
      // The server ignores this string: authorized_keys forces the fixed bridge.
      connection.exec('minecraft-panel', (error, stream) => {
        if (error) return finish(true);
        let output = '';
        stream.on('data', (chunk) => {
          output += chunk.toString('utf8');
          if (output.length > 100000) finish(true);
        });
        stream.on('close', () => {
          try { finish(null, JSON.parse(output)); } catch { finish(true); }
        });
        stream.on('error', () => finish(true));
        stream.end(JSON.stringify(payload));
      });
    });
    connection.on('error', () => finish(true));
    const hostHash = process.env.MC_SSH_HOST_HASH;
    if (!hostHash || !/^[a-f0-9]{64}$/.test(hostHash)) return finish(true);
    connection.connect({
      host: process.env.MC_SSH_HOST,
      port: 22,
      username: 'ubuntu',
      privateKey: process.env.MC_SSH_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      hostHash: 'sha256',
      hostVerifier: (hash) => hash === hostHash,
      readyTimeout: 10000,
      algorithms: { serverHostKey: ['ssh-ed25519'] }
    });
  });
}

function cookie(req) {
  const value = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('__Host-mc_session='));
  return value ? value.slice('__Host-mc_session='.length) : '';
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const reply = (code, data) => res.status(code).json(data);
  if (req.method !== 'POST') return reply(405, { error: 'Niedozwolona metoda.' });
  // The custom header is never sent by cross-site forms; CORS is not enabled.
  if (req.headers['x-panel-request'] !== '1') return reply(403, { error: 'Niedozwolone żądanie.' });
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (origin && origin !== `https://${host}` && !(process.env.NODE_ENV !== 'production' && origin === `http://${host}`)) {
    return reply(403, { error: 'Niedozwolone źródło żądania.' });
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!body || JSON.stringify(body).length > 1500) return reply(400, { error: 'Nieprawidłowe żądanie.' });
    const op = body.op;
    if (!['login', 'logout', 'status', 'start', 'stop', 'command'].includes(op)) return reply(400, { error: 'Nieznana operacja.' });
    if (op === 'logout') {
      res.setHeader('Set-Cookie', '__Host-mc_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
      return reply(200, { ok: true });
    }
    const session = cookie(req);
    if (op !== 'login' && !session) return reply(401, { error: 'Zaloguj się do panelu.' });
    if (op === 'login' && (typeof body.password !== 'string' || body.password.length > 128)) return reply(400, { error: 'Nieprawidłowe hasło.' });
    if (op === 'command' && (typeof body.command !== 'string' || body.command.length > 300 || /[\x00-\x1f\x7f]/.test(body.command))) return reply(400, { error: 'Nieprawidłowa komenda.' });
    const client = createHash('sha256').update(String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0]).digest('hex');
    const result = await bridge({ op, session, password: op === 'login' ? body.password : undefined, command: op === 'command' ? body.command : undefined, client });
    if (result.error) return reply(result.code || 503, { error: result.error });
    if (op === 'login') {
      res.setHeader('Set-Cookie', `__Host-mc_session=${result.token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`);
      return reply(200, { ok: true });
    }
    return reply(200, result);
  } catch {
    return reply(503, { error: 'Brak połączenia z serwerem. Spróbuj ponownie za chwilę.' });
  }
};

module.exports.bridge = bridge;
