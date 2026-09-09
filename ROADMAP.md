# SendOff: Roadmap

What is not built yet, and the order worth building it in.

`FEATURES.md` is the other half of this: it describes what the app does
today. Nothing here ships until it moves there.

Status of every item below was checked against the codebase on 2026-09-07 and
the storage and ordering sections again on 2026-09-08, not from memory. Where
something is partly there, this says which part.

Sources:

- The pricing draft (Pricing & Features, Draft v1) and its feature matrix
- Ideas raised while building, recorded here rather than lost in a thread

---

## Next: the order to build in

Written 2026-09-08, with the Sangre de Cristo 100 on the 26th and a code freeze
on the 19th. The calendar decides more of this than the backlog does.

**Nothing new ships before the freeze.** Two days of dry-run testing produced
six real bugs in the offline path, three of them introduced that same week, and
every one was found on a phone rather than by reading code. That is not a
backlog problem, it is a "this has never been run in anger" problem, and more
surface area is the wrong answer to it. The eleven days go to `DRY-RUN.md`.
Step 1 there, a crew member signing in on her own phone, is still unrun and is
the only step with no race-day workaround.

After the race, in this order:

1. **Finish the storage move** (steps 3 and 4 below). Not a feature, but now a
   promise: the setting is called unlisted rather than private, and the intro
   screen says it is not sealed. Both stay until `races/**` stops being written
   and is purged from history, at which point private becomes the honest word
   again. It also makes everything after it cheaper, because the
   published copy stops being a second source of truth to reason about.
