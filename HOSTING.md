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
    sendoff-abi.pages.dev  Cloudflare Pages (identical, for comparison)

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

       ALLOWED_ORIGINS = "https://sendoff.run,https://sendoff-abi.pages.dev"

   Without it, anything signed in fails CORS on the trial URL and the trial
   only tells you about signed-out reading. Take the second origin back out
   after the cutover.

   Done, and verified: a preflight from the trial origin comes back
   `access-control-allow-origin: https://sendoff-abi.pages.dev`.

   There is no separate trial account. Both hosts talk to the same worker and
   accounts live in its `USERS` secret, so sign in with the normal address and
   password.

## The trial URL is not the one you would guess

`sendoff.pages.dev` belongs to somebody else: a social media scheduling product
at sendoff.social. Cloudflare hands out `<project>.pages.dev` globally, and that
name was taken, so this project got **`sendoff-abi.pages.dev`**. The deploy log
prints the real address every run; read it rather than assuming it.

## A deleted page can outlive its deployment, in one region

Observed 2026-09-10, deleting a test race. Both races were gone from the
database, from git and from the manifest, and `/races/<slug>/data.json`
answered 404 — but `/races/<slug>/` answered **200 from some requests and 404
from others**, for over an hour.

It is not the propagation lag described below. That settles in a minute and
this did not. Splitting the responses by `cf-ray` shows why:

    ray=…-IAD   404                                  correct
    ray=…-EWR   200   age=10807, cf-cache-status: DYNAMIC

One region holding a three-hour-old copy. `DYNAMIC` says Cloudflare's CDN is
not the thing caching it, and `age` climbing in real time across checks
(10807, 10925, 10926) says it is one object getting older rather than being
refetched. **A fresh deployment did not clear it**, which is the part worth
knowing: shipping another commit is the reflex and it does not work.

The remedy is a cache purge from the Cloudflare dashboard, Caching,
Configuration, Purge Everything or the single URL.

**How much it matters: not much, and it is worth being precise about why.** The
page that survives is an empty shell. It forwards into `race.html`, which asks
the worker for the race and is told 404, so no race data is reachable through
it. The cost is a stale link that loads before saying the race is gone.

Two things follow. When checking that a delete worked, `/public` on the worker
is the answer, because it is the read path; the share address is a static file
and can lie. And the mixed 200/404 that this produces is indistinguishable at a
glance from a delete that half-worked, which is one of the arguments for the
single-commit delete in `ROADMAP.md`.

## Give a deploy a minute before judging it

Checking straight after the workflow goes green gives mixed answers: some
paths behave, some do not, and it looks like a partial failure. It is
propagation. The same checks a minute later were uniform. Worth knowing before
somebody concludes something from a half-settled deploy, which nearly happened
here.

## Two differences from GitHub Pages, both found by running both

**Unknown paths.** Cloudflare Pages answers a path it does not have with the
project's fallback HTML and a **200**, where GitHub Pages returns 404. That is
not cosmetic: `readRaceFile` checks `res.ok`, so a missing race file would come
back as a page of markup, be treated as the file, and be written into
`lastSeen` as that race's data. A poisoned copy in storage outlives the
mistake, because it is what gets handed back with no signal.

Fixed at both ends: `404.html` at the root, which is what makes Pages return a
real 404, and a content-type check in `readRaceFile` so no host can hand the
app markup where it asked for JSON.

Verified after the fix: `/definitely-not-real`, `/worker/src/worker.js`,
`/races/no-such-race/data.json` and `/races/no-such-race/` all answer **404**
with the not-found page, while every real path still answers 200. Note that
Pages redirects `/404.html` to `/404`, which is why the file appears to be
missing if you ask for it by name.

**`worker/`, `test/` and `tools/`** are served by GitHub Pages and are not
uploaded here. Nothing references them; the smaller surface is deliberate.

**The `.html` redirect, which turned out not to be a decision.** Cloudflare
Pages 308s `/race.html` to `/race`. This sat on the list as "disable it in the
Pages settings or repoint the app's links", and the first half of that was
simply wrong: `html_handling` is a Workers static-assets option and Pages
projects have no equivalent, in the dashboard or anywhere else.

It does not matter, for two reasons, both measured 2026-09-10:

    /race.html?id=six-0&t=abc  →  308  /race?id=six-0&t=abc     query kept, token and all
    sendoff.run/race           →  200  the race page            GitHub Pages resolves it too

So the query string survives, which is what would have broken share links, and
the extensionless form works on *both* hosts, so repointing the links was never
blocked by the trial the way it looked. The cost as it stands is one extra
round trip on the first hit of an `.html` address. It is per navigation, not
per poll, and no data read goes near it: `/races/<slug>/data.json` and the
worker's `/public` are not `.html` and are not redirected.

Left alone deliberately. Repointing thirteen pages' links and the service
worker's precache list to save one redirect per navigation is a change with
more ways to go wrong than the thing it fixes.

**`_headers` only works on one of them.** It is a Cloudflare Pages feature, and
GitHub Pages has no way to set custom headers at all. Measured 2026-09-10:

    sendoff.run            cache-control: max-age=600
    sendoff-abi.pages.dev  cache-control: no-cache

So on GitHub Pages a published race file is cached by the browser for ten
minutes. The reason that has never been a bug is the `?_=` + `Date.now()` on
every published read, which makes each poll a unique URL the cache has never
seen. That cache-buster is not a leftover: on GitHub Pages it is load-bearing,
and it is the only thing standing between an unlisted share link and a
ten-minute-old race.

