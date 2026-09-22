// Serves the real site on localhost, with a stub standing in for the worker,
// so a real browser with a real service worker can be put into airplane mode.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PORT = 8787;
const ME = 'crew@example.com';
// The fixture the browser tests use, not a race anybody might delete. This
// named a real unlisted race until that race was tidied away.
const SLUG = 'zz-fixture-unlisted';

const TYPES = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
  '.json':'application/json', '.svg':'image/svg+xml', '.gpx':'application/gpx+xml',
  '.png':'image/png', '.webmanifest':'application/manifest+json', '.woff2':'font/woff2' };

// Races from the repository, then the fixtures beside this file.
//
// The browser tests used to name a real unlisted race out of races/, because
// they need one and the repository had one. Deleting that race broke them, and
// the failure looked like a bug in the app: no crew pages, no role, and a hang.
// A test that a person can break by tidying up is not testing what it says.
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'races');

// Whatever this run has written, by path, newest wins. Held in memory and gone
// when the harness restarts, which every test does, so no test can leave a
// fixture edited for the next one. It exists so a save can round-trip: a page
// that saves and then reloads to confirm needs the reload to see what it just
// wrote, and without this every save test would be testing the request and not
// the outcome.
const WRITTEN = new Map();

const fileAt = (p) => {
  if (WRITTEN.has(p)) return WRITTEN.get(p);
  for (const base of [ROOT, path.join(ROOT, 'test', 'fixtures')]) {
    const full = path.join(base, p);
    if (fs.existsSync(full)) return fs.readFileSync(full, 'utf8');
  }
  return null;
};
const raceFile = (slug, file) => fileAt(path.posix.join('races', slug, file));

// Photos uploaded during a run. Reset by restarting the harness, which every
// test does.
const MEDIA = [];

// Whether an invite comes back with a rendered message beside the link. An
// older worker does not send one, and the page has to cope by not offering a
// button that could only fail, which is a thing worth being able to ask for.
let noMail = false;