2. **The race archive.** The cheapest real feature here, because the logic
   already ships: `Race.archive` in `lib/race-core.js` has the distance
   buckets, `resultFor`, `records` and `sort`, and no page uses any of it. It
   needs a page and a hub link. It also lands at the first moment there is a
   finished race to show. Build it together with the hub filters ("Finding a
   race among many" below): both want the same chips over the same list.
3. **Goal-time planner.** Target finish in, per-aid target times out, live
   delta against them. Self-contained, needs no billing, and it is what makes a
   second race better than the first.
4. **Printable crew sheet.** Checkpoints, cutoffs, racer details and room to
   write, printed the night before. Every number on it already exists, so it
   is mostly a second print template. It comes after the planner because
   target times are the one column that is not already computable, and it is
   the layer under the offline layer: paper has no battery and can be handed
   to a pacer who just showed up.
5. **Data export.** CSV, JSON, GPX. Small, read-only, no race-day risk, and it
   is what lets somebody trust a season of their racing to this: they can
   always get it back out.

Two held back on purpose:

- **Race-to-race transfer** looks like an easy win and is not. Half of it is
  already built through another door, as its own section below explains. The
  decision comes before the code.
- **Billing** is item zero for everything in the paid column and still the
  wrong thing to start next. The free caps, one runner and two crew, are
  enforceable in the worker today. Until something worth paying for is not
  grandfathered, a checkout flow gates nothing.

---

## Every race, forever

Decided 2026-09-09, and it replaces the pricing draft's cap of three historical
races on the free tier.

> Every public race stays readable, forever, by anyone. No account, no app, no
> plan. The hub lists them all, each one opens, and the splits, the course, the
> charts and the printout are all there years later.

This was already how it worked. What was missing was saying so, and a line in
the pricing draft that quietly said otherwise.

Why it is worth writing down rather than leaving as an accident of the build:

- A cap on history is the one paywall that bites hardest exactly when somebody
  cares most, which is when they go back to look at a race they ran. That is
  the moment a person decides whether their own data is theirs, and the answer
  has to be yes.
- It contradicts the promise above it. Nothing is taken away from anyone is not
  compatible with hiding a race somebody already ran.
- Every other free-tier limit is a cap on **scale**, one racer and two crew.
  None of them withholds something already made. A history cap would have been
  the only one, and the odd one out is usually the wrong one.

If the archive is ever sold, what is sold is the **analysis**: records, distance
buckets, comparison across races, trends. Never the history itself. A race page
is not a feature, it is the thing the person made.

One consequence to be deliberate about rather than surprised by: `races/index.json`
is a single public manifest, so the hub is already a public directory of every
public race anybody has run here. At four races that is a list. At four thousand
it is a product decision, and "public" may read to a creator as "anyone with the
link" rather than "listed on the front page". Worth a separate look before there
are enough races for it to matter, and it does not change the commitment above:
listed or not, a public race stays readable by anyone forever.

---

## Finding a race among many

Measured 2026-09-09, because the section above is what makes it necessary: if
every public race stays listed forever, the hub is the page that has to survive
the pile.

Today the hub loads `races/index.json`, renders **every** race in it, and on
every keystroke in the search box rebuilds every card's HTML from scratch. There
is no cap and no debounce. Synthetic manifests, measured in a real browser
(phone = 390x844 with a 4x CPU throttle, which is roughly a mid-range Android):

| races | first render | keystroke, desktop | keystroke, phone |
|---|---|---|---|
| 100 | 53 ms | 19 ms | 53 ms |
| 500 | 256 ms | 61 ms | 291 ms |
| 1,000 | 582 ms | 133 ms | 770 ms |
| 5,000 | 4.5 s | 713 ms | 3.7 s |

The manifest itself is 320 bytes per race: 294 kB at a thousand races, 1.5 MB at
five thousand, and gzip takes those to about 59 kB and 297 kB. The DOM is about
20 nodes per card, so five thousand races is a hundred thousand nodes.

**Search breaks first, somewhere around 300 to 500 races on a phone**, and it
breaks before either the manifest size or the node count is worth worrying
about. A keystroke that costs a third of a second does not read as slow, it
reads as broken: letters arrive out of order and the box feels stuck. That is
the whole finding. Everything else has headroom.

So the order is not the order it looks like:

1. **Debounce the search and cap what is rendered.** Filter the full list in
   memory, draw about 30 cards, and offer "show all N". This is the only item
   that is about performance, it is perhaps thirty lines, and it moves the wall
   from 500 races to somewhere past ten thousand. Everything below it is about
   finding a race, not about speed.
2. **Status as a filter, not only a sort.** Live, upcoming, finished. The one
   people reach for during a race weekend, and it is a chip row over a field the
   hub already computes.
3. **Mine and all.** Once the hub is a public directory of everyone's races, the
   default question a signed-in person has is "where is mine".
4. **Activity.** The field landed this week and every race carries one. A filter
   is nearly free, and it is the one that makes a mixed hub legible: a paddler
   does not want to scroll past trail hundreds.
5. **Year.** A single chip row, most recent first.

**Not a date range selector.** It was considered and it is the wrong shape here.
A range is two date pickers, which on a phone is two modals and four taps to
answer a question that is nearly always "this year" or "last year". Races are
annual and people remember them by year, not by span. A year chip is one tap and
it composes with the other filters. If somebody ever genuinely needs a span, it
is a power-user affordance on a wide screen, not the primary control.

One bug found while measuring, worth fixing whenever the hub is next opened:
`refineStatuses()` awaits config and data **sequentially** for each live race.
At twenty live races that is forty serial round trips before the statuses settle.
It should be a bounded `Promise.all`, and the bound matters more than the
parallelism because the proxy is the thing being asked.

Where this ends up: the single JSON manifest is a temporary shape. Once storage
steps 5 and 6 land and D1 is the source of truth, the hub should ask a query
endpoint for a page of races with the filters applied server-side, and the
manifest becomes a fallback for the signed-out published path rather than the
mechanism. That is not worth building before the D1 move, which is why none of
this is urgent and item 1 is the only piece that is genuinely cheap now.

Timing: after the race, alongside the archive. They want the same filter UI over
the same list, and building either one first without the other means building
the chips twice.

---

## The promise about what is free today

Four things ship free right now that the pricing draft prices into Pro:
**offline logging**, **private races**, **expiring share links**, and
**role-based permissions**. That was not a plan, it was the order the work
happened in. It still has to be dealt with honestly.

The commitment, in the words it should be published in:

> Offline logging, private races, share links and roles are free today.
> The pricing plan puts them in Pro, and when billing exists they will move
> there. We would rather tell you that now than surprise you later.
>
> **If you are using them before that happens, you keep them.** Accounts
> created while these are free keep them free, permanently, on the races
> they already have and on new ones.

Saying only the first half is honest and chilling: it puts a countdown clock
on the exact adoption the free tier exists to create. The second half turns
the same disclosure into a reason to sign up this season rather than next.
It also means nothing is ever taken away from anyone, which is the part that
would actually cost goodwill.

What it costs: an `earlyAccess` flag on the account, checked alongside the
plan wherever entitlements are. That is one more branch in the entitlement
code, forever. Worth it, but it is a real and permanent cost, not a
free gesture.

**Built, and only halfway.** The flag exists and is set on every account
created (`worker/src/worker.js`, `GRANDFATHERED`), but it restores two of the
four things named above: private races and share links. Offline logging and
role-based permissions are missing from it because neither is gated by plan at
all yet, so there is nothing for the flag to restore.

That is a trap with a delay on it. The day either one is put behind a plan, it
has to be added to `GRANDFATHERED` in the same change, or the promise silently
breaks for everyone who signed up while it was free, and breaks quietly enough
that nobody notices until somebody loses something. Whoever gates offline
logging or roles should treat updating that list as part of the work, not as a
follow-up.

Where this gets published: this file, once the repository is public, plus a
line on the pricing page and on the account screen. It should not be
findable only by people who read a roadmap.

**Still to decide:** whether the cutoff is a date, the launch of billing, or
a user count. A date is the most honest and the least flexible.

## Where the data lives

**Not built, and the largest single thing on this page.** Unnumbered because
it sits under the numbered sections rather than beside them.

Race data lives in a git repository, read through the GitHub Contents API and
served by GitHub Pages. That was the right call to get here: no database to
run, no bill, every split a signed commit, and the whole thing restorable from
any clone. It is also the cause of every latency and reliability problem the
app has, and they are not bugs. They are version control behaving correctly
while being asked to be a database.

Four symptoms, one mismatch:

| Symptom | Cause |
|---|---|
| A new race 404s on its second file | The Contents API is not read-after-write consistent |
| The map and profile lag a fresh race | Pages rebuilds per commit |
| A handful of dashboards saturate it | 5,000 GitHub API calls an hour, against 1,440 per open tab before the read cache |
| **A busy aid station throttles the site** | **Every press is a commit, every commit is a Pages build, and Pages soft-limits a branch-built site to 10 builds an hour** |

A split is a row that changes every few minutes for thirty hours. Git wants
immutable, reviewed, atomic history. Every press becoming a commit is absurd
on its face and works only because the volume is tiny.

The build limit is the one that arrives first and was the last to be noticed.
This repository has already had hours of 15, 15, 12 and 11 commits, from
development rather than a race, and Six-0 alone took 38 commits to `data.json`
for a single runner over a marathon. Four runners cycling through an aid
station inside ten minutes goes well past ten. Throttled builds do not fail
loudly: the Pages copy of the data simply stops updating, which is exactly what
a spectator without an account is reading.

### Three shapes of load, and only one scales badly

Worth separating before choosing anything, because they have nothing in common
except the word traffic.

| | Volume | Grows with |
|---|---|---|
| Crew writes | About 128 for a hundred miler | Nothing. Ten thousand concurrent races is 1.3M writes a day, which one small database does without noticing |
| Crew reads | 2 to 10 tabs a race | Crew size, which physics bounds |
| **Spectator reads** | **Unbounded** | **Audience. At any real scale this is almost all of it** |

The saving grace is that every spectator of a race sees identical bytes. That
makes the expensive path a caching problem rather than a database problem,
which is the cheapest kind there is, but only if the app is arranged so the
cache can do the work.

### The shape

Split by how the data behaves, rather than moving everything at once.

| | Goes to | Why |
|---|---|---|
| Splits, the live file | **D1** | Written constantly, read constantly, needs consistency |
| `config.json` | **D1** | Written rarely, but must be readable the instant it is written |
| `course.gpx` | **R2** | Large, immutable per race, wants a URL |
| The app itself | **Pages, unchanged** | Static HTML that changes when you deploy, which is what Pages is for |

The worker stops being a proxy to GitHub and becomes the API. It is already
the gate for access, so the ACL work does not move.

Rows rather than a JSON blob is the point, not an implementation detail. A leg
becomes one insert, so the sha-conflict retry loop disappears, and a client can
ask for `?since=<timestamp>` and be sent only what changed. That last one is
impossible against a static file and is what actually removes the read ceiling:
the poll stops costing a whole race every ten seconds.

Sketch:

```
races(slug PK, name, location, start_time, config JSON, visibility, created_by, updated_at)
race_people(slug, email, role)          -- the ACL the worker already enforces
legs(slug, runner_id, idx, start_time, end_time, calories, fluid_oz, sodium_mg)
```

### Does it fit in free

Checked against Cloudflare's published limits on 2026-09-07, not from memory.

- **D1 free:** 5 million rows read/day, 100,000 rows written/day, 500MB per
  database, 5GB per account.
- **R2 free:** 10GB-month, 1M class A and 10M class B operations/month, and no
  egress charge.

A hundred miler with 16 segments and four runners is on the order of 128 leg
writes for the whole race. Against 100,000 a day that is not a constraint in
any believable future.

Reads are the side to watch, and only if the client keeps asking for
everything. A 64-leg race polled every ten seconds is about 23,000 rows an hour
per open tab, so roughly 215 tab-hours a day. Better than GitHub's seven
concurrent dashboards, but still finite. With `?since=` it stops being a
number worth tracking.

### What this costs, and it is not nothing

**The repository is currently the backup.** Not a backup strategy anyone
chose, but a real one: the data is in git, cloned wherever it has been cloned,
and restorable to any commit. D1 replaces that with Time Travel, which is
seven days on the free plan. Seven days is a rollback, not an archive, and a
race someone ran is worth keeping for longer than that.

The answer is to keep git as the archive rather than the store: write to D1
during the race, and commit a final `data.json` once when the race finishes.
The audit trail and the `git log` per race survive; the latency does not. That
also keeps the thing that is genuinely nice about today's design, which is that
a finished race is a plain file anyone can read without an account.

**Losing per-split authorship.** Every press today is a commit with an author
and a timestamp. The finish-time archive keeps the record but flattens who
pressed what. If that matters, an `actor` column on `legs` costs nothing and
keeps it.

**Region.** D1 has one primary. For a race in Colorado written from a worker at
a Denver PoP this is not worth thinking about; it is worth thinking about
before promising an event in another hemisphere.

### Doing it without a big bang

1. ~~Worker gains D1-backed endpoints beside the GitHub ones and **writes to
   both**. Nothing reads D1 yet, so a bug is invisible.~~ **Done 2026-09-07.**
2. ~~Reads move to D1. GitHub becomes a write-only mirror, still correct, still
   the fallback.~~ **Done 2026-09-07**, behind `READ_FROM_D1` in
   `worker/wrangler.toml`, which is on. A race the mirror has not seen still
   falls back to git, so setting it back to `"false"` is the whole rollback.
3. New races stop writing to GitHub except the archive commit at finish.
   **Not done.** This is the one that makes the word private true again,
   because it is what stops the files existing.

   Until it lands, the setting is called **unlisted** rather than private
   everywhere a person can read it: the setup picker, the hub card badge, the
   share panel, the admin list, the intro, the landing page and both legal
   pages. Changed 2026-09-09, after a review pointed out that calling a
   guessable public file "private" is the kind of claim the Texas DTPA is
   about. Nothing under the hood moved: the stored value is still
   `visibility: "private"` and every comparison against it is untouched, so
   this is a text change and reverting it is another one. When step 3 lands
   and the files stop existing, the honest word becomes private again: change
   the labels back, and update the box in `privacy.html` that explains what
   unlisted means, which is the only place that also needs its argument
   rewritten rather than its noun swapped.
4. ~~Backfill the existing races~~ **done 2026-09-08**, and delete the
   dual-write. **Not done**, and it waits for 3.

Stopping after step 1 leaves the app exactly as it is today, which is the
property that made it safe to start.

What is left after the race, in the order it has to happen: stop writing race
data to git, purge `races/**` from history, then remove the client's fallback
to the published copy. Privacy lands at the second of those, not the first: a
file deleted from `main` is still readable in the history of a public
repository.

The purge has to take the commit **messages** with it, not just the file
contents. Until 2026-09-09 every message carried the address of whoever made
the change, and four people's addresses are in 191 of them. Dropping the
`races/**` paths leaves those commits empty and they go with it, which is the
right outcome, but a purge written to preserve history while rewriting only the
blobs would keep the exact thing worth removing.

### The published copy, and why it is a separate job

Moving writes to a database fixes correctness and the build limit. It does not
by itself fix spectators, because a thousand people watching would then be a
thousand database reads every ten seconds for bytes that are all the same.

So a race also has a **published copy**: one object per race, rewritten
whenever something changes, served from the edge. KV or R2. The cost of one
more viewer approaches nothing, and the database is never in the path of a
spectator at all.

Two things belong with it:

- **Conditional requests.** An ETag and a 304 mean a poll that finds nothing
  new does no origin work. This is most of the win for the least effort, and it
  is worth doing even before the storage move.
- **Push rather than poll**, eventually, over SSE or Durable Objects. Polling
  is what makes an audience expensive.

Rough cost at a scale that would count as working: a thousand simultaneous
viewers polling every ten seconds is about 8.6M requests a day, which on
Cloudflare's paid Workers plan is $5 a month plus $0.30 a million, so under a
hundred dollars, and most of those never reach the worker once the published
copy is cached. The infrastructure is not what makes this hard.

### The fork worth picking deliberately

The two halves of the pricing plan have opposite load shapes, and the answer
above is only mandatory for one of them.

- **Crew product:** many races, tiny audiences, spread across a calendar. Load
  is diffuse and almost any design survives it.
- **Organizer product:** one race, thousands of spectators, all of it inside a
  single day. Load is spiky and concentrated, and this is the half the pricing
  plan says the revenue is in.

If organizer is real, the published copy is not an optimisation to reach for
later. Retrofitting it underneath live spectator traffic is the worst available
time to do it.

### When

An earlier draft of this section said there was no emergency and named two
concurrent races as the trigger. That was wrong about which limit fires first.

The read optimisations have shipped, and a tab now costs 420 worker requests an
hour rather than 720, with GitHub asked at most once per path per three seconds
however many people are watching. Measured, that is roughly ten dashboards open
continuously, or fifteen across a race that straddles two days, and GitHub is no
longer what runs out first.

The build limit is, and it fires on race one. A crew working a busy aid station
will exceed ten commits in an hour, and the failure is silent: builds queue, and
the copy of the data that spectators without accounts are reading stops moving.
Nothing shipped so far touches that, because the cause is the commit itself.

So the honest ordering was:

1. **Now.** Anything that stops a press from being a commit. This is step 1 of
   the plan above, dual-writing, and the moment reads come off the database the
   commits can be batched to one at the end of the race.
2. **Before any race with an audience.** The published copy, or at minimum
   conditional requests, so spectators are not paying database reads for bytes
   they share with everyone else.
3. **Whenever.** The rest: backfill, deleting the dual-write, the archive
   commit at finish.

**What happened, 2026-09-08.** The build limit turned out to have a second
answer that was cheaper than any of this: a Pages site published by a GitHub
Actions workflow is not subject to the ten-an-hour branch-build limit at all.
`.github/workflows/deploy-pages.yml` does that, so a press is still a commit
and no longer throttles anything. The storage move went ahead regardless,
because the build limit was never its only reason: read-after-write was, and a
poll of a race now costs GitHub nothing rather than four API calls.

That leaves item 2 as the only part of this section still ahead, and it is
still only mandatory for the organizer half. See the fork above.

## 0. The thing the pricing plan assumes and nobody has built

**Billing and plan enforcement.** There is no payment processor, no
subscription state, no notion of a tier anywhere in the app or the worker.
Every paid row in the matrix is gated on this existing first, so it is item
zero rather than one item among many.

What it needs, roughly in order: a plan field on the account, a checkout and
webhook path, and an entitlement check the worker can apply to a write. The
worker is already the gate for access, so it is the natural place for it.

One decision to make before writing any of it: the free tier's caps are
"1 runner per race" and "2 crew editors". Both are enforceable in the worker
today. Everything else in the free column is capability rather than scale.

---

## 1. Race day

### Goal-time planner + ahead/behind delta — *not built*
Target finish time in, per-aid target times out, with a live delta against
them. The racer screen already computes a cutoff margin, which is the same
shape of arithmetic against a different number, so this is closer than it
looks.

### Printable crew sheet — *not built*
Raised 2026-09-09. A sheet you print the night before and hand to each crew
member: the checkpoints in order with their distances, the cutoff at each one,
the racer's details, and room to write.

Not the same thing as `print-report.html`, which already exists and is its
mirror image. That one is printed **after** and says what happened. This one is
printed **before** and says what is about to, which means most of its value is
in the blank space rather than the printed data.

What goes on it, in the order a crew member needs it:

- **The racer**, per sheet: name and bib, which exist today. Phone numbers for
  the racer and the crew, so a pacer who just showed up can reach somebody, and
  allergies or medication if the racer chose to record them. **Those last are
  the one part of this that is not already stored**, so the sheet either waits
  on new optional profile fields or ships with blanks to fill in by hand.
  Blanks are the better first version: it is a piece of paper, and a phone
  number written on it is worth the same as a printed one.
- **The checkpoints in order**, with cumulative distance, the cutoff time, and
  the target time if the goal-time planner has landed. Cutoff wants to be a
  clock time and not an elapsed one: nobody at 2am subtracts.
- **Blank columns**: in, out, and a note line. Wide enough to write in with a
  cold hand and a bad pen.
- **Fueling targets** per hour or per leg, from the profile that already exists.
- **The race page address**, printed as a URL and as a QR code, so a family
  member who is handed the sheet can follow along without being told how.

Why it is worth building even though the app works offline: paper does not have
a battery, does not need a passcode, and can be handed to a stranger. The pit
board keeps working with no signal, but it stops working at 4% and it cannot be
given to the pacer who just showed up. The sheet is the layer under the offline
layer, and a crew that has it is never fully in the dark.

Cheap, too, if it ships with those blanks. Everything else on it already exists
in `config.json`: legs, cumulative distance, cutoffs, racer names and bib
numbers, fueling targets. No worker change, no schema change, and
`print-report.html` already proves the print CSS. Mostly this is a second print
template and a page that offers it.

Two decisions to make when building it, both about paper rather than code:

1. **One sheet per racer, or one per crew member?** They differ when a crew
   works two racers, and the answer is probably per racer with the crew's
   contacts repeated on each, because the sheet lives in a pocket next to the
   racer it is about.
2. **How much fits.** One page per racer is the target, and it is the
   constraint that decides everything above. A course with 20 aid stations and
   a full fueling plan will not fit, so the template needs an honest rule for
   what is dropped first. Blank writing space is the last thing to go.

Best built after the goal-time planner, since target times are the one column
that is not already computable, and before the race archive, since a crew sheet
is useful the first time somebody sets up a race and an archive needs a history
to be worth opening.

### Spectator push / SMS alerts — *not built*
Notify on each aid arrival. Needs a delivery path (web push, or a provider
for SMS) and a subscription model for people without accounts.

### Weather at each aid, by ETA — *not built*
Forecast at each aid station for the time the runner is predicted to reach
it. Predicted mileage and ETA already exist; this is a forecast API plus
caching, and the honest failure mode is showing nothing rather than stale
weather.

### Multi-runner comparison view — *partly built*
The charts already draw every runner on shared axes and the dashboard
already stacks runner cards. What is missing is a view built for comparing
rather than one that happens to overlay.

---

## 2. Planning & history

### Race-to-race transfer — *not built*
Raised while building. Copy a setup from one race into another with options
on what comes across.

This is two jobs wearing one name, and they want different defaults:

- **Same race, next year.** The course is the point: segments, aid stations,
  drop bags, crew notes, the GPX. Nearly a clone, with splits and start time
  reset.
- **Different race, same runner.** The course is exactly what you do not
  want. Fueling metrics, shorthand, roster, units, cutoff shape.

Probably two starting points in the wizard, each with an override list,
rather than one flat checklist.

What can travel:

| | |
|---|---|
| Usually yes | `fuelMetrics`, `fuelPresets`, `units`, the roster, and each runner's `targets` / `phaseTargets` / `crewNotes` |
| Same race only | `course.segments`, `startAid`, `course.gpx`, per-aid cutoffs |
| **Never** | `createdBy`, `people`, `editors`, `viewers`, `teamCanInvite`, `visibility` |
| Obviously never | the splits, `startTime`, the name, the slug |

The never row is not a style note. Copying a roster of *people* would grant
access to a race they were never invited to. The worker already strips those
fields on a config write, so a careless implementation would be silently
stripped rather than leak, but the UI should not offer them at all.

**Decide before building:** half of this already has a mechanism. A runner's
goals, bands and notes live on their profile, and "Load their goals" already
pulls them into any race. For "same runner, new race" the fueling plan is
arguably solved. The new value is the race-level material: metrics,
shorthand, course, units, cutoffs. Worth not ending up with two paths to the
same outcome.

### Nutrition & gear playbooks — *partly built*
Per-runner goals, hour bands and crew notes exist and travel via profiles.
A named, reusable playbook that is not tied to one person does not.

### Race archive + PR tracking — *logic built, no page*
The hub lists races. Nothing tracks a personal record across them yet.

The pricing draft capped the free tier at the last three races. **That is
withdrawn**; see "Every race, forever" below. The archive is a view over all of
them for everybody, and if any part of it is ever sold, it is the analysis and
never the history.

The arithmetic is already written and already shipping: `Race.archive` in
`lib/race-core.js` carries the distance buckets a race is filed under, along
with `bucketFor`, `resultFor`, `records` and `sort`. No page calls any of it.
What is missing is a page and a link from the hub, which is why this is the
cheapest item on the list rather than a new feature.

### Data export, CSV / JSON / GPX — *not built*
No export UI. The underlying files are JSON in a repo, which is not the same
as a feature.

---

## 3. Social & spectator

Not in the pricing draft at all. Raised as a question, and worth its own
section because the answer changes where it sits: **social is a growth
feature, not a revenue one.** Paywalling it defeats the point of it. It
belongs in free, funded by the tiers above.

One reframe shapes most of it. **The runner is running.** They are not
reading a comment wall at mile 80, and a phone that buzzes on a ridge is a
liability. So the destination for anything a spectator sends is the *crew*,
at an aid station, to be read out loud. That is a better product than a
comment feed, and it is also the cheaper one to moderate.

### Cheer button — *not built*
One tap, no typing, no moderation surface. The pit board shows a count the
crew can hand over as a sentence: "forty people cheered while you were on
that climb." The smallest possible version of this whole section, and
probably the one with the best ratio of warmth to work.

### Messages for the next aid station — *not built*
A spectator writes a line; it queues; the pit board shows it when the runner
is in the aid station, and a crew member reads it out. Never pushed to the
runner's own screen. The racer screen stays one button.

### Follow a runner — *not built*
Person-level rather than race-level: their next race appears in your feed,
and you are told when it starts. Needs something that does not exist yet, a
public identity for a runner, since a runner today is a name on one race.
Pairs with the account link already built for racer mode, and with the race
archive in section 2.

### Follow a race — *not built*
The same, for an event rather than a person. Cheap once following exists.

### Crew updates from the aid station — *not built*
A line of text and optionally a photo, posted by the crew to the public race
page. This is what spectators actually want and refresh for: not another
split, but "he ate a full quesadilla and looks brighter than he did at
sixty."

### Finish card — *built*
Shipped. Drawn on the finisher's own device in four shapes (4:5, 1:1, 4:3,
16:9), with the course profile as the hero and the splits marked on it, and a
toggle for each part so a finisher chooses what goes on it. Nothing is
uploaded, so it works at a finish line with no signal. See `FEATURES.md`.

