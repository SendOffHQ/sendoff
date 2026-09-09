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

## `founder.jpg`

Jason on a trail, 751 x 751. Re-encoded on the way in, which strips every
metadata block: a trail selfie is exactly the kind of photograph that carries
GPS, and this one is in a public repository. The source had no GPS block and
the committed file has no EXIF at all. Check that again for any replacement.

It renders at 300px, capped to 72vw so it never outgrows a narrow phone, which
is about 2.5x density on this file. Square is the shape to use: it fills the
circle exactly and only the corners are clipped, so anything near the centre is
safe, and a photograph with a scene in it survives at that size in a way a
headshot does not need to.

If a replacement is not square, `object-position: center 38%` biases the crop
upward, toward a face rather than a chest.

If the file is ever missing, the page falls back to a monogram rather than a
broken image, so it degrades to something that looks intentional.
