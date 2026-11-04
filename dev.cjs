const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const handler = require('./api/panel');
const envPath = path.resolve(__dirname, '../../work/panel-runtime.json');
if (fs.existsSync(envPath)) Object.assign(process.env, JSON.parse(fs.readFileSync(envPath)));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
http.createServer(async (req, res) => {
  if (req.url === '/api/panel') {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 8192) { res.writeHead(413).end(); return; } }
    try { req.body = JSON.parse(body || '{}'); } catch { res.writeHead(400).end(); return; }
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (data) => res.end(JSON.stringify(data));
    return handler(req, res);
  }
  const file = req.url === '/' ? 'index.html' : req.url.slice(1);
  if (!/^[a-z0-9.-]+$/.test(file)) { res.writeHead(404).end(); return; }
  try { res.setHeader('Content-Type', types[path.extname(file)] || 'text/plain'); res.end(fs.readFileSync(path.join(__dirname, 'public', file))); }
  catch { res.writeHead(404).end(); }
}).listen(3210, '127.0.0.1', () => console.log('Panel preview: http://127.0.0.1:3210'));
