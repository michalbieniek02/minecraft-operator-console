const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const handler = require('../api/panel');

async function request(body, headers = {}, method = 'POST') {
  const req = { body, method, headers: { host: 'console.example', origin: 'https://console.example', 'x-panel-request': '1', ...headers } };
  const result = { status: 200, headers: {} };
  const res = { setHeader(k, v) { result.headers[k] = v; }, status(code) { result.status = code; return this; }, json(data) { result.body = data; return this; } };
  await handler(req, res);
  return result;
}
test('console, log and power operations require a session', async () => {
  for (const op of ['status', 'start', 'stop', 'command']) assert.equal((await request({ op })).status, 401);
});
test('rejects cross-site operations and simple HTML forms', async () => {
  assert.equal((await request({ op: 'login', password: 'test' }, { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await request({ op: 'login', password: 'test' }, { 'x-panel-request': undefined })).status, 403);
});
test('rejects methods, unsupported actions and malformed payloads', async () => {
  assert.equal((await request({}, {}, 'GET')).status, 405);
  assert.equal((await request({ op: 'shell', command: 'id' })).status, 400);
  assert.equal((await request({ op: 'login', password: {} })).status, 400);
  assert.equal((await request({ op: 'login', password: 'a'.repeat(2000) })).status, 400);
});
test('console commands cannot contain embedded control characters', async () => {
  const headers = { cookie: '__Host-mc_session=test' };
  assert.equal((await request({ op: 'command', command: 'list\nstop' }, headers)).status, 400);
  assert.equal((await request({ op: 'command', command: 'a'.repeat(301) }, headers)).status, 400);
});
test('logout expires a secure HttpOnly cookie', async () => {
  const result = await request({ op: 'logout' });
  assert.equal(result.status, 200);
  assert.match(result.headers['Set-Cookie'], /HttpOnly; Secure; SameSite=Strict; Max-Age=0/);
});
test('public assets contain no server address or secret environment fields', () => {
  const files = fs.readdirSync(path.join(__dirname, '../public'));
  for (const name of files) {
    const text = fs.readFileSync(path.join(__dirname, '../public', name), 'utf8');
    assert.doesNotMatch(text, /\b(?:\d{1,3}\.){3}\d{1,3}\b|vps\.ovh\.net|MC_SSH_|PRIVATE KEY/);
    assert.doesNotMatch(text, /innerHTML\s*=/);
  }
});
