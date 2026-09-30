// Deletes every old Cloudflare Pages deployment of the site but the live one.
//
//   node tools/cf-pages-prune.mjs            # dry run: says what it would delete
//   node tools/cf-pages-prune.mjs --delete   # deletes it
//
// Every deployment Pages has ever built stays reachable at its own address,
// <short id>.<project>.pages.dev, serving the files it was built from. Once
// race files were purged from the repository's history on 2026-09-30, the old
// deployments were the last public copy of them, so this clears them out.
// Runs in .github/workflows/cf-pages-prune.yml with the same token the deploy
// uses (Cloudflare Pages: Edit).
//
// Kept: the project's current production deployment, and anything newer than
// it, which is a deploy that finished while this was running. Cloudflare will
// not delete the active production deployment anyway; this does not ask it to.
//
// The log is public (a public repository's Actions logs are), and a
// deployment's id is its address: the short id is the subdomain. So no id,
// short id or URL is ever printed, only dates, commits and counts. A dry run
// that listed addresses would publish a directory of the very copies this is
// here to remove.
import path from 'node:path';

const API = 'https://api.cloudflare.com/client/v4';

async function cf(fetchImpl, token, method, url) {
  const res = await fetchImpl(url, { method, headers: { Authorization: `Bearer ${token}` } });
  let json = null;
  try { json = await res.json(); } catch (e) {}
  if (!res.ok || !json || json.success === false) {
    const why = json && json.errors && json.errors[0] ? `${json.errors[0].message} (code ${json.errors[0].code})` : 'no readable answer';
    throw new Error(`Cloudflare said ${res.status}: ${why}`);
  }
  return json;
}

export async function listDeployments({ fetchImpl = fetch, token, account, project }) {
  const base = `${API}/accounts/${account}/pages/projects/${project}`;
  const proj = (await cf(fetchImpl, token, 'GET', base)).result || {};
  const live = proj.canonical_deployment && proj.canonical_deployment.id;
  if (!live) throw new Error('The project has no production deployment to keep; stopping rather than guessing.');
  const all = [];
  for (let page = 1; ; page++) {
    const j = await cf(fetchImpl, token, 'GET', `${base}/deployments?page=${page}&per_page=25`);
    all.push(...(j.result || []));
    const info = j.result_info || {};
    if (!(j.result || []).length || page >= (info.total_pages || page)) break;
  }
  return { live, all };
}

// Which to delete: everything older than the live deployment. The live one
// and anything newer are kept.
export function planPrune({ live, all }) {
  const liveDep = all.find(d => d.id === live);
  const liveAt = liveDep ? Date.parse(liveDep.created_on) : Infinity;
  const keep = [], remove = [];
  for (const d of all) {
    if (d.id === live || Date.parse(d.created_on) >= liveAt) keep.push(d); else remove.push(d);
  }
  return { liveDep, keep, remove };
}

// A line about a deployment that gives away nothing that reaches it.
export function describe(d) {
  const m = (d.deployment_trigger && d.deployment_trigger.metadata) || {};
  return `${String(d.created_on || '').slice(0, 16).replace('T', ' ')}  ${d.environment || '?'}  ` +
         `commit ${(m.commit_hash || '').slice(0, 7) || '-'}`;
}

export async function prune({ fetchImpl = fetch, token, account, project, doDelete = false,
                              log = console.log, wait = ms => new Promise(r => setTimeout(r, ms)) }) {
  const { live, all } = await listDeployments({ fetchImpl, token, account, project });
  const { liveDep, keep, remove } = planPrune({ live, all });
  log(`${all.length} deployments of ${project}.`);
  log(`Keeping the live one: ${liveDep ? describe(liveDep) : '(not in the list)'}` +
      (keep.length > 1 ? `, and ${keep.length - 1} newer` : ''));
  const byDay = {};
  for (const d of remove) { const day = String(d.created_on).slice(0, 10); byDay[day] = (byDay[day] || 0) + 1; }
  log(`${doDelete ? 'Deleting' : 'Would delete'} ${remove.length}, by day built:`);
  for (const day of Object.keys(byDay).sort()) log(`  ${day}  ${byDay[day]}`);
  if (!doDelete) { log('Dry run: nothing deleted.'); return { deleted: 0, failed: 0, kept: keep.length, planned: remove.length }; }

  const base = `${API}/accounts/${account}/pages/projects/${project}/deployments`;
  let deleted = 0, failed = 0;
  for (const d of remove) {
    try {
      await cf(fetchImpl, token, 'DELETE', `${base}/${d.id}?force=true`);
      deleted++;
    } catch (e) {
      failed++;
      log(`  could not delete ${describe(d)}: ${e.message}`);
    }
    await wait(150);   // well inside Cloudflare's API rate limit
  }
  log(`Deleted ${deleted}${failed ? `, ${failed} failed` : ''}. Kept ${keep.length}.`);
  return { deleted, failed, kept: keep.length, planned: remove.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const token = process.env.CLOUDFLARE_API_TOKEN, account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const project = process.env.PAGES_PROJECT || 'sendoff';
  if (!token || !account) { console.error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are both needed.'); process.exit(1); }
  try {
    const out = await prune({ token, account, project, doDelete: process.argv.includes('--delete') });
    process.exit(out.failed ? 1 : 0);
  } catch (e) { console.error(e.message); process.exit(1); }
}
