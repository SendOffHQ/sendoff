// What a phone shows when the signal goes.
//
// The dry run found the failure this covers: a crew member with no signal
// opened the race page and got no map, no elevation, no logged splits, and no
// way through to the pit or racer pages at all. Three separate causes, one
// symptom, and the last of them is the one that matters: they could not log.
import fs from 'node:fs';
import vm from 'node:vm';

const SLUG = 'r1', ME = 'crew@example.com';

// Enough browser for race-core to load. Deliberately small: anything it needs
// that is not here shows up as a failure to load rather than as a silent no-op.
// A real Storage holds its entries as own enumerable properties, which is what
// makes Object.keys(localStorage) work; the eviction path depends on that, so
// the shim has to behave the same way. Methods go on the prototype so they do
// not show up as stored keys.
function makeStorage() {
  const proto = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(this, k) ? this[k] : null; },
    setItem(k, v) {
      if (this._failNextSet) { this._failNextSet = false; const e = new Error('quota');
        e.name = 'QuotaExceededError'; throw e; }
      Object.defineProperty(this, k, { value: String(v), enumerable: true, configurable: true, writable: true });
    },
    removeItem(k) { delete this[k]; },
    _failNextSet: false,
  };
  return Object.create(proto);
}

function makeWindow() {
  const el = () => ({ style: { setProperty(){}, removeProperty(){} }, classList: { add(){}, remove(){} },
    setAttribute(){}, appendChild(){}, remove(){}, addEventListener(){},
    getBoundingClientRect: () => ({ height: 0 }), textContent: '', innerHTML: '' });
  const win = {
    localStorage: makeStorage(),
    navigator: { onLine: true },
    location: { protocol: 'https:', hostname: 'sendoff.run', href: 'https://sendoff.run/race.html', search: '' },
    addEventListener(){}, setInterval(){}, setTimeout(){},
    document: {
      createElement: el, getElementById: () => null, querySelector: () => null,
      querySelectorAll: () => [], addEventListener(){}, head: el(), body: el(),
      documentElement: el(), readyState: 'complete',
    },
  };
  win.window = win;
  return win;
}

const src = fs.readFileSync(new URL('../lib/race-core.js', import.meta.url), 'utf8');
const win = makeWindow();
const ctx = vm.createContext(Object.assign(win, {
  console, Date, JSON, Math, Object, Array, String, Number, Boolean, Error, Promise,
  isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent, escape, unescape,
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
  atob: s => Buffer.from(s, 'base64').toString('binary'),
  TextEncoder, TextDecoder, URL, Set, Map, RegExp, Symbol,
}));
ctx.globalThis = ctx;
ctx.localStorage = win.localStorage;
ctx.navigator = win.navigator;
ctx.document = win.document;
ctx.location = win.location;
vm.runInContext(src, ctx);
const Race = ctx.window.Race;

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(56)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };

// The config the proxy hands a signed-in crew member: no roster, but it says
// what this caller is. The published copy on Pages names nobody at all.
const WORKER_CONFIG = JSON.stringify({ name: 'A race', myRole: 'crew',
  runners: [{ id: 'jason', name: 'Jason' }] });
const PAGES_CONFIG = JSON.stringify({ name: 'A race', runners: [{ id: 'jason', name: 'Jason' }] });
const GPX = '<gpx><trk><trkseg><trkpt lat="1" lon="1"><ele>10</ele></trkpt></trkseg></trk></gpx>';

