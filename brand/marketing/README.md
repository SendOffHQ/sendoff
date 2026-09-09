# Marketing images

What the landing page at the site root shows. Nothing here is used by the app.

## The screenshots

`shot-pit.png` and `shot-race.png` are captured from the real app, not drawn.
Regenerate them with:

    npm run shots

That starts `test/harness.mjs`, drives a real Chromium at phone size, and
writes both files. Two things about how it does it are deliberate:

- **The race is `six-0-trail-marathon`.** Real, finished, public, and the
  founder's own, so no other person's name ends up on a marketing page.
- **The crew shot is replayed mid-race.** The pit board's whole point is the
  one big button you press with your hands full, and a finished race does not
  show it, so the clock is pinned to 14:15Z and that race's own logged legs are
  truncated to the ones that had happened by then. Nothing is invented: it is
  this race's data, shown at the moment it was true.

Both are quantised to a 256 colour palette afterwards, which costs nothing
visible on a flat dark interface and saves about two thirds of the bytes.
Resizing them instead makes them *larger*, because resampling adds noise.

## `founder.jpg` is missing on purpose

The landing page wants a photograph of Jason at
`brand/marketing/founder.jpg`. There is no placeholder committed, because a
stand-in photograph of a real person is worse than none: until the real file is
dropped in, the page falls back to a monogram, which looks intentional rather
than broken.

Square, and 240px on a side is enough (it renders at 120px).
