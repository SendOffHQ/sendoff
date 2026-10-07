# Race Dashboard: Feature List

An ultra-running crew dashboard hub: a static GitHub Pages site with an
optional Cloudflare Worker auth proxy.

## Race tracking
- Live race dashboard (`race.html`): per-runner progress, pace, cutoffs, predicted finish
- Pit/leg logging (`pit.html`): leg start/end times, calories, fluid, sodium, gear changes, meds, issues, notes
- Talk instead of type: a microphone inside the racer screen's write-in box, where the browser has speech-to-text (Chrome and Safari on a phone). The words land in the box to be read over and logged like anything typed, added to whatever was typed already; no signal, a blocked microphone or nothing heard each say so. The browser does the recognition, so the recording goes to Google or Apple, never to SendOff (privacy.html#voice). `test/voice-note.mjs`.
- How are you feeling: on the racer screen, for the 15 seconds the Undo is up after a check-in or send-off, three faces (good, getting by, rough). One tap is kept on that leg (`feelIn` arriving, `feelOut` leaving; `Race.feel`), shown beside the leg on the race page and the Out/In times on the pit board, and undone with the press. `test/feel.mjs`.
- The course on the pit board: the route map and elevation profile, with every aid station and each racer's estimated position, at the foot of `pit.html` as on `race.html`, so the crew need not switch pages. One copy, `lib/course-view.js`, drawn by both. `test/pit-course.mjs`.
- Worker-routed reads for signed-in crew to avoid GitHub Pages publish lag
- Predicted mileage / position for runners on course or in a pit
- Photos on a leg (`pit.html` to add, `race.html` to look): crew attach photographs to a leg of the course, with an optional runner tag and a caption. The leg is chosen for them and defaults to where the race actually is. Resized to 1600px on the phone before sending, which is also what strips the EXIF, so a photo of somebody at an aid station does not publish their coordinates. Queued in IndexedDB when there is no signal and sent when there is. On the race page each leg with photos offers them behind a Media control, loaded only when opened, and one button shows all of them in leg order. Stored in R2 and served from the bucket rather than through the worker.

## Course types
- Point-to-point segments, multi-loop courses, and loops-with-aid-segments
- GPX course upload with elevation profile and interactive aid-station markers
- Cutoff tracking (total time, last-leg start)
- AI as crew (Pro): from Manage access, connect an assistant such as Claude as crew for one racer, with a link that works for that race and racer only and is removed in one tap. The worker answers MCP at `/mcp/<token>` (`worker/src/ai-crew.js`): the assistant reads where the racer is, the next aid station and its cutoff, and intake against the plan, and logs food, drink, one-tap items and notes onto the racer's leg, and turns the racer's own write-ins into numbers: they come with the status it is told to read first on every message, so it logs them whenever the racer talks to it. Its numbers are estimates, shown with a ~ until a person types the real one on the pit board. No splits, course, roster or visibility. `worker/test/ai-crew.mjs`, `test/ai-crew-page.mjs`.
- Discord finish posts with a finish card: when somebody finishes a public race, the worker writes them to `races/<slug>/finishers.json` and holds the post. The share-cards workflow draws that racer's card (`tools/make-og.py`: their name, finish time, distance, climb and the course profile, no cutoff) and page (`races/<slug>/finish-<id>.html`), and the site deploy asks the worker (`POST /discord/flush`) to send what is ready, linking the finish page so the preview is the finish card. A post waits at most 30 minutes before going with the race's own card, and one for a race unlisted or deleted meanwhile is dropped. Unlisting takes the finish pages down. `worker/test/discord.mjs`, `worker/test/race-visibility.mjs`.
- Race time zone (`cfg.timezone`, `Race.tz`): picked in the setup wizard and on the settings page. The start, the finish cutoff, the last-lap gate and each aid station cutoff are entered as the day and clock time a race publishes ("Sun 1:00 PM"), and every time on the race, pit, racer, report and chart pages is shown on the race's clock with the zone named, whatever zone the viewer is in. A split corrected by hand on the pit board is read on the race clock too. Cutoffs are still stored as hours from the start; moving the start or changing the zone in settings keeps each cutoff at its day and time. A race from before zones shows each viewer's own zone, as it always did. The Discord announcement and share pages date a race in its zone. `test/race-timezone.mjs`.

## Charts (`charts.html` and the print report)
- Leg time per leg
- Mile pace per leg
- Aid-station time per stop
- Intake per hour: calories / fluid / sodium, with target lines
- Cumulative progress with a pace-based projected-finish ray and cutoff line
- Projected tile on the race page: the projected time, the finish as a time of day on the race's clock with its zone, and by how much it beats or misses the final cutoff. `test/projected.mjs`.

## Sharing
- Finish card (`lib/finish-card.js`): a 1080x1350 image drawn on the finisher's own device at the end of a race, with the course elevation profile, the splits marked on it, finish time, margin inside the cutoff, and the day's numbers. Four shapes (4:5, 1:1, 4:3, 16:9), with the wide two laid out in two columns rather than a stretched portrait. Ten switches choose what is on it (location, cutoff margin, course profile, each stat, date); the layout reflows and the card crops to what it holds, and the choices are remembered on that device. Save, or share straight to another app where the browser supports it. Nothing is uploaded and it works with no signal.

## Reporting
- Printable race report (`print-report.html`): cutoffs, per-runner leg tables, course elevation, and all charts, print-styled

## Race setup & config (`setup.html`)
- Create and configure races; define runners, targets, cutoffs
- Aid stations from a spreadsheet: the setup wizard and the settings page both import a CSV or Excel (.xlsx) file into the aid station table, and offer a template in both formats (`templates/`, built by `tools/make-aid-template.py`). Columns are found by heading in any order; only name and distance are needed. Distances in miles or kilometres, cutoffs as times ("Sun 1:00 PM", "6:00 AM", "Sat noon", a date and time) or as hours, yes/no for crew, drop bag, pacer and checkpoint. A file with problems names each one by row and changes nothing; a good one fills the table, and nothing is saved until the person saves. Read in the browser with no library (`Race.aidImport`); `test/aid-import.mjs`.
- Per-race ACL: visibility, editors, viewers

## Accounts & auth (Cloudflare Worker proxy)
- JWT sessions (7-day), PBKDF2 password hashing
- Hub account invites and per-race invites (`signup.html`)
- Password reset flow (`reset.html`)
- Direct PAT mode as an alternative to the worker

## Admin panel (`admin.html`)
- Account list with per-account race roles (editor/viewer)
- Send account invites and password-reset links
- Remove accounts

## Hub
- Race list home page (`index.html`); auto-tags races as done when complete
- Share links for read-only access
