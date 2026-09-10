// Serves the real site on localhost, with a stub standing in for the worker,
// so a real browser with a real service worker can be put into airplane mode.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

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
    // Who is asking. A session, or a share token that names this race, or
    // nobody, which the real worker answers with a 401. A stub token is
    // "stub-<slug>", so a token for the wrong race fails the way a real one
    // would.
    const signedIn = !!req.headers.authorization;
    const tok = url.searchParams.get('t');
    const tokenOk = tok === 'stub-' + m[1];
    if (!signedIn && !tokenOk) return send(401, '{"error":"Unauthorized"}', 'application/json');
    let text = raceFile(m[1], m[2]);
    if (text == null) return send(404, '{"message":"Not Found"}', 'application/json');
    // What the real worker does: injects the caller's role, and the published
    // file names nobody. A token holder is nobody: it grants reading, not a
    // role.
    if (m[2] === 'config.json') {
      const cfg = JSON.parse(text);
      delete cfg.people; delete cfg.createdBy;
      cfg.myRole = signedIn ? 'crew' : null;
      // The dry run predates the activity field; give it one here so the
      // browser check can see the label render.
      if (!cfg.activity) cfg.activity = 'trail-run';
      text = JSON.stringify(cfg, null, 2) + '\n';
    }
    return send(200, JSON.stringify({ sha: 'stub-sha', path: p,
      content: Buffer.from(text, 'utf8').toString('base64'), encoding: 'base64' }),
      'application/json');
  }
  // The published copy. Public races only, no session read at all, and an
  // ETag so a poll that finds nothing new is a 304. Mirrors the real worker's
  // /public closely enough that the client cannot tell the difference.
  if (url.pathname === '/api/public') {
    const p = url.searchParams.get('path') || '';
    const m = p.match(/^races\/([^/]+)\/([^/]+)$/);
    if (!m) return send(404, '{"error":"Not found"}', 'application/json');
    const cfgText = raceFile(m[1], 'config.json');
    let visibility = null;
    try { visibility = JSON.parse(cfgText || 'null').visibility; } catch (e) {}
    // Not public is answered exactly as not found, same as the worker.
    if (visibility !== 'public') return send(404, '{"error":"Not found"}', 'application/json');
    let text = raceFile(m[1], m[2]);
    if (text == null) return send(404, '{"error":"Not found"}', 'application/json');
    if (m[2] === 'config.json') {
      const cfg = JSON.parse(text);
      delete cfg.people; delete cfg.createdBy;
      cfg.myRole = null;
      if (!cfg.activity) cfg.activity = 'trail-run';
      text = JSON.stringify(cfg, null, 2) + '\n';
    }
    const etag = 'W/"pub-' + createHash('sha1').update(text).digest('hex').slice(0, 12) + '"';
    if ((req.headers['if-none-match'] || '').split(',').some(v => v.trim() === etag)) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'public, max-age=3',
        'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'ETag' });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag,
      'Cache-Control': 'public, max-age=3', 'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'ETag' });
    return res.end(JSON.stringify({ sha: 'stub-sha', path: p,
      content: Buffer.from(text, 'utf8').toString('base64'), encoding: 'base64' }));
  }
  if (url.pathname === '/api/my-races') {
    const cfg = JSON.parse(raceFile(SLUG, 'config.json') || '{}');
    return send(200, JSON.stringify({ races: [{ slug: SLUG, name: cfg.name,
      startTime: cfg.startTime, location: cfg.location, visibility: 'private',
      activity: 'trail-run', mine: true, myRole: 'crew' }] }), 'application/json');
  }
  // Drained before answering, the way the real endpoint does; a reply sent
  // before the body arrives can leave the socket half read.
  if (url.pathname === '/api/feedback') {
    req.on('data', () => {});
    return req.on('end', () => send(200, '{"ok":true}', 'application/json'));
  }
  if (url.pathname === '/api/feedback-count') {
    const since = url.searchParams.get('since') || '';
    const stamps = ['2026-09-26T17:41:00Z', '2026-09-27T09:00:00Z'];
    return send(200, JSON.stringify({ total: stamps.length,
      new: stamps.filter(x => !since || x > since).length,
      newest: stamps[stamps.length - 1] }), 'application/json');
  }
  if (url.pathname === '/api/feedback-list') {
    // Newest first, the way the real endpoint sorts.
    return send(200, JSON.stringify({ items: [
      { key: 'fb:2', message: 'No address on this one.', email: null, account: null,
        page: '/index.html', version: 'v68', offline: false, queued: 0,
        writtenAt: '2026-09-27T09:00:00Z', sentAt: '2026-09-27T09:00:00Z' },
      { key: 'fb:1', message: 'The elevation on leg 4 reads 2,800 ft\nbut the GPX says 1,900.',
        email: 'watcher@example.com', account: null, page: '/race.html?id=r1', race: 'r1',
        version: 'v68', offline: true, queued: 2, agent: 'Mobile Safari',
        writtenAt: '2026-09-26T14:03:00Z', sentAt: '2026-09-26T17:41:00Z' }
    ] }), 'application/json');
  }
  if (url.pathname.startsWith('/api/')) return send(200, '{}', 'application/json');

  // --- the site ---
  // Pages serves a directory as its index.html. The hub lives at /app/ now, so
  // resolving directories here is what keeps this harness the same shape as
  // production rather than a simpler one that happens to pass.
  let full = path.join(ROOT, decodeURIComponent(url.pathname));
  if (full.startsWith(ROOT) && fs.existsSync(full) && fs.statSync(full).isDirectory()) {
    full = path.join(full, 'index.html');
  }
  if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    return send(404, 'not found');
  }
  send(200, fs.readFileSync(full), TYPES[path.extname(full)] || 'application/octet-stream');
});
export default server;
server.listen(PORT, () => console.log('ready on ' + PORT));
