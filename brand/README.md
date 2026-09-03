# SendOff brand assets

Everything the app needs to render the identity. Import `tokens.css`, use one of
the ground presets, drop in the wordmark markup or an icon SVG.

## Files

| File | Use |
|---|---|
| `tokens.css` | Colour + type tokens, ground presets, wordmark component styles |
| `wordmark.html` | Reference markup for the wordmark, both grounds |
| `sendoff-icon.svg` | Mark only, `currentColor` — inherits whatever colour you set |
| `sendoff-icon-dark-bg.svg` | Mark in bright teal, for dark grounds |
| `sendoff-icon-light-bg.svg` | Mark in deep teal, for light grounds |
| `sendoff-icon-tile.svg` | Mark on the dark rounded tile — app icon, social avatar |
| `sendoff-favicon.svg` | Tile with a heavier stroke so the counter survives at 16px |

## The two-value signal

The identity teal exists at **two values, one hue**. They are not
interchangeable — a colour reads heavier on a light ground and lighter on a dark
one, so each ground gets the value that keeps the mark's *perceived* weight
constant.

| Token | Value | Ground | Contrast |
|---|---|---|---|
| `--so-signal-on-dark` | `#10BFC8` | void `#0A0F14` | 8.4 : 1 |
| `--so-signal-on-light` | `#0F8E97` | white / cream | 3.9 : 1 |

Set the ground preset on a container and everything inside picks up the right
pair:

```html
<header class="so-on-dark"> … </header>   <!-- app, live race page -->
<section class="so-on-light"> … </section> <!-- print report, marketing -->
<div class="so-on-beam"> … </div>          <!-- over the beam gradient -->
```

## Colour rules

- **`--so-beam` `#5EFDF6` is a glow, not a surface.** It sits at 1.2:1 against
  white — never put text on it. Use it for the one live number a crew scans
  first, focus rings, and the top of a gradient.
- **`--so-deep` `#0A5F68` is the surface that holds white text** at 7.3:1 (AAA).
  Buttons, panels, solid fills.
- **Semantic colours stay separate from the accent.** On-pace green, tight
  amber, and cutoff red carry state; the teal carries identity. Don't overload
  the teal to mean "good".

## Scale

The full lockup holds down to about **40px** tall. Below that the pulse line
turns to mush — switch to `sendoff-icon-*.svg` instead. The favicon uses a
heavier stroke than the display icon so its counter stays open at 16px.

## Type

| Role | Face | Notes |
|---|---|---|
| Wordmark | Poppins Italic 700 | Logo only — not for UI copy |
| Display | Anta | Stats, headings, numerals |
| Body | Public Sans | Everything readable |
| Mono | DM Mono | Labels, timestamps, data |

## Outstanding

The wordmark here is built from live text + SVG rather than outlined paths, so
it depends on Poppins loading. For print and third-party placements, export an
**outlined** wordmark from the source design file and drop it in as
`sendoff-wordmark-dark-bg.svg` / `sendoff-wordmark-light-bg.svg`. The component
version stays useful in-app because it recolours per ground and stays crisp at
any size without shipping a raster.
