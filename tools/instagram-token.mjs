// Keeps the Instagram token from lapsing. A long-lived token lasts 60 days
// and can be refreshed once it is a day old; .github/workflows/instagram-token.yml
// runs this twice a month so it never gets near the end.
//
// Instagram answers a refresh with a token. When it is the one already
// stored, the refresh just moved its expiry and there is nothing to save.
// When it is a new one, it has to go back into the IG_ACCESS_TOKEN secret,
// which the workflow's own token is not allowed to write: that takes
// SECRETS_WRITE_TOKEN, a fine-grained token with "Secrets: read and write" on
// this repository only. Without it, this fails loudly so the new token is not
// lost quietly and the old one left to run out.
//
// The token is never printed. The new one is masked in the log before
// anything else happens with it, and handed to gh on stdin, not the command line.
import { spawnSync } from 'node:child_process';

const old = process.env.IG_ACCESS_TOKEN;
// Not set up yet is not a failure: the schedule runs from the day this was
// merged, and a red run every fortnight before anyone has a token is noise.
if (!old) { console.log('IG_ACCESS_TOKEN is not set yet; nothing to refresh.'); process.exit(0); }

const url = 'https://graph.instagram.com/refresh_access_token?' +
  new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: old });
let json = null, status = 0;
try {
  const res = await fetch(url);
  status = res.status;
  json = await res.json();
} catch (e) {}
if (!json || json.error || !json.access_token) {
  const e = json && json.error;
  console.error(`Refresh refused (${status}): ${e ? `${e.message} (code ${e.code})` : 'no readable answer'}`);
  console.error('A token under a day old cannot be refreshed yet. One that has expired needs generating again: see brand/social/INSTAGRAM.md.');
  process.exit(1);
}

const fresh = json.access_token;
console.log(`::add-mask::${fresh}`);
const days = Math.floor((json.expires_in || 0) / 86400);
const until = new Date(Date.now() + (json.expires_in || 0) * 1000).toISOString().slice(0, 10);

if (fresh === old) {
  console.log(`Refreshed. Good for ${days} more days, until ${until}.`);
  process.exit(0);
}

if (!process.env.GH_TOKEN) {
  console.error(`Instagram issued a new token, good until ${until}, and there is no SECRETS_WRITE_TOKEN to store it with.`);
  console.error('The stored token still works until its own expiry. Add SECRETS_WRITE_TOKEN (see brand/social/INSTAGRAM.md) so the next refresh can save itself, or generate a token again before then.');
  process.exit(1);
}
const r = spawnSync('gh', ['secret', 'set', 'IG_ACCESS_TOKEN', '--repo', process.env.GITHUB_REPOSITORY],
  { input: fresh, encoding: 'utf8' });
if (r.status !== 0) {
  console.error(`Could not save the new token: ${(r.stderr || '').trim().split('\n')[0]}`);
  process.exit(1);
}
console.log(`Refreshed and saved. Good for ${days} more days, until ${until}.`);
