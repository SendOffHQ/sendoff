// The Instagram poster, against a stand-in for Instagram.
//
// Nothing here touches the network. What is checked is what would be sent:
// that every feature post has a caption Instagram will take and a JPEG
// beside it, that the flow is container, wait, publish in that order, that a
// post already up is refused rather than repeated, and that the token never
// appears in anything printed or thrown.
//
//   node test/instagram-post.mjs
import fs from 'node:fs';
import path from 'node:path';
import { preparePost, publish, verify } from '../tools/instagram-post.mjs';
import { parseCaptions, captionProblems } from '../brand/social/captions.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SOCIAL = path.join(ROOT, 'brand', 'social');
let bad = 0;
const ok = (l, g, w) => { const q = JSON.stringify(g) === JSON.stringify(w); if (!q) bad++;
  console.log(`  ${q ? 'ok  ' : 'FAIL'} ${l.padEnd(58)} ${JSON.stringify(g)}${q ? '' : ' want ' + JSON.stringify(w)}`); };

console.log('\nevery feature post is ready to go');
const ids = [...fs.readFileSync(path.join(SOCIAL, 'features.html'), 'utf8')
  .matchAll(/<section class="slide[^"]*" id="([^"]+)"/g)].map(m => m[1]);
ok('eighteen posts in features.html', ids.length, 18);
const notReady = [];
for (const id of ids) {
  try {
    const p = preparePost(id);
    const jpg = fs.readFileSync(path.join(SOCIAL, `sendoff-feature-${id}.jpg`));
    if (jpg[0] !== 0xFF || jpg[1] !== 0xD8) notReady.push(id + ': jpg is not a JPEG');
    if (!p.imageUrl.startsWith('https://sendoff.run/brand/social/')) notReady.push(id + ': image url');
  } catch (e) { notReady.push(id + ': ' + e.message); }
}
ok('each has a caption Instagram will take, and a real JPEG', notReady, []);

console.log('\nthe caption is the text under its heading, and nothing else');
const md = '# Title\n\nIntro.\n\n---\n\n## 1. A (`sendoff-feature-a.png`)\n\nHook line.\n\nBody.\n\n#one #two\n\n---\n\n## 2. B (`sendoff-feature-b.png`)\n\nOther.\n';
const caps = parseCaptions(md);
ok('first', caps['sendoff-feature-a.png'], 'Hook line.\n\nBody.\n\n#one #two');
ok('last, with no closing rule', caps['sendoff-feature-b.png'], 'Other.');
ok('too many hashtags is caught', captionProblems(Array.from({ length: 31 }, (_, i) => '#t' + i).join(' ')),
  ['31 hashtags, over 30']);
ok('an emoji counts as one character', captionProblems('📍'.repeat(2200)), []);
ok('a caption over 2,200 is caught', captionProblems('x'.repeat(2201)), ['2201 characters, over 2200']);
ok('an unknown post is refused', (() => { try { preparePost('nope'); return 'sent'; } catch (e) { return 'refused'; } })(), 'refused');
ok('a path is not a post id', (() => { try { preparePost('../../x'); return 'sent'; } catch (e) { return 'refused'; } })(), 'refused');

// A stand-in Instagram. Records every call, answers the way the real one does.
const TOKEN = 'IGTOKEN-secret-do-not-print';
function fakeInstagram({ image = 200, type = 'image/jpeg', recent = [], statuses = ['IN_PROGRESS', 'FINISHED'] } = {}) {
  const calls = [];
  const st = statuses.slice();
  const reply = (status, body) => ({ ok: status < 400, status,
    headers: new Map([['content-type', status < 400 ? type : 'text/html']]), json: async () => body });
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const params = opts.body ? Object.fromEntries(opts.body) : Object.fromEntries(u.searchParams);
    calls.push({ method: opts.method || 'GET', path: u.pathname.replace(/^\/v[\d.]+/, ''), params });
    if (opts.method === 'HEAD') return reply(image, null);
    if (params.access_token !== TOKEN) return reply(400, { error: { message: 'Invalid OAuth access token', code: 190 } });
    if (u.pathname.endsWith('/me')) return reply(200, { user_id: '17841400000000000', username: 'sendoff.run' });
    if (u.pathname.endsWith('/17841400000000000/media') && !opts.method) return reply(200, { data: recent });
    if (u.pathname.endsWith('/media') && opts.method === 'POST') return reply(200, { id: 'C1' });
    if (u.pathname.endsWith('/C1')) return reply(200, { status_code: st.shift() || 'FINISHED' });
    if (u.pathname.endsWith('/media_publish')) return reply(200, { id: 'M1' });
    if (u.pathname.endsWith('/M1')) return reply(200, { permalink: 'https://www.instagram.com/p/abc/' });
    return reply(404, { error: { message: 'unknown', code: 1 } });
  };
  return { calls, fetchImpl };
}
const post = preparePost('live-race');
const opts = (ig, extra = {}) => ({ userId: '17841400000000000', token: TOKEN, fetchImpl: ig.fetchImpl,
  wait: async () => {}, log: () => {}, ...extra });