let online = true, served = [];
let dataBody = '{"lastUpdated":"2026-09-26T20:01:00Z","runners":[]}';
// Paths the service worker can answer from its own copy, even with no signal.
const swCache = new Map();
ctx.fetch = async (url) => {
  if (!online) throw new TypeError('Failed to fetch');
  served.push(String(url));
  const u = String(url);
  if (u.startsWith('hub.json')) {
    return { ok: true, status: 200, headers: { get: () => null },
             json: async () => ({ auth: { proxyUrl: 'https://w' } }),
             text: async () => '{"auth":{"proxyUrl":"https://w"}}' };
  }
  if (u.includes('/get?path=')) {
    const path = decodeURIComponent(u.split('path=')[1]);
    const body = path.endsWith('config.json') ? WORKER_CONFIG
               : path.endsWith('data.json')   ? dataBody
               : GPX;
    return { ok: true, status: 200, headers: { get: () => null },
             json: async () => ({ sha: 's', content: Buffer.from(body,'utf8').toString('base64') }),
             text: async () => body };
  }
  if (swCache.has(u.split('?')[0])) {
    const { body, date } = swCache.get(u.split('?')[0]);
    // What the service worker hands back: the published file, stamped with
    // when the origin served it and marked as having come from storage.
    return { ok: true, status: 200,
             headers: { get: h => (h === 'X-SendOff-Cache' ? 'hit' : h === 'date' ? date : null) },
             json: async () => JSON.parse(body), text: async () => body };
  }
  return { ok: false, status: 404, headers: { get: () => null }, text: async () => 'nope' };
};
// Signed in, proxy mode, so reads prefer the worker the way the real app does.
ctx.localStorage.setItem('race-hub-session-v1', JSON.stringify({
  session: 'tok', proxyUrl: 'https://w', email: ME, expiresAt: Date.now() + 3600e3 }));
// One online page load, which is what tells this device the site puts writes
// through the proxy.
await Race.hub.load();

console.log('\nonline, a read is written down');
const cfg1 = await Race.gh.readRaceJson(SLUG, 'config.json', true);
ok('it came from the proxy', cfg1.myRole, 'crew');
const gpx1 = await Race.gh.readRaceText(SLUG, 'course.gpx', true);
ok('and so did the course', typeof gpx1 === 'string' && gpx1.includes('trkpt'), true);
ok('both are saved on the device',
   [!!ctx.localStorage.getItem(`so:seen:${SLUG}:config.json`),
    !!ctx.localStorage.getItem(`so:seen:${SLUG}:course.gpx`)], [true, true]);

console.log('\nsignal gone: the race is still there');
online = false; ctx.navigator.onLine = false;
const cfg2 = await Race.gh.readRaceJson(SLUG, 'config.json', true);
ok('the config reads back', cfg2.name, 'A race');
ok('the course reads back',
   (await Race.gh.readRaceText(SLUG, 'course.gpx', true) || '').includes('trkpt'), true);
ok('the page knows it is showing saved data', Race.offline.stale, true);

console.log('\nan old published copy does not beat a newer one off the proxy');
// The dry run hit this. Offline, the fetch of the published file still
// "succeeds", because the service worker answers it from storage, and that copy
// can be far older than what the proxy last gave this device. Taken as truth it
// showed an empty leg list; written down as well it replaced the real splits.
online = true; ctx.navigator.onLine = true;
dataBody = '{"lastUpdated":"2026-09-26T20:30:00Z","runners":[{"id":"jason","legs":[{"index":1},{"index":2}]}]}';
await Race.gh.readRaceJson(SLUG, 'data.json', true);   // the proxy's copy, now
online = false; ctx.navigator.onLine = false;
swCache.set('races/r1/data.json', {
  body: '{"lastUpdated":"2026-09-26T09:00:00Z","runners":[]}',
  date: new Date(Date.now() - 6 * 3600e3).toUTCString() });
const offlineData = await Race.gh.readRaceJson(SLUG, 'data.json', true);
ok('the splits are still there', (offlineData.runners[0] || {}).legs.length, 2);
ok('and the old copy did not overwrite them',
   JSON.parse(ctx.localStorage.getItem(`so:seen:${SLUG}:data.json`)).text.includes('20:30'), true);
swCache.clear();

console.log('\na newer copy that names nobody does not win');
// The subtle one. Visiting the hub makes the service worker cache the
// published config, which is then newer than the proxy copy saved when the
// race page was last opened. Recency alone picked the newer file, and a newer
// file that names nobody still cannot say who you are.
ok('the proxy copy beats a newer published one',
   Race.lastSeen.better({ source: 'proxy',     at: '2026-09-26T10:00:00Z' },
                        { source: 'published', at: '2026-09-26T18:00:00Z' }), true);
ok('and within one source the newer wins',
   Race.lastSeen.better({ source: 'proxy', at: '2026-09-26T18:00:00Z' },
                        { source: 'proxy', at: '2026-09-26T10:00:00Z' }), true);
ok('a published copy never displaces a proxy one',
   Race.lastSeen.better({ source: 'published', at: '2026-09-26T18:00:00Z' },
                        { source: 'proxy',     at: '2026-09-26T10:00:00Z' }), false);

