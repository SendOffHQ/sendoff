---
version: alpha
name: SendOff
description: >-
  Live crew tracking for ultramarathons. A dark race-timing board read on a phone at an aid
  station, the racer's own one-thumb screen, and a public race page for everybody at home.
colors:
  primary: "#0FB8BF"          # the signal: brand, current, live. The one saturated brand colour.
  primary-hover: "#22D3DA"
  on-primary: "#04181A"       # text on a filled primary, 7.5:1
  background: "#0A0F14"       # the void: page ground
  surface: "#121820"          # raised: fields, buttons, menus
  surface-card: "#182029"     # cards, panels, tiles
  border: "#253340"
  border-strong: "#33454F"    # field and button outlines
  text: "#F0ECE3"             # ink, the wordmark's letters as drawn
  text-dim: "#B6C2C9"         # secondary copy
  text-muted: "#90A2AD"       # labels and meta; 4.5:1 on every card and the highlighted row
  on-pace: "#6EE7A8"          # on pace, leg done clean, saved
  tight: "#FFB07A"            # tight against a cutoff, warnings
  cutoff: "#FF7377"           # cutoff blown, off pace, errors, delete
  low-emphasis: "#8AA9D0"     # upcoming, finished, viewer, checkpoint
  signal-on-light: "#0A8B92"  # the signal on cream, white and paper
  cream: "#F5F2EA"            # light ground: print, marketing, partner pages
  beam: "#5EFDF6"             # glow only, never behind text (1.2:1 on white)
typography:
  display:
    fontFamily: Barlow Condensed
    fontSize: 44px            # 32px on a phone
    fontWeight: 800
    lineHeight: 1
    letterSpacing: -0.025em
  display-accent:
    fontFamily: Barlow Condensed
    fontSize: 44px
    fontWeight: 600           # italic, in primary: the last word of a race name
  body:
    fontFamily: IBM Plex Sans
    fontSize: 16px
    lineHeight: 1.5
  label-caps:
    fontFamily: JetBrains Mono
    fontSize: 11px            # uppercase, the smallest size on any screen
    letterSpacing: 0.18em
  data-lg:
    fontFamily: JetBrains Mono
    fontSize: 20px
    fontWeight: 700
    letterSpacing: -0.02em
  data-sm:
    fontFamily: JetBrains Mono
    fontSize: 12px
  button:
    fontFamily: JetBrains Mono
    fontSize: 11px            # uppercase
    fontWeight: 600
    letterSpacing: 0.1em
  field:
    fontFamily: JetBrains Mono
    fontSize: 13px            # 16px on a touch screen, always
rounded:
  xs: 3px
  sm: 4px
  md: 6px
  full: 999px
spacing:
  page-x: 40px
  page-x-phone: 16px
  page-top: 32px
  page-top-phone: 20px
  section: 32px
  card-pad: 16px
  stat-pad: 14px
  gap: 10px
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    padding: 10px 14px
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.on-primary}"
  button-saved:
    backgroundColor: "{colors.on-pace}"
    textColor: "#07231A"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.cutoff}"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.field}"
    rounded: "{rounded.sm}"
    padding: 10px 12px
  card:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "{spacing.card-pad}"
  stat-label:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.text-muted}"
    typography: "{typography.label-caps}"
  stat-value:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.text}"
    typography: "{typography.data-lg}"
  stat-sub:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.text-dim}"
    typography: "{typography.data-sm}"
  tag-on-pace:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.on-pace}"
    typography: "{typography.label-caps}"
    rounded: "{rounded.xs}"
  tag-tight:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.tight}"
    typography: "{typography.label-caps}"
    rounded: "{rounded.xs}"
  tag-cutoff:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.cutoff}"
    typography: "{typography.label-caps}"
    rounded: "{rounded.xs}"
  tag-low:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.low-emphasis}"
    typography: "{typography.label-caps}"
    rounded: "{rounded.xs}"
  beta-badge:
    backgroundColor: "{colors.background}"
    textColor: "{colors.primary}"
    typography: "{typography.label-caps}"
    rounded: "{rounded.xs}"
---

# SendOff design

How SendOff looks and why, for anybody (person or agent) changing a page. The values above
are the brand's; `brand/tokens.css` is where they are kept, `lib/race-theme.css` carries the
app's copy in `:root`, and this file says how to use them. Change a value in all three, then
run `node tools/stamp-assets.mjs` so browsers fetch the new stylesheet.