Which reverses what the roadmap says about dropping it. It can only go after
the cutover, because only Cloudflare Pages honours the `no-cache` and the ETag
that would replace it. Worth counting as an argument for the move: it is the
difference between correct cache headers on race data and none.

## What to check on sendoff-abi.pages.dev before touching DNS

The offline path is the part most likely to differ, and it is the part this
app has been bitten by most.

- The hub lists races, and a race opens.
- `/races/<slug>/` opens and the address bar keeps it.
- Sign in, open the pit board, log something, and see it on the race page.
- Turn on airplane mode, reload the race page, and confirm splits, course and
  the pit and racer links are all still there.
- Reload `/races/<slug>/` offline. This one exercises the service worker
  fallback added in v6.
- Check response headers: `curl -I https://sendoff-abi.pages.dev/races/<slug>/data.json`
  should show `cache-control: no-cache` and an `etag`. Confirmed 2026-09-10.

Two things worth checking that did not exist when this list was written:

- **The live push on a phone that goes to sleep.** A websocket can be killed by
  a captive portal or a locked phone without saying so, which is the failure
  the poll underneath exists to cover. Open a race page, lock the phone for a
  few minutes, unlock it, and confirm the page catches up rather than sitting
  on a stale split. This is the one worth doing on a real phone on cell data,
  because it cannot be reproduced on a desk.
- **A spectator with no account.** Open a public race in a private window,
  signed out, and confirm it still updates within a few seconds. That reads
  `/public` on the worker rather than the published file, so it is the path a
  share link actually takes now.

`npm run test:browser` can be pointed at the trial host by changing `BASE` in
`test/offline-browser.mjs`, which is the fastest way to do most of the above.

## The cutover, and the revert

**Cutover.** Cloudflare dashboard, Workers & Pages, the `sendoff` project,
Custom domains, Set up a custom domain, `sendoff.run`. The zone is already in
the same account, so Cloudflare offers to change the DNS itself: accept, and it
replaces the four A records below with a proxied CNAME to the project. Repeat
for `www.sendoff.run` if you want it to follow. Then wait for the certificate,
usually a minute or two.

**Do not remove the custom domain from the GitHub Pages settings**, which this
file used to tell you to do. Leaving both configured is what keeps the revert
to a single DNS change: GitHub Pages will only serve `sendoff.run` while it is
still configured to, and re-adding it later means waiting on certificate
issuance at the moment you least want to. They do not fight, because DNS
decides which one gets asked. The `CNAME` file in the repository root is what
holds that configuration, so leave that alone too.

**Revert.** Point DNS back at GitHub Pages. `deploy-pages.yml` never stopped
running, so the GitHub copy is current, not stale. That is the whole reason
both deploys stay on during the trial.

**The records as they stood before the cutover**, captured 2026-09-10 so the
revert does not depend on remembering them:

    sendoff.run        A      185.199.108.153  185.199.109.153
                              185.199.110.153  185.199.111.153   (DNS only)
    www.sendoff.run    CNAME  sendoffhq.github.io

`sendoff.run` was grey-clouded, which is why it answered `server: GitHub.com`
rather than Cloudflare. That also means **Worker routes on this zone have never
run**: a route needs the hostname proxied. Anything that wants the worker on
`sendoff.run/...` depends on this cutover having happened.

Keep both for at least one full race weekend before turning either off.

## After the cutover, 2026-09-10

`sendoff.run` and `www.sendoff.run` both answer `server: cloudflare` on the
zone's proxy addresses. Verified straight after:

- `_headers` applies, which is the thing GitHub Pages could never do:
  `/races/*` and `/hub.json` come back `no-cache` with an ETag, `/brand/*`
  at a day.
- `/definitely-not-real`, `/worker/src/worker.js`, `/races/no-such-race/data.json`
  and `/races/no-such-race/` all 404. `/`, `/app/`, `/races/<slug>/` and
  `/hub.json` all 200.
- The worker still answers a preflight from `https://sendoff.run`, `/public`
  serves the published copy, and `/live` reaches the Durable Object.

**One thing to fix, and it is a zone setting rather than anything in the repo.**
`_headers` is not authoritative for `.js` and `.css`:

    /lib/race-core.js   _headers says 3600      served max-age=14400
    /sw.js              _headers says no-cache  served max-age=14400
    /brand/*.png        _headers says 86400     served max-age=86400   correct
    /*.html, /*.json    _headers                served as written      correct

That is the zone's **Browser Cache TTL**, set to 4 hours, which applies to
responses Cloudflare caches by default and raises anything with a lower TTL.
HTML and JSON are not default-cached, so they pass through untouched; the PNG
already asked for longer than four hours, so it kept it.

Fix: Caching, Configuration, **Browser Cache TTL, "Respect Existing Headers"**.

Neither symptom is currently doing harm, which is worth saying so the fix is
not mistaken for an emergency. `/lib/*` carries `?v=` and is busted by version
rather than by time. And `sw.js` is registered without `updateViaCache`, whose
default of `'imports'` means the browser bypasses its HTTP cache for the
service worker script itself. Worth fixing anyway: a header file that is
advisory rather than authoritative is a trap for whoever reads it next.

**Also true now and not before:** the zone is proxied, so Worker routes on
`sendoff.run` would run for the first time. The reason to want one is
same-origin (no CORS, no preflight) and latency. It is *not* headroom, per the
correction in `ROADMAP.md`: a cache hit in front of a Worker is still a billed
request.

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
