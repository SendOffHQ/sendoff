// Serves the real site on localhost, with a stub standing in for the worker,
// so a real browser with a real service worker can be put into airplane mode.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PORT = 8787;
const ME = 'crew@example.com';
const SLUG = '000003-dry-run-sangre';

const TYPES = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
  '.json':'application/json', '.svg':'image/svg+xml', '.gpx':'application/gpx+xml',
  '.png':'image/png', '.webmanifest':'application/manifest+json', '.woff2':'font/woff2' };

const raceFile = (slug, file) => {
  const p = path.join(ROOT, 'races', slug, file);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (code, body, type) => {
    res.writeHead(code, { 'Content-Type': type || 'text/plain',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization,Content-Type',
      'Date': new Date().toUTCString() });
    res.end(body);
  };
  if (req.method === 'OPTIONS') return send(204, '');

  // hub.json points the site at the stub worker.
  if (url.pathname === '/hub.json') {
    return send(200, JSON.stringify({ auth: { proxyUrl: `http://localhost:${PORT}/api` } }),
                'application/json');
  }

  // --- the stub worker ---
  if (url.pathname === '/api/get') {
    const p = url.searchParams.get('path') || '';
    const m = p.match(/^races\/([^/]+)\/(.+)$/);
    if (!m) return send(400, '{}', 'application/json');
    let text = raceFile(m[1], m[2]);
    if (text == null) return send(404, '{"message":"Not Found"}', 'application/json');
    // What the real worker does: injects the caller's role, and the published
    // file names nobody.
    if (m[2] === 'config.json') {
      const cfg = JSON.parse(text);
      delete cfg.people; delete cfg.createdBy;
      cfg.myRole = 'crew';
      text = JSON.stringify(cfg, null, 2) + '\n';
    }
    return send(200, JSON.stringify({ sha: 'stub-sha', path: p,
      content: Buffer.from(text, 'utf8').toString('base64'), encoding: 'base64' }),
      'application/json');
  }
  if (url.pathname === '/api/my-races') {
    const cfg = JSON.parse(raceFile(SLUG, 'config.json') || '{}');
    return send(200, JSON.stringify({ races: [{ slug: SLUG, name: cfg.name,
      startTime: cfg.startTime, location: cfg.location, visibility: 'private',
      mine: true, myRole: 'crew' }] }), 'application/json');
  }
  // Drained before answering, the way the real endpoint does; a reply sent
  // before the body arrives can leave the socket half read.
  if (url.pathname === '/api/feedback') {
    req.on('data', () => {});
    return req.on('end', () => send(200, '{"ok":true}', 'application/json'));
  }
  if (url.pathname === '/api/feedback-list') {
    return send(200, JSON.stringify({ items: [
      { key: 'fb:1', message: 'The elevation on leg 4 reads 2,800 ft\nbut the GPX says 1,900.',
        email: 'watcher@example.com', account: null, page: '/race.html?id=r1', race: 'r1',
        version: 'v68', offline: true, queued: 2, agent: 'Mobile Safari',
        writtenAt: '2026-09-26T14:03:00Z', sentAt: '2026-09-26T17:41:00Z' },
      { key: 'fb:2', message: 'No address on this one.', email: null, account: null,
        page: '/index.html', version: 'v68', offline: false, queued: 0,
        writtenAt: '2026-09-27T09:00:00Z', sentAt: '2026-09-27T09:00:00Z' }
    ] }), 'application/json');
  }
  if (url.pathname.startsWith('/api/')) return send(200, '{}', 'application/json');

  // --- the site ---
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.join(ROOT, decodeURIComponent(file));
  if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    return send(404, 'not found');
  }
  send(200, fs.readFileSync(full), TYPES[path.extname(full)] || 'application/octet-stream');
});
export default server;
server.listen(PORT, () => console.log('ready on ' + PORT));