One thing deliberately left: the image is not used as the race page's own
preview when a link is shared, which would need something to render it
server-side.

### What this costs, honestly
Three costs the rest of the roadmap does not have:

- **Moderation.** The moment a stranger can send words that reach a runner,
  you own that problem. Mitigations are in the design above: messages go to
  the crew rather than the runner, the crew can hide a sender, and cheers
  carry no text at all. Approved-followers-only should be the default.
- **Privacy.** Following implies people are findable. Races are public by
  URL today, but *people* are not indexed. Being discoverable has to be
  opt-in, and a runner who does not want it must not be listed anywhere.
- **Running cost.** Social is the classic thing that sounds free and is the
  most expensive to operate: storage, spam, abuse reports, notification
  volume. It is also the one part of this roadmap that cannot be a static
  file in a repository.

### Where it goes in the order
After billing, alongside spectator alerts, because both need the same two
things that do not exist: an identity for people without accounts, and a
delivery path. The finish card is done and needed neither.
The cheer button is the other one that needs no plumbing.

## 4. Access & branding

### Custom accent + logo — *not built*
The theme is already token-driven (`lib/race-theme.css`), so the mechanism
exists; per-race overrides and an editor do not.

### Custom domain — *not built*
Organizer tier. Interacts with GitHub Pages hosting, so worth a hard look at
feasibility before promising it.

