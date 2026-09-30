// The Cloudflare Pages pruner, against a stand-in for Cloudflare's API.
//
// What matters: the live deployment is never touched, nor anything newer; every
// page of the list is read; a dry run deletes nothing; and nothing it prints
// reaches a deployment, because the log is public and a deployment's id is its
// address.
//
//   node test/cf-pages-prune.mjs
import { prune, planPrune } from '../tools/cf-pages-prune.mjs';

let bad = 0;
const ok = (l, g, w) => { const q = JSON.stringify(g) === JSON.stringify(w); if (!q) bad++;
  console.log(`  ${q ? 'ok  ' : 'FAIL'} ${l.padEnd(56)} ${JSON.stringify(g)}${q ? '' : ' want ' + JSON.stringify(w)}`); };

// 60 deployments, one a day from 1 August, the 55th live, five newer ones after.
const deps = Array.from({ length: 60 }, (_, i) => ({
  id: `a1b2c3d4-0000-0000-0000-${String(i).padStart(12, '0')}`,
  short_id: `s${String(i).padStart(7, '0')}`,
  url: `https://s${String(i).padStart(7, '0')}.sendoff-abi.pages.dev`,
  environment: 'production',
  created_on: new Date(Date.UTC(2026, 7, 1 + i)).toISOString(),
  deployment_trigger: { metadata: { commit_hash: 'c' + String(i).padStart(39, '0'), branch: 'main' } }
})).reverse();                       // newest first, as Cloudflare lists them
const LIVE = deps.find(d => d.id.endsWith('000000000054')).id;

function fakeCloudflare({ failIds = [] } = {}) {
  const calls = [];
  const forced = [];
  const remaining = new Map(deps.map(d => [d.id, d]));
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push(`${opts.method || 'GET'} ${u.pathname.split('/').slice(-2).join('/')}`);
    if ((opts.headers || {}).Authorization !== 'Bearer tok') return reply(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] });
    const del = u.pathname.match(/\/deployments\/([^/]+)$/);
    if (opts.method === 'DELETE' && del) {
      forced.push(u.searchParams.get('force') === 'true');
      if (del[1] === LIVE) return reply(400, { success: false, errors: [{ code: 8000034, message: 'Cannot delete the active production deployment' }] });
      if (failIds.includes(del[1])) return reply(500, { success: false, errors: [{ code: 1, message: 'boom' }] });
      remaining.delete(del[1]);
      return reply(200, { success: true, result: {} });
    }
    if (u.pathname.endsWith('/deployments')) {
      const page = +u.searchParams.get('page'), per = +u.searchParams.get('per_page');
      const list = [...remaining.values()];
      return reply(200, { success: true, result: list.slice((page - 1) * per, page * per),
        result_info: { page, per_page: per, total_count: list.length, total_pages: Math.ceil(list.length / per) } });
    }
    if (u.pathname.endsWith('/projects/sendoff')) return reply(200, { success: true, result: { canonical_deployment: { id: LIVE } } });
    return reply(404, { success: false, errors: [{ code: 1, message: 'unknown' }] });
  };
  return { calls, forced, remaining, fetchImpl };
}
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
const run = (cfk, extra = {}) => {
  const lines = [];
  return prune({ fetchImpl: cfk.fetchImpl, token: 'tok', account: 'acct', project: 'sendoff',
                 log: s => lines.push(String(s)), wait: async () => {}, ...extra }).then(out => ({ out, lines }));
};

console.log('\nwhat it plans');
const plan = planPrune({ live: LIVE, all: deps });
ok('keeps the live one and the five newer', plan.keep.length, 6);
ok('the live one is among them', plan.keep.some(d => d.id === LIVE), true);
ok('plans to delete the 54 older ones', plan.remove.length, 54);
ok('every one of them older than the live one',
   plan.remove.every(d => Date.parse(d.created_on) < Date.parse(plan.liveDep.created_on)), true);

console.log('\na dry run');
{
  const cfk = fakeCloudflare();
  const { out, lines } = await run(cfk);
  ok('reads every page of the list', cfk.calls.filter(c => c.endsWith('sendoff/deployments')).length, 3);
  ok('deletes nothing', cfk.calls.some(c => c.startsWith('DELETE')), false);
  ok('and says how many it would', out.planned, 54);
  const said = lines.join('\n');
  ok('prints no id, short id or address',
     deps.some(d => said.includes(d.id) || said.includes(d.short_id) || said.includes('pages.dev')), false);
}

console.log('\nfor real');
{
  const cfk = fakeCloudflare();
  const { out, lines } = await run(cfk, { doDelete: true });
  ok('deletes the 54', out.deleted, 54);
  ok('the live one is still there', cfk.remaining.has(LIVE), true);
  ok('and never asked to delete it', cfk.calls.includes(`DELETE deployments/${LIVE}`), false);
  ok('six left in all', cfk.remaining.size, 6);
  ok('every delete sent with force, for aliased ones', cfk.forced.length === 54 && cfk.forced.every(Boolean), true);
  const said = lines.join('\n');
  ok('still prints nothing that reaches a deployment',
     deps.some(d => said.includes(d.id) || said.includes(d.short_id) || said.includes('pages.dev')), false);
}

console.log('\nwhen some fail');
{
  const failing = deps.filter(d => d.id !== LIVE).slice(10, 12).map(d => d.id);
  const cfk = fakeCloudflare({ failIds: failing });
  const { out, lines } = await run(cfk, { doDelete: true });
  ok('the rest still go', out.deleted, 52);
  ok('and the failures are counted, so the job fails', out.failed, 2);
  ok('without naming them by address',
     failing.some(id => lines.join('\n').includes(id) || lines.join('\n').includes(id.slice(0, 8))), false);
}

console.log('\na token that does not work');
{
  const cfk = fakeCloudflare();
  const r = await prune({ fetchImpl: cfk.fetchImpl, token: 'wrong', account: 'acct', project: 'sendoff',
                          log: () => {}, wait: async () => {} }).then(() => 'ran', e => e.message);
  ok('stops before deleting anything', [/Authentication error/.test(r), cfk.calls.some(c => c.startsWith('DELETE'))], [true, false]);
}

console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
