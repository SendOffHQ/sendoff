# SendOff: Roadmap

What is not built yet, and the order worth building it in.

`FEATURES.md` is the other half of this: it describes what the app does
today. Nothing here ships until it moves there.

Status of every item below was checked against the codebase on 2026-09-07,
not from memory. Where something is partly there, this says which part.

Sources:

- The pricing draft (Pricing & Features, Draft v1) and its feature matrix
- Ideas raised while building, recorded here rather than lost in a thread

---

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

### Race archive + PR tracking — *not built*
The hub lists races. Nothing tracks a personal record across them, and the
free tier's "last 3" cap has nothing to cap.

### Data export, CSV / JSON / GPX — *not built*
No export UI. The underlying files are JSON in a repo, which is not the same
as a feature.

---

## 3. Access & branding

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

## 4. Organizer tooling

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

## 5. Enterprise

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

1. **Ship the season you are in.** Race-to-race transfer and the goal-time
   planner are the two things that make a second race easier than the first.
   Both are small, both are self-contained, and neither needs billing.
2. **Then billing**, because everything else in the matrix is behind it, and
   because the free-tier caps need to exist before they can be enforced.
3. **Then the Pro features that justify the price**: alerts, export, weather,
   archive.
4. **Then Club**, which is mostly a data-model change (an org above a race).
5. **Organizer last and deliberately**, as its own project rather than a
   drip. It is the largest surface in the plan and the one with a real
   external dependency in timing hardware.

The one ordering trap: offline logging is the wedge the pricing plan is
built on, and it already ships to everyone for free. Putting it behind Pro
later takes something away from people who already have it. Decide early
whether that is the plan.