## Overview

SendOff is read in hard conditions: a crew member at an aid station at 3am, or in full sun,
tired, one hand full, on poor signal; a racer glancing at their own screen mid-stride; family
at home following the race page. Everything serves reading a number fast and pressing the right
button once.

The look is a race-timing board. A near-black ground, condensed display type for names,
monospace capital labels for every figure and its label, and one teal signal. The pace colours
(green, warm, red) are the only other saturated colours, because they are the things that change
during a race and the eye should go straight to them.

These are deliberate and they stay:

- **JetBrains Mono, uppercase and tracked, for labels, buttons and data.** It is the timing
  board. Generic design advice says to drop monospace and small caps labels; that advice is for
  marketing pages, and following it here would rebrand SendOff.
- **The race name's last word in italic teal.** One accent word, on purpose.
- **One signal hue.** Teal marks brand, current and live. Nothing else is teal.

## Colors

- **Primary (#0FB8BF)**, the signal: the live leg, links, the one filled action in a region, the
  beta badge, focus rings (as a 3px glow at 18%). 7.9:1 on the ground. On cream, white or paper
  use **signal-on-light (#0A8B92)** instead; the dark-ground teal is too pale there.
- **Grounds step up in tone**, never with shadows: background (#0A0F14), surface (#121820) for
  fields and buttons, surface-card (#182029) for cards and tiles. The body's faint teal radial
  glow and the fade on a racer card's top bar are the only gradients.
- **Ink.** Text (#F0ECE3) for anything that matters; text-dim (#B6C2C9) for secondary copy;
  text-muted (#90A2AD) for labels and meta. text-muted is the floor: it holds 4.5:1 on every
  card and on the highlighted current-leg row. Nothing that is read goes fainter.
- **Pace means pace.** on-pace (#6EE7A8) for on pace, a clean leg, a saved button; tight
  (#FFB07A) for close to a cutoff and warnings; cutoff (#FF7377) for over a cutoff, off pace,
  errors and destructive actions; low-emphasis (#8AA9D0) for upcoming, finished, viewer and
  checkpoint states. Never use these for decoration, or the board stops meaning anything.
- **Beam (#5EFDF6)** is a glow only. Never a surface, never behind text.
- The racer screen's recording microphone keeps the older, deeper red (#E5484D) as a fill, so
  its white icon stays readable; every other red is #FF7377.
- `color-scheme: dark` is set on the root, so date pickers, spinners, scrollbars and autofill
  are drawn dark. Print switches it back to light.

## Typography

Three faces, each with one job:

| Face | Job |
|---|---|
| Barlow Condensed | Race names and page titles. 800 for the title, 600 italic for the accent word. |
| IBM Plex Sans | Body copy: explanations, tutorials, notes, feedback. |
| JetBrains Mono | Labels, buttons, times, distances, every figure. Uppercase and tracked for labels and buttons; normal case for data. |

Sizes:

- **Nothing on screen under 11px**, at the size it is drawn. That includes chart labels: a
  chart drawn on a fixed 1000-wide canvas and shrunk to a phone takes its labels down to 4px,
  so charts and the elevation profile are drawn at the width they are shown at
  (`Race.charts.lineChart`, `lib/course-view.js`) and redraw when it changes.
- Labels 11px, tracked 0.1em to 0.2em. Data sublines 12px. Stat values 20px. Body 15px to 16px.
  Titles 44px, 32px on a phone.
- **Fields are 16px on any touch screen**, whatever a page sets for a laptop. A phone zooms the
  page into any field under 16px when it is tapped. This is set once in `race-theme.css` under
  `@media (pointer: coarse)`; a field meant to be larger than 16px says so with its own
  `!important` rule (the crew page's time field).
- Figures that tick (clocks, elapsed time) are monospace, so digits keep their width.

## Layout

- **The phone comes first.** 390px wide is the size every page is checked at. No sideways
  scrolling. One column on a phone; grids of stats are two across.
- Page padding 32px by 40px on a laptop, 20px by 16px on a phone. Sections 32px apart.
- Every race page opens the same way: the wordmark, the beta badge and the page's name in a
  mono caps row; the race name as the title; where the race is underneath in mono.
- **Tap targets.** The crew page's and racer screen's main actions (check in, arrived, save) are
  big, full-width buttons, and must stay that way. Aim for 44px on anything tapped at an aid
  station; the shared `.btn` is about 36px today, which is a known gap.
- **Pinch zoom is never switched off.** No `user-scalable=no`, no `maximum-scale=1`.
- Pages work offline from the cache and say when they last updated. A screen that may be stale
  says so in words, not only with a colour.

## Elevation & Depth

Flat. Surfaces are told apart by a step in tone and a 1px border (border #253340, fields and
buttons #33454F). No shadows on anything at rest; a shadow, if any, belongs to what floats over
the page: a menu, a modal, a toast. Glows belong to the live pulse beside the wordmark and to focus rings.

## Shapes

Small, square-ish radii, chosen once: 3px for tags and the beta badge, 4px for buttons, fields
and banners, 6px for cards and panels. Fully round only for the one-tap item chips and dots.

## Components

- **Buttons.** Mono caps, 11px, on surface with a strong border. **Primary** is filled teal with
  dark ink, and there is one per region: the thing this screen exists for. **Danger** is red text
  and border, and asks first before anything that cannot be undone. A button that saved turns
  green and says so.
- **Fields.** Surface fill, strong border, mono. Focus turns the border teal and adds a 3px
  teal glow; the outline stays as a transparent 2px line so Windows high-contrast mode still
  draws one. Every field has a name a screen reader can say: a `<label>`, or an `aria-label`
  when a table header carries the visible one.
- **Cards and runner cards.** surface-card, 1px border, 6px radius. On the race page a racer's
  card carries their colour as a bar across its top that fades out; their colour also draws
  their line on the charts and their dot on the map, and nothing else.
- **Stat tiles.** Label in mono caps (text-muted), value in mono 20px bold (text, or teal when
  live), subline in mono 12px (text-dim). Tiles divide with 1px borders, not gaps.
- **Tags.** Small mono caps, outlined or tinted, coloured by meaning: drop bag teal, checkpoint
  blue, no crew red, pacer green, skipped warm.
- **Toasts** have `role="status"` and `aria-live="polite"`; **error banners** have
  `role="alert"`, red text on a faint red tint.
- **Section heads that fold** (settings) are buttons to a keyboard: `role="button"`, focusable,
  Enter or Space toggles, `aria-expanded` says which way.
- **Charts.** One line per racer in the racer's colour, 2px, small dots; faint dashed grid;
  mono 11px axis labels in text-muted; targets dashed in warm, cutoffs dashed in red. Narrow
  charts label every second or third tick rather than shrink the labels.
- **Motion.** The live pulse beside the wordmark, the LIVE label's blink, the racer dot's pulse
  and the microphone while it records are the only endless animations. Every animation stops for somebody who has asked their phone for less
  motion; `race-theme.css` does this for all CSS animation, and any motion driven from script
  must check `prefers-reduced-motion` itself.

## Do's and Don'ts

Do:

- Use the tokens. A new colour or face needs a reason that survives the board's logic.
- Put teal on the one thing to press or the one thing that is live.
- Keep labels in mono caps and names in Barlow Condensed.
- Label every control, and style every link (the browser's default blue is unreadable here).
- Check every change at 390px wide, with a touch screen emulated.
- Write copy plainly: say what happens and why, in full sentences. No em dashes in anything a
  person reads in the app.

Don't:

- Set any text under 11px, any field under 16px on a touch screen, or any text under 4.5:1
  against what is behind it (3:1 for text 24px and up).
- Switch off zoom.
- Scale a fixed-size SVG down to fit a phone.
- Add gradients to buttons, cards or text, or shadows to things at rest.
- Use pace colours for decoration, or teal for anything that is not brand, current or live.
- Add an endless animation without checking it stops under reduced motion.
- Make a clickable `<div>`; use a `<button>`, or give it a role, focus and keys.

## Checks

These hold the rules above on every push, as part of `npm run test:browser`:

- `test/legibility.mjs`: ten pages at phone width; fails on text drawn under 11px (chart
  labels included) or contrast under 4.5:1.
- `test/touch-and-focus.mjs`: twelve pages on an emulated phone; fails if zoom is off, a field
  is under 16px, a control has no name, the colour scheme is not dark, a field has no focus
  ring, toasts and errors are not announced, an animation runs on under reduced motion, or the
  settings section heads cannot be opened from the keyboard.