### Role-based permissions — *built, and mispriced*
Crew / racer / pacer / viewer ship to everyone today. The matrix puts this at
Club and above. Either the matrix moves or the feature gets gated, and gating
something already shipped is the worse of the two.

---

## 5. Organizer tooling

None of this is built. It is also where the pricing plan says the revenue is,
which is worth sitting with: the whole tier is greenfield.

- Bulk roster import (UltraSignup, RunSignup, RaceRoster)
- Chip / RFID timing integration
- Volunteer aid-station app
- Live leaderboard + public results
- Cutoff enforcement + DNF workflow
- Subscribe-by-bib for spectators
- Sponsor placements + embeddable widgets
- Field pacing & throughput analytics
- Official event page

---

## 6. Enterprise

Custom-priced, and every item is unbuilt. Not worth detailing until one real
customer asks.

REST API + webhooks · white-label · SSO / SAML · audit logs · data retention
and residency · SLA and onboarding · multi-event season licensing · priority
support · custom integrations

---

## Build order

The graphic and the reasoning behind the sequence:
<https://claude.ai/code/artifact/17f16a84-4c49-4299-b5fd-fe31d2a7651b>

In short:

0. **Where the data lives** goes first, and not for tidiness. Every press is a
   commit and every commit is a Pages build, against a soft limit of ten an
   hour, so a crew working a busy aid station throttles the site and the copy
   spectators read stops moving. That is not a ceiling somewhere out in the
   future, it is race one. Only the part that stops a press being a commit is
   urgent; the rest of the move can follow at its own pace. Everything below is
   also a week of porting later for every week it is built on the current
   design.
1. **Ship the season you are in.** Race-to-race transfer and the goal-time
   planner are the two things that make a second race easier than the first.
   Both are small, both are self-contained, and neither needs billing.
2. **Then billing**, because everything else in the matrix is behind it, and
   because the free-tier caps need to exist before they can be enforced.
3. **Then the Pro features that justify the price**: alerts, export, weather,
   archive.
4. **Social alongside the alerts**, since they need the same two missing
   pieces. It sits in free on purpose: it is what brings people in, not what
   they pay for. The cheer button and the finish card need none of that
   plumbing and can come whenever.
5. **Then Club**, which is mostly a data-model change (an org above a race).
6. **Organizer last and deliberately**, as its own project rather than a
   drip. It is the largest surface in the plan and the one with a real
   external dependency in timing hardware.

The one ordering trap is the four features already shipped free. See the
promise at the top: the answer is to say so plainly and to let everyone
using them now keep them.

**Amended 2026-09-08.** Item 0 is done as far as it needs to be before the
race, and the reason it was urgent turned out to be answered more cheaply
elsewhere: see "What happened" above. The near-term order now lives in
**Next: the order to build in** at the top of this file, which is the one to
read first. This section is the shape of the year; that one is the shape of
the next month.