// Whether the roster names somebody else as the creator, for the check that
// the creator-only sections stay hidden. And whether a visibility save is
// refused, for the check that the page says so.
let notCreator = false;
let visibilityFails = false;
// Not on the race at all, which is what a site admin is for a race somebody
// else made: the config comes back with no role and the roster is refused.
let notOnRace = false;

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
  // A write. Held in memory, so the read that follows it sees it.
  if (url.pathname === '/api/commit') {
    let body = '';
    req.on('data', c => { body += c; });
    return req.on('end', () => {
      if (!req.headers.authorization) return send(401, '{"error":"Unauthorized"}', 'application/json');
      let j;
      try { j = JSON.parse(body); } catch (e) { return send(400, '{"error":"Invalid JSON"}', 'application/json'); }
      if (!j || !j.path || typeof j.content !== 'string') {
        return send(400, '{"error":"Missing path or content"}', 'application/json');
      }
      WRITTEN.set(j.path, j.content);
      send(200, JSON.stringify({ content: { path: j.path, sha: 'stub-sha-' + WRITTEN.size } }),
           'application/json');
    });
  }
  if (url.pathname === '/api/get') {
    const p = url.searchParams.get('path') || '';
    // The hub manifest is not inside a race, and a save that touches it
    // (aid stations move a race's total distance) has to be able to read it
    // first or the save fails on its second write.
    if (p === 'races/index.json') {
      if (!req.headers.authorization) return send(401, '{"error":"Unauthorized"}', 'application/json');
      const text = fileAt(p) || '{"races":[]}\n';
      return send(200, JSON.stringify({ sha: 'stub-sha', path: p,
        content: Buffer.from(text, 'utf8').toString('base64'), encoding: 'base64' }),
        'application/json');
    }
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
      // The role the real worker works out from createdBy and the roster, not
      // a fixed one. It used to be 'crew' for everybody, which made the
      // fixture's own creator a crew member on their own race and hid every
      // creator-only section on the settings page from the tests.
      const mine = String(cfg.createdBy || '').toLowerCase() === ME && !notCreator;
      delete cfg.people; delete cfg.createdBy;
      cfg.myRole = (signedIn && !notOnRace) ? (mine ? 'owner' : 'crew') : null;
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
  // Photos. Enough of R2 and the media table to exercise the client: an
  // in-memory list per race, and the bytes handed back on a data: URL so a
  // browser really renders what was uploaded. The point under test on this
  // side is what leaves the phone, which is the resize and the stripping.
  if (url.pathname === '/api/media' && req.method === 'POST') {
    if (!req.headers.authorization) return send(401, '{"error":"Unauthorized"}', 'application/json');
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const slug = url.searchParams.get('id');
      const row = {
        id: 'm' + (MEDIA.length + 1),
        legIndex: parseInt(url.searchParams.get('leg'), 10),
        runnerId: url.searchParams.get('runner') || null,
        caption: url.searchParams.get('caption') || '',
        width: parseInt(url.searchParams.get('w'), 10) || null,
        height: parseInt(url.searchParams.get('h'), 10) || null,
        bytes: body.length,
        contentType: req.headers['content-type'] || '',
        slug,
        createdAt: new Date().toISOString(),
        url: 'data:' + (req.headers['content-type'] || 'image/jpeg') + ';base64,' + body.toString('base64')
      };
      MEDIA.push(row);
      send(200, JSON.stringify({ media: row }), 'application/json');
    });
    return;
  }
  if (url.pathname === '/api/media' && req.method === 'GET') {
    const slug = url.searchParams.get('id');
    return send(200, JSON.stringify({
      media: MEDIA.filter(m => m.slug === slug), configured: true
    }), 'application/json');
  }
  if (url.pathname === '/api/media/delete') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let id = null;
      try { id = JSON.parse(Buffer.concat(chunks).toString('utf8')).id; } catch (e) {}
      const at = MEDIA.findIndex(m => m.id === id);
      if (at >= 0) MEDIA.splice(at, 1);
      send(200, '{"ok":true}', 'application/json');
    });
    return;
  }

  // An account invite, with the rendered message beside the link. The message
  // is deliberately not a copy of the worker's template: reproducing that here
  // would be the second copy of a mail the design exists to have only one of,
  // and what the browser test is asking is whether the page carries whatever
  // it was handed. /api/account-invite-nomail is how it asks what an older
  // worker, which returns the link alone, looks like.
  if (url.pathname === '/api/account-invite-nomail') { noMail = true; return send(200, '{"ok":true}'); }
  if (url.pathname === '/api/account-invite' || url.pathname === '/api/reset-link') {
    const isReset = url.pathname === '/api/reset-link';
    let body = '';
    req.on('data', c => { body += c; });
    return req.on('end', () => {
      if (!req.headers.authorization) return send(401, '{"error":"Unauthorized"}', 'application/json');
      let j = {}; try { j = JSON.parse(body); } catch (e) {}
      const link = isReset ? 'http://localhost:8787/reset.html?reset=stub-reset'
                           : 'http://localhost:8787/signup.html?account=stub-account';
      const out = { token: isReset ? 'stub-reset' : 'stub-account', url: link, email: j.email,
                    expiresAt: Date.now() + 14 * 24 * 3600e3, emailed: false, emailError: null };
      if (!noMail) {
        out.mail = {
          subject: isReset ? 'Reset your SendOff password' : 'Your SendOff invite',
          html: '<html><body><h1>' + (isReset ? 'Set a new password' : 'You are in.') + '</h1>' +
                '<img src="/brand/wordmark-email.png" alt="SendOff">' +
                '<a href="' + link + '">' +
                (isReset ? 'Choose a new password' : 'Set up your account') + '</a></body></html>',
          text: (isReset ? 'Set a new password. ' : 'You are in. ') + link
        };
      }
      send(200, JSON.stringify(out), 'application/json');
    });
  }

  // Enough accounts to have something to search and filter, with the shape the
  // real endpoint returns: a name off the profile, blank for anybody who has
  // not filled one in, and the role and plan the filters work on.
  if (url.pathname === '/api/accounts') {
    if (!req.headers.authorization) return send(401, '{"error":"Unauthorized"}', 'application/json');
    const mk = (email, name, role, plan, earlyAccess) => ({
      email, name, role, plan, earlyAccess, source: 'kv', inEnv: false, removable: true
    });
    return send(200, JSON.stringify({
      accounts: [
        mk('admin@example.com', 'Ada Lovelace', 'admin', 'pro', true),
        mk('crew@example.com', 'Casey Kim', 'crew', 'pro', true),
        mk('jason@example.com', 'Jason Dupree', 'crew', 'free', true),
        mk('nameless@example.com', '', 'crew', 'free', false)
      ],
      pendingInvites: [{ token: 'stub-pending', email: 'waiting@example.com',
                         expiresAt: Date.now() + 14 * 24 * 3600e3 }]
    }), 'application/json');
  }

  // The roster, which is also how a page learns who made the race: the config
  // in a public repository no longer names anybody. Manage access and the two
  // creator-only sections beside it all hang off this answer.
  if (url.pathname === '/api/access') {
    if (!req.headers.authorization) return send(401, '{"error":"Unauthorized"}', 'application/json');
    const slug = url.searchParams.get('slug') || '';
    if (!slug) return send(400, '{"error":"Missing slug"}', 'application/json');
    // The real worker refuses the roster to anybody who cannot write the race,
    // site admin or not: it is a list of addresses.
    if (notOnRace) return send(403, '{"error":"Not allowed"}', 'application/json');
    return send(200, JSON.stringify({
      slug,
      createdBy: notCreator ? 'someone.else@example.com' : ME,
      createdByName: notCreator ? 'Someone Else' : 'Casey Kim',
      teamCanInvite: false,
      canManageAccess: true,
      people: [{ email: ME, role: 'owner', displayName: 'Casey Kim' }],
      editors: [], viewers: [], shareLinks: [], pendingInvites: []
    }), 'application/json');
  }
  // What the page asks for when somebody who is not the creator opens it, so
  // a test can check that the creator-only sections are not there.
  if (url.pathname === '/api/not-creator') { notCreator = true; return send(200, '{"ok":true}'); }
  if (url.pathname === '/api/not-on-race') { notCreator = true; notOnRace = true; return send(200, '{"ok":true}'); }

  // Moving a race on or off the hub. Held in memory like a commit, so the
  // config read that follows a save sees what the save did.
  if (url.pathname === '/api/race/visibility') {
    let body = '';
    req.on('data', c => { body += c; });
    return req.on('end', () => {
      if (!req.headers.authorization) return send(401, '{"error":"Unauthorized"}', 'application/json');
      let j; try { j = JSON.parse(body); } catch (e) { return send(400, '{"error":"Invalid JSON"}', 'application/json'); }
      const want = j && j.visibility;
      if (want !== 'public' && want !== 'private') {
        return send(400, '{"error":"visibility must be \\"public\\" or \\"private\\""}', 'application/json');
      }
      if (visibilityFails) return send(403, '{"error":"Only the race creator can change who can see it"}', 'application/json');
      const path = `races/${j.slug}/config.json`;
      const text = fileAt(path);
      if (text) {
        const cfg = JSON.parse(text);
        const changed = cfg.visibility !== want;
        cfg.visibility = want;
        WRITTEN.set(path, JSON.stringify(cfg, null, 2) + '\n');
        return send(200, JSON.stringify({ slug: j.slug, visibility: want, changed,
          manifestErr: null, courseErr: null, shareErr: null }), 'application/json');
      }
      send(404, '{"error":"Race not found"}', 'application/json');
    });
  }
  // Makes the next visibility save fail, for the half-done path.
  if (url.pathname === '/api/visibility-fails') { visibilityFails = true; return send(200, '{"ok":true}'); }

  if (url.pathname.startsWith('/api/')) return send(200, '{}', 'application/json');

  // --- the site ---
  // Cloudflare Pages redirects a .html address to its extensionless form, and
  // serves the extensionless one. Modelled here because not modelling it hid a
  // real bug: every URL in the service worker's precache list ends in .html,
  // nothing in production lands on one, and a navigation that missed the cache
  // fell through to the app shell. The harness served both forms happily, so
  // every test passed while the live site sent people to the marketing page.
  //
  // A harness that is easier to satisfy than the host is not a test.
  if (/\.html$/.test(url.pathname)) {
    res.writeHead(308, { Location: url.pathname.replace(/\.html$/, '') + (url.search || '') });
    return res.end();
  }
  let full = path.join(ROOT, decodeURIComponent(url.pathname));
  // A fixture race is served at the same address a real one would be, so the
  // published-file path the app falls back to works for it as well.
  const fx = /^\/races\/([^/]+)\/(.+)$/.exec(decodeURIComponent(url.pathname));
  if (fx && !fs.existsSync(full)) {
    const alt = path.join(FIXTURES, fx[1], fx[2]);
    if (fs.existsSync(alt)) full = alt;
  }
  if (!fs.existsSync(full) && fs.existsSync(full + '.html')) full += '.html';
  if (full.startsWith(ROOT) && fs.existsSync(full) && fs.statSync(full).isDirectory()) {
    // A file beside a directory of the same name wins. This repo has both
    // admin.html and admin/ (which holds the password hasher), and the harness
    // answered /admin with its 404 page while the live host serves admin.html,
    // so nothing on the admin page could be opened in a browser test at all.
    // Checked against sendoff.run rather than assumed: /admin.html 308s to
    // /admin there, and /admin returns the admin page.
    if (fs.existsSync(full + '.html')) full += '.html';
    else full = path.join(full, 'index.html');
  }
  if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    // What the host does, rather than a bare string. Cloudflare Pages answers
    // any path it does not have with the project's 404.html, and that page is
    // not only a message: it forwards /races/<slug>/ into the app for races
    // whose own page has not been built yet. A harness that answers 'not
    // found' cannot see whether that works.
    const page = path.join(ROOT, '404.html');
    if (fs.existsSync(page)) return send(404, fs.readFileSync(page), 'text/html; charset=utf-8');
    return send(404, 'not found');
  }
  send(200, fs.readFileSync(full), TYPES[path.extname(full)] || 'application/octet-stream');
});
export default server;
server.listen(PORT, () => console.log('ready on ' + PORT));