console.log('\nand it still knows who you are');
// The failure from the dry run. The published config names nobody, so a
// fallback to it makes a crew member a stranger to their own race and the pit
// and racer pages disappear from the menu.
ok('the saved copy kept the role', cfg2.myRole, 'crew');
ok('so the crew member can still edit', Race.roles.canEdit(cfg2, ME), true);
ok('which is what the published copy could not tell them',
   Race.roles.canEdit(JSON.parse(PAGES_CONFIG), ME), false);

console.log('\nlosing signal does not turn the site into a different site');
// hub.json says whether writes go through the proxy. Treating an unreachable
// one as "no proxy" put the page into PAT mode, where "may this person edit" is
// answered by whether the device holds a token, which offline is always no. The
// crew member lost the pit and racer links at the moment they needed them.
ok('proxy mode is remembered', Race.hub.isProxyMode(), true);
Race.hub._data = null; Race.hub._promise = null;   // a fresh page load, still offline
await Race.hub.load();
ok('still proxy mode after a reload with no signal', Race.hub.isProxyMode(), true);
ok('so the page still knows the account', Race.auth.email(), ME);
// The exact chain race.html uses to decide whether to draw the pit and racer links.
ok('and the pit and racer links are offered',
   Race.hub.isProxyMode() && Race.auth.has() && Race.roles.canEdit(cfg2, Race.auth.email()), true);

console.log('\na race never opened on this phone is still not invented');
let threw = null;
try { await Race.gh.readRaceJson('never-seen', 'config.json', true); } catch (e) { threw = e.message; }
ok('it says so rather than showing nothing', /not found/.test(threw || ''), true);
ok('and a missing course is just a missing course',
   await Race.gh.readRaceText(SLUG, 'nope.gpx', true), null);

console.log('\ncoming back online overwrites what was saved');
online = true; ctx.navigator.onLine = true;
served = [];
await Race.gh.readRaceJson(SLUG, 'data.json', true);
ok('the proxy is asked again', served.some(u => u.includes('data.json')), true);
ok('and the saved copy moved on',
   JSON.parse(ctx.localStorage.getItem(`so:seen:${SLUG}:data.json`)).text.includes('lastUpdated'), true);

console.log('\npolling the same file does not rewrite it every ten seconds');
// localStorage writes are synchronous and hit disk. The race page re-reads
// data.json every ten seconds and usually gets the same bytes, so an unchanged
// file must not be written again.
const proto = Object.getPrototypeOf(ctx.localStorage);
const realSetItem = proto.setItem;
let writes = 0;
proto.setItem = function (k, v) { if (k.startsWith('so:seen:')) writes++; return realSetItem.call(this, k, v); };
await Race.gh.readRaceJson(SLUG, 'data.json', true);
await Race.gh.readRaceJson(SLUG, 'data.json', true);
await Race.gh.readRaceJson(SLUG, 'data.json', true);
ok('three identical polls, no writes', writes, 0);
proto.setItem = realSetItem;

console.log('\nwhen the phone runs out of room, the race being watched wins');
// A course GPX is half a megabyte, so a few races fill the quota on their own.
// The one on screen is the one worth keeping.
await Race.gh.readRaceJson('other-race', 'config.json', true);
ok('another race is saved too', !!ctx.localStorage.getItem('so:seen:other-race:config.json'), true);
// A split lands, so there is something new to write and the quota is hit
// trying to write it.
dataBody = '{"lastUpdated":"2026-09-26T20:14:00Z","runners":[{"id":"jason","legs":[{"index":1}]}]}';
Object.getPrototypeOf(ctx.localStorage)._failNextSet = true;
await Race.gh.readRaceJson(SLUG, 'data.json', true);
ok('the new split is kept',
   (JSON.parse(ctx.localStorage.getItem(`so:seen:${SLUG}:data.json`)).text || '').includes('20:14'), true);
ok('and the others made room for it',
   !!ctx.localStorage.getItem('so:seen:other-race:config.json'), false);
ok('the session survived the clear-out', !!ctx.localStorage.getItem('race-hub-session-v1'), true);

console.log('\nsigning out takes the race data with it');
ok('there is something to clear', Object.keys(ctx.localStorage).some(k => k.startsWith('so:seen:')), true);
Race.auth.clearSession();
ok('and nothing is left', Object.keys(ctx.localStorage).filter(k => k.startsWith('so:seen:')), []);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
