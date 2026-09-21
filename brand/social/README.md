# Social assets

Contact sheet: <https://sendoff.run/brand/social/>

The generator for SendOff's Instagram set. It renders HTML in headless
Chromium and screenshots it, so the slides use the same type stack, colour
tokens and wordmark as the app rather than an approximation of them drawn by
hand somewhere else.

## What it makes

| Output | Size | What it is |
|---|---|---|
| `sendoff-ig-01..06.png` | 1080x1350 | The six-slide intro carousel, 4:5 |
| `sendoff-story-01..06.png` | 1080x1920 | The same six as stories |
| `sendoff-pin-1..3-of-3.png` | 1080x1350 | The wordmark split across three profile tiles |
| `sendoff-announce-logo.png` | 1080x1350 | The wordmark on the gradient, 4:5 |
| `sendoff-announce-card.png` | 1080x1350 | "Send them out, bring them home.", 4:5 |
| `_strip.png`, `_pin-sheet.png` | working | The uncut strip and an assembled preview. Not for posting. |

The announce pair has its own source and its own script, `announce.html` and
`shoot-announce.js`, because `shoot.js` walks a fixed six-slide carousel and
its story variants. They share `fonts.css`, the colour tokens and the inlined
wordmark with `ig.html`, which is the point: they get posted alongside that
carousel, and a lockup that is nearly the same reads as a mistake.

## Running it

Needs Playwright (with a Chromium build) and Pillow. Neither is a dependency
of the site, so install them wherever you run this:

```sh
npm install playwright && npx playwright install chromium
pip install pillow
```

Then:

```sh
cd brand/social
OUT=$PWD SRC=$PWD/ig.html node shoot.js
python3 cut.py
node shoot-announce.js          # the two announce images
```

`shoot.js` reads `PLAYWRIGHT_BROWSERS_PATH` the usual way; if Chromium lives
somewhere Playwright will not find on its own, set `CHROMIUM` to the binary.

Outputs land in the same directory. The seventeen finished images are committed
so they can be pulled from github.com or from
`sendoff.run/brand/social/` without a local render; the working files
(`_strip.png`, `_pin-sheet.png`, previews) are gitignored. Re-run the scripts
and commit the result after any change to `ig.html` or `announce.html`, or the
committed images stop matching their source.

## Four things that are not obvious

**Size an inlined wordmark by height, never by width alone.** The SVG carries
`width="3059" height="1066"` attributes as well as a viewBox. Override only the
width in CSS and the height attribute stays in force, so the element gets a box
four times taller than its ink and everything laid out under it is pushed off
the frame. `ig.html` sets `height` with `width:auto` throughout for this
reason, and the announce pair does the same.

**The fonts are vendored, and that is deliberate.** `fonts.css` points at
local `.woff2` files instead of linking Google Fonts. The first build of this
set linked the stylesheet, the renderer had no network, and all twelve images
shipped in a system fallback font before anyone noticed. `shoot.js` now walks
`document.fonts` and exits non-zero if a family is not loaded.

Do not reach for `document.fonts.check()` here. It answers true when nothing
*needs* loading, which includes the case where the browser has quietly settled
on a fallback, so it reports success on exactly the failure it looks like it
would catch.

The three families are all SIL Open Font License 1.1; the licences are in
`fonts/`. Only the latin subset is vendored, because the copy is English.

**The story layout is redrawn, not rescaled.** A story is 1080x1920, but
Instagram lays its own furniture over roughly the top 250px (profile row,
close button) and the bottom 250px (the reply bar). Everything that has to be
read lives between them. The extra height buys bigger type, not more words.

**The triptych tiles overlap by 40px.** The strip is 3160 wide, not 3240, and
`cut.py` takes 1080-wide windows at x=0, 1040 and 2080. Instagram puts a
hairline gutter between profile tiles; a clean thirds split drops content into
it and leaves glyphs ending exactly on a seam. 40px of 1080 is about four
screen pixels at grid size, so it does not read as a repeat, but it makes the
join continuous.

Post the tiles **3, then 2, then 1**. The grid fills right to left along the
top row, so that order puts them left to right.
