# SendOff brand assets

The wordmark and mark as supplied, plus the tokens and component styles the app
uses to render them.

## Files

| File | Use |
|---|---|
| `sendoffprimaryonDark.svg` | **Source artwork** — full lockup, for dark grounds |
| `sendoffprimaryonLight.svg` | **Source artwork** — full lockup, for light grounds |
| `sendoff-wordmark.svg` | The same lockup with the two colours swapped for CSS vars, so one file serves both grounds |
| `sendoff-icon.svg` | Mark only (ring + dot), recolourable |
| `sendoff-icon-dark-bg.svg` | Mark in bright teal, for dark grounds |
| `sendoff-icon-light-bg.svg` | Mark in deep teal, for light grounds |
| `sendoff-icon-tile.svg` | Mark on a rounded dark tile — app icon, social avatar |
| `sendoff-favicon.svg` | Tile with tighter padding, for the browser tab |
| `tokens.css` | Colour + type tokens, ground presets, wordmark component styles |
| `wordmark.html` | Reference page showing both grounds |

The icons are cut from the lockup's own geometry — the ring is
`circle(2356, 350) r294 stroke112` and the dot `circle(2370, 350) r80`, both
inside the `skewX(-16)` group that gives the mark its lean — so they are the
same shape as the "O", not an approximation of it.

## Colours, as drawn

| | Signal | Letters |
|---|---|---|
| On dark | `#0FB8BF` | `#F0ECE3` |
| On light | `#0A8B92` | `#0D1117` |

One hue, two values. A colour reads heavier on a light ground and lighter on a
dark one, so each ground gets the value that keeps the mark's *perceived* weight
constant. They are not interchangeable.

`--beam` `#5EFDF6` is a third value used only as a glow — hover states, focus
rings, the one live figure on a race page. At 1.2:1 against white it can never
sit behind text.

## Using the wordmark

Inline the contents of `sendoff-wordmark.svg` inside an element with the
`.wordmark` class (app) or `.so-wordmark` (standalone, via `tokens.css`). The
paths are outlined, so no webfont is needed, and the two colours come from CSS
vars:

```html
<a class="wordmark" href="/" style="--wm-size: 30px;" aria-label="SendOff — home">
  <svg viewBox="-130 -130 3708.0 1317.6"> … </svg>
</a>
```

`--wm-size` sets the height; width follows the 2.81:1 aspect. On light grounds
add `.on-light` to flip both colours.

## Scale

The full lockup holds down to roughly **24px tall** — below that the pulse
line stops resolving. Use `sendoff-icon-*.svg` instead of shrinking further.
The favicon is the mark alone on its tile.

## Type

The wordmark's letterforms are outlines, not live text, so the logo needs no
font. For everything else:

| Role | Face |
|---|---|
| Display | Fraunces (headings, race names) |
| Body | Inter |
| Mono | JetBrains Mono (labels, timestamps, data) |