console.log('\na post goes out');
{
  const ig = fakeInstagram();
  const out = await publish(post, opts(ig));
  ok('in order: check image, check recent, container, wait, publish, link',
    ig.calls.map(c => `${c.method} ${c.path.split('/').pop()}`),
    ['HEAD sendoff-feature-live-race.jpg', 'GET media', 'POST media', 'GET C1', 'GET C1', 'POST media_publish', 'GET M1']);
  const create = ig.calls.find(c => c.method === 'POST' && c.path.endsWith('/media'));
  ok('the container carries the public JPEG', create.params.image_url, 'https://sendoff.run/brand/social/sendoff-feature-live-race.jpg');
  ok('and the caption from captions.md, exactly', create.params.caption, post.caption);
  ok('publishes the container it made', ig.calls.find(c => c.path.endsWith('media_publish')).params.creation_id, 'C1');
  ok('and hands back the link', out.permalink, 'https://www.instagram.com/p/abc/');
}

console.log('\nwhat stops a post');
const refusal = async (ig, extra) => { try { await publish(post, opts(ig, extra)); return 'published'; }
  catch (e) { return { message: e.message,
    sent: ig.calls.some(c => c.method === 'POST'),
    published: ig.calls.some(c => c.path.endsWith('media_publish')) }; } };
{
  const r = await refusal(fakeInstagram({ recent: [{ caption: post.caption, permalink: 'https://www.instagram.com/p/old/', timestamp: '2026-09-30T12:00:00+0000' }] }));
  ok('already posted: refused, with the link, nothing sent', [/Already posted.*p\/old/.test(r.message), r.sent], [true, false]);
  const f = fakeInstagram({ recent: [{ caption: post.caption }] });
  await publish(post, opts(f, { force: true }));
  ok('--force posts it anyway', f.calls.some(c => c.path.endsWith('media_publish')), true);
}
{
  const r = await refusal(fakeInstagram({ image: 404 }));
  ok('image not live yet: refused before anything is created', [/answered 404/.test(r.message), r.sent], [true, false]);
  const r2 = await refusal(fakeInstagram({ type: 'image/png' }));
  ok('a PNG is refused, Instagram only takes JPEG', /public JPEG/.test(r2.message), true);
}
{
  const r = await refusal(fakeInstagram({ statuses: ['ERROR'] }));
  ok('an image Instagram cannot process is not published', [/could not process/.test(r.message),
    r.published], [true, false]);
}
{
  const ig = fakeInstagram();
  const r = await refusal(ig, { token: 'wrong-token' });
  ok('a bad token says so', /Invalid OAuth access token/.test(r.message), true);
}

console.log('\na dry run proves the setup without posting');
{
  const ig = fakeInstagram();
  ok('names the account the token is for', await verify(opts(ig)), { username: 'sendoff.run' });
  ok('and sends nothing', ig.calls.some(c => c.method === 'POST'), false);
  const other = await verify(opts(fakeInstagram(), { userId: '999' })).then(() => 'accepted', e => e.message);
  ok('a token for a different account is caught', /token is for @sendoff\.run.*IG_USER_ID is 999/.test(other), true);
}

console.log('\nthe workflow offers exactly these posts');
{
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'instagram-post.yml'), 'utf8');
  const opts = [...wf.slice(wf.indexOf('options:')).matchAll(/^\s+- ([a-z0-9-]+)\s*$/gm)].map(m => m[1]);
  ok('the same list, in the same order, as features.html', opts, ids);
  ok('inputs reach the shell through env, never pasted into it', /run:[^\n]*\$\{\{\s*(inputs|github\.event)/.test(wf), false);
  ok('a dry run is the default', /dry_run:[\s\S]*?default: true/.test(wf), true);
}

console.log('\nthe token is never repeated');
{
  const seen = [];
  const ig = fakeInstagram({ statuses: ['ERROR'] });
  let msg = '';
  try { await publish(post, opts(ig, { log: s => seen.push(String(s)) })); } catch (e) { msg = e.message; }
  const r = await refusal(fakeInstagram({ image: 500 }));
  ok('not in anything logged or thrown', [...seen, msg, r.message].some(s => s.includes(TOKEN)), false);
}

console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
