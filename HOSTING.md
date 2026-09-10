# Moving the site to Cloudflare Pages

Decided 2026-09-10. Everything here is staged and inert: pushing it changes
nothing until a Cloudflare Pages project exists and DNS is pointed at it.

## Why

The worker, the database, KV, email and the live-push prototype are all on
Cloudflare already. The static site never moved, and was never written down as
something that would.

The reason to move it is not tidiness. It is that **a signed-out spectator
polls GitHub Pages directly**, not the worker: `readRaceFile` only goes through
the proxy when there is a session (`if (preferWorker && cfg)`). So the one axis
that grows without bound lands on a host whose bandwidth limits are soft and
whose terms discourage high-traffic use.

Three things come with the move:

- **Bandwidth.** Cloudflare Pages documents no free-plan bandwidth limit. Its
  constraints are 500 builds a month, 20,000 files and 25 MiB per asset. This
  site is 134 files and its largest asset is 1.2 MB.
- **Headers.** `_headers` makes `Cache-Control` and ETag revalidation ours to
  set. `ROADMAP.md` calls conditional requests "most of the win for the least
  effort" and they have never been possible on GitHub Pages.
- **One origin.** Site, worker, D1, KV and the Durable Object in one account.

## The shape of the trial

Both hosts serve the same commit at the same time. `deploy-pages.yml` keeps
publishing to GitHub Pages and `deploy-cf-pages.yml` publishes the same files
to Cloudflare Pages. **DNS is the switch, and DNS is the revert.**

    sendoff.run          GitHub Pages       (live, unchanged)
    sendoff.pages.dev    Cloudflare Pages   (identical, for comparison)

Nothing about the app changes while both are up. The comparison is the point:
if the Cloudflare copy misbehaves, it misbehaves on a URL nobody is using.

## What only you can do

1. **Widen the API token.** Both secrets already exist, because the worker
   deploy uses them, and the first run of this workflow proved the token
   authenticates. What it does not have is Pages permission: the run failed
   with *The Pages project "sendoff" does not exist*.

   Cloudflare dashboard, **My Profile, API Tokens**. On that page there are two
   lists and only one of them is right:

   - **API Tokens** is the one. Find the token the worker deploy uses, Edit,
     and add **Account, Cloudflare Pages, Edit** to the permissions it already
     has. Editing permissions does not change the token's value, so the GitHub
     secret does not need touching.
   - **API Keys**, the Global API Key, is not. It grants everything on the
     account, cannot be scoped, and cannot be revoked without breaking every
     other thing that uses it. It does not belong in CI.

   If it is not obvious which token is in the secret, make a new one instead:
   Create Token, Custom token, with Workers Scripts Edit, Workers KV Storage
   Edit, D1 Edit and Cloudflare Pages Edit, then replace
   `CLOUDFLARE_API_TOKEN` in the repository secrets and delete the old token.

   Pages Edit is needed either way. Creating the project by hand in the
   dashboard does not avoid it, because publishing needs the same permission.

   The workflow creates the project itself once the token can, so this is the
   only thing to get right. If you would rather make it by hand: Workers &
   Pages, Create, Pages, Direct Upload, named `sendoff`. Do not connect it to
   the git repository, because the workflow uploads, which is what keeps both
   hosts publishing the same commit through the same pipeline.
3. **Let the worker answer the trial origin.** In `worker/wrangler.toml`:

       ALLOWED_ORIGINS = "https://sendoff.run,https://sendoff.pages.dev"

   Without it, anything signed in fails CORS on the trial URL and the trial
   only tells you about signed-out reading. Take the second origin back out
   after the cutover.

## What to check on sendoff.pages.dev before touching DNS

The offline path is the part most likely to differ, and it is the part this
app has been bitten by most.

- The hub lists races, and a race opens.
- `/races/<slug>/` opens and the address bar keeps it.
- Sign in, open the pit board, log something, and see it on the race page.
- Turn on airplane mode, reload the race page, and confirm splits, course and
  the pit and racer links are all still there.
- Reload `/races/<slug>/` offline. This one exercises the service worker
  fallback added in v6.
- Check response headers: `curl -I https://sendoff.pages.dev/races/<slug>/data.json`
  should show `cache-control: no-cache` and an `etag`.

`npm run test:browser` can be pointed at the trial host by changing `BASE` in
`test/offline-browser.mjs`, which is the fastest way to do most of the above.

## The cutover, and the revert

**Cutover.** Add `sendoff.run` as a custom domain on the Pages project, then
point the DNS record at Pages. Remove the custom domain from the GitHub Pages
settings so the two do not fight over it.

**Revert.** Point DNS back at GitHub Pages. `deploy-pages.yml` never stopped
running, so the GitHub copy is current, not stale. That is the whole reason
both deploys stay on during the trial.

Keep both for at least one full race weekend before turning either off.

## What is NOT moving yet, and why the order matters

**Race data stays in git for now.** "The GitHub repo as archive" is storage
steps 5 and 6, and doing it before one other piece would make spectator
scaling worse rather than better:

Today an anonymous spectator reads `races/<slug>/data.json` straight off the
static host. It costs the worker nothing. If race data stops being written to
git, that path goes stale, and every anonymous reader has to go through the
worker instead: straight back onto a 100,000 requests a day budget, for bytes
that are identical for every one of them.

So the order is:

1. **This.** Move the hosting. Safe, reversible, helps every reader.
2. **The published copy.** The worker writes one cached object per race to KV
   or R2 whenever something changes, served from the edge. `ROADMAP.md` has
   this under "The published copy, and why it is a separate job". It is what
   makes the static copy unnecessary.
3. **Then steps 5 and 6.** Stop writing `races/**`, purge the history, and the
   repository becomes the archive.

Doing 3 before 2 is the one ordering mistake available here, and it would only
show up under an audience.
