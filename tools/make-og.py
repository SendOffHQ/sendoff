#!/usr/bin/env python3
"""Build the shareable per-race pages and their social-preview images.

Writes:
  brand/og-default.png          generic card, used by every page without its own
  races/<slug>/og.png           per-race card: name, date, location, distance, runner
  races/<slug>/index.html       the URL to hand a spectator; carries that race's
                                Open Graph tags, then forwards into the app

race.html is a single static file serving every race off ?id=, so it can only
ever carry one set of preview tags. Crawlers do not run JS, which rules out
setting them client-side. Hence one small real page per race.

Run from the repo root after adding or renaming a race:
    python3 tools/make-og.py

Needs headless Chromium. Fonts are fetched once into .ogcache/ (gitignored);
the brand artwork and colours come from brand/ so the cards can't drift from
the rest of the identity.
"""
import json, pathlib, re, subprocess, sys, urllib.request
from datetime import datetime

ROOT  = pathlib.Path(__file__).resolve().parent.parent
CACHE = ROOT / '.ogcache'
UA    = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
W, H  = 1200, 630
BASE  = 'https://sendoff.run'

CHROME_CANDIDATES = [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
]
FONTS = {
    'bc-600.woff2':   'Barlow+Condensed:wght@600',
    'bc-700.woff2':   'Barlow+Condensed:wght@700',
    'bci-600.woff2':  'Barlow+Condensed:ital,wght@1,600',
    'plex-400.woff2': 'IBM+Plex+Sans:wght@400',
    'jb-500.woff2':   'JetBrains+Mono:wght@500',
}

STUB = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title} · SendOff</title>
<meta name="theme-color" content="#0a0f14">
<meta name="description" content="{desc}">
<link rel="canonical" href="{base}/races/{slug}/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="SendOff">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="{base}/races/{slug}/">
<meta property="og:image" content="{base}/races/{slug}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="{title}: follow live on SendOff">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{desc}">
<meta name="twitter:image" content="{base}/races/{slug}/og.png">
<link rel="icon" href="/brand/sendoff-favicon.svg" type="image/svg+xml">
<link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png">
<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="apple-mobile-web-app-title" content="SendOff">
<style>
  html,body{{margin:0;height:100%;background:#0A0F14;color:#F0ECE3;
    font-family:"IBM Plex Sans",ui-sans-serif,system-ui,sans-serif}}
  main{{height:100%;display:flex;flex-direction:column;align-items:center;
    justify-content:center;gap:14px;text-align:center;padding:24px}}
  a{{color:#0FB8BF}}
</style>
<script>
  // Forward into the app, carrying any share token through untouched.
  var q = location.search.replace(/^\?/, '');
  location.replace('/race.html?id={slug}' + (q ? '&' + q : '') + location.hash);
</script>
</head>
<body>
<main>
  <p>Opening {title}…</p>
  <p><a href="/race.html?id={slug}">Continue to the race &rarr;</a></p>
</main>
</body>
</html>
"""

def chrome():
    for c in CHROME_CANDIDATES:
        if pathlib.Path(c).exists():
            return c
    sys.exit('No Chromium found; set one of: ' + ', '.join(CHROME_CANDIDATES))

def fetch(url, **kw):
    return urllib.request.urlopen(
        urllib.request.Request(url, headers={'User-Agent': UA}), timeout=30, **kw).read()

def ensure_fonts():
    CACHE.mkdir(exist_ok=True)
    for name, spec in FONTS.items():
        out = CACHE / name
        if out.exists():
            continue
        css = fetch(f'https://fonts.googleapis.com/css2?family={spec}&display=swap').decode()
        block = css.split('/* latin */')[-1]
        m = re.search(r'src: url\((https://[^)]+)\)', block)
        if not m:
            sys.exit(f'Could not resolve a latin subset for {spec}')
        out.write_bytes(fetch(m.group(1)))
        print(f'  cached {name}')

def b64(name):
    import base64
    return base64.b64encode((CACHE / name).read_bytes()).decode()

def wordmark():
    """Inline the lockup, carrying the source file's own viewBox so a change to
    the artwork's bounds can never leave the cards cropping it."""
    svg = (ROOT / 'brand' / 'sendoff-wordmark.svg').read_text().strip()
    m = re.search(r'viewBox="([^"]+)"', svg)
    if not m:
        sys.exit('sendoff-wordmark.svg has no viewBox')
    return re.sub(r'^<svg[^>]*>',
                  f'<svg viewBox="{m.group(1)}" role="img" aria-label="SendOff">', svg)

def esc(s):
    return (str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))

def pretty_date(iso):
    if not iso:
        return ''
    try:
        return datetime.fromisoformat(iso).strftime('%b %-d, %Y')
    except Exception:
        return iso[:10]

def split_accent(name):
    """Last word of a race name becomes the signal-coloured accent."""
    parts = str(name).split()
    return (' '.join(parts[:-1]), parts[-1]) if len(parts) > 1 else (name, '')

def elevation_path(slug, width, height, samples=280):
    """The course, as an SVG area path, from that race's own GPX.

    lib/finish-card.js puts it plainly: "The elevation profile is the hero
    rather than a logo, because the shape of the course is the part that says
    which race this was." The same is true of a link preview. Without it every
    race's card is the same picture with a different name on it.

    Drawn from the elevation series alone, evenly spaced, rather than against
    real distance. At 1200px wide across a whole hundred miler the difference
    is invisible, and it keeps this to one regular expression.

    Returns None when there is no GPX or nothing usable in it, and the card
    falls back to the plain layout. A missing course file is not a reason to
    fail a build.
    """
    gpx = ROOT / 'races' / slug / 'course.gpx'
    if not gpx.exists():
        return None
    try:
        eles = [float(m) for m in re.findall(r'<ele>\s*(-?[\d.]+)\s*</ele>', gpx.read_text(errors='ignore'))]
    except Exception:
        return None
    if len(eles) < 8:
        return None

    # Down to a drawable number of points, by taking the max of each bucket so
    # summits survive: averaging a hundred miler into 280 points flattens the
    # climbs that are the whole character of the course.
    step = len(eles) / samples
    pts = [max(eles[int(i * step):max(int((i + 1) * step), int(i * step) + 1)])
           for i in range(samples)]
    lo, hi = min(pts), max(pts)
    if hi - lo < 1:
        return None

    def xy(i, e):
        x = i * width / (len(pts) - 1)
        y = height - (e - lo) / (hi - lo) * height
        return f'{x:.1f},{y:.1f}'

    line = ' '.join(xy(i, e) for i, e in enumerate(pts))
    return (f'<svg viewBox="0 0 {width} {height}" preserveAspectRatio="none" '
            f'width="{width}" height="{height}">'
            f'<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">'
            f'<stop offset="0%" stop-color="#0FB8BF" stop-opacity=".05"/>'
            f'<stop offset="100%" stop-color="#0FB8BF" stop-opacity=".26"/>'
            f'</linearGradient></defs>'
            f'<polygon points="0,{height} {line} {width},{height}" fill="url(#g)"/>'
            f'<polyline points="{line}" fill="none" stroke="#0FB8BF" stroke-opacity=".42" '
            f'stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/></svg>')


def card_html(title_main, title_accent, meta_line, kicker, profile=None):
    faces = "\n".join([
      f"@font-face{{font-family:'BC';font-weight:600;src:url(data:font/woff2;base64,{b64('bc-600.woff2')}) format('woff2')}}",
      f"@font-face{{font-family:'BC';font-weight:700;src:url(data:font/woff2;base64,{b64('bc-700.woff2')}) format('woff2')}}",
      f"@font-face{{font-family:'BC';font-weight:600;font-style:italic;src:url(data:font/woff2;base64,{b64('bci-600.woff2')}) format('woff2')}}",
      f"@font-face{{font-family:'Plex';src:url(data:font/woff2;base64,{b64('plex-400.woff2')}) format('woff2')}}",
      f"@font-face{{font-family:'JB';src:url(data:font/woff2;base64,{b64('jb-500.woff2')}) format('woff2')}}",
    ])
    accent = f' <em>{esc(title_accent)}</em>' if title_accent else ''
    profile_html = f'<div class="profile">{profile}</div>' if profile else ''
    return f"""<!DOCTYPE html><html><head><meta charset="utf-8"><style>
{faces}
*{{margin:0;padding:0;box-sizing:border-box}}
html,body{{width:{W}px;height:{H}px;overflow:hidden}}
body{{
  background:
    radial-gradient(ellipse 900px 460px at 10% 4%, rgba(94,253,246,0.16), transparent 62%),
    radial-gradient(ellipse 760px 380px at 92% 96%, rgba(15,184,191,0.22), transparent 62%),
    linear-gradient(165deg,#0C141B 0%,#0A0F14 62%);
  color:#F0ECE3; font-family:'Plex',sans-serif;
  padding:66px 72px; display:flex; flex-direction:column; justify-content:space-between;
  /* The profile is positioned against the card. Without this it resolves
     against the viewport, which render() deliberately makes 220px taller than
     the card before cropping, so the course ended up below the crop. Body is
     border-box at exactly {W}x{H} with no border, so its padding box is the
     card edge to edge, which is what the profile wants to bleed to. */
  position:relative;
  --wm-signal:#0FB8BF; --wm-letter:#F0ECE3;
}}
.top{{display:flex;align-items:center;justify-content:space-between;gap:30px}}
.wm svg{{height:52px;width:auto;display:block;overflow:visible}}
.kicker{{font-family:'JB',monospace;font-size:19px;letter-spacing:.24em;text-transform:uppercase;color:#0FB8BF}}
h1{{font-family:'BC',sans-serif;font-weight:700;font-size:112px;line-height:.96;letter-spacing:-.015em}}
h1 em{{font-style:italic;font-weight:600;color:#0FB8BF}}
.meta{{font-family:'JB',monospace;font-size:26px;letter-spacing:.05em;color:#9DB0BC}}
.rule{{height:5px;width:132px;background:#0FB8BF;margin-bottom:30px}}
.mid{{display:flex;flex-direction:column;justify-content:center;flex:1;padding:26px 0}}
/* The course runs the full width along the bottom, behind the meta line and
   under the title. Bled to the edges on purpose: it is the ground the card
   sits on rather than a chart somebody is meant to read values off. */
.profile{{position:absolute;left:0;right:0;bottom:0;height:210px;z-index:0;pointer-events:none}}
.profile svg{{display:block;width:100%;height:100%}}
.top,.mid,.meta{{position:relative;z-index:1}}
.meta{{text-shadow:0 2px 14px rgba(10,15,20,.85)}}
</style></head><body>
  {profile_html}
  <div class="top"><span class="wm">{wordmark()}</span><span class="kicker">{esc(kicker)}</span></div>
  <div class="mid"><div class="rule"></div><h1>{esc(title_main)}{accent}</h1></div>
  <div class="meta">{esc(meta_line)}</div>
</body></html>"""

def render(html, out_path):
    """Headless Chromium sizes --window-size as the OS window, so the viewport
    comes out ~87px shorter than asked. Render with generous slack and crop the
    card out of the top-left, which is exact regardless of that chrome height."""
    from PIL import Image
    tmp = CACHE / 'card.html'
    tmp.write_text(html, encoding='utf-8')
    out_path.parent.mkdir(parents=True, exist_ok=True)
    raw = CACHE / 'raw.png'
    subprocess.run([chrome(), '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
                    '--force-device-scale-factor=1', '--virtual-time-budget=8000',
                    f'--window-size={W},{H + 220}',
                    f'--screenshot={raw}', f'file://{tmp}'],
                   check=True, capture_output=True)
    im = Image.open(raw)
    if im.size != (W, H):
        im = im.crop((0, 0, W, H))
    im.convert('RGB').save(out_path, optimize=True)
    print(f'  {out_path.relative_to(ROOT)}  {im.size[0]}x{im.size[1]}  ({out_path.stat().st_size} bytes)')

def main():
    ensure_fonts()
    index = json.loads((ROOT / 'races' / 'index.json').read_text())

    render(card_html('Send them out', 'Bring them home',
                     'Live crew tracking for ultras · sendoff.run', 'Race hub'),
           ROOT / 'brand' / 'og-default.png')

    for race in index.get('races', []):
        slug = race['slug']
        bits = [pretty_date(race.get('startTime')), race.get('location') or '']
        if race.get('totalDistanceMi'):
            d = race['totalDistanceMi']
            bits.append(f"{d:g} mi")
        runners = race.get('runnerNames') or []
        if runners:
            bits.append(' · '.join(runners))
        meta_line = ' · '.join(b for b in bits if b)
        main_t, accent = split_accent(race.get('name', slug))
        render(card_html(main_t, accent, meta_line, 'Follow live',
                         profile=elevation_path(slug, W, 210)),
               ROOT / 'races' / slug / 'og.png')

        name = race.get('name', slug)
        desc = (f"{meta_line}: follow live on SendOff." if meta_line
                else "Follow live on SendOff.")
        stub = ROOT / 'races' / slug / 'index.html'
        stub.write_text(STUB.format(slug=slug, title=esc(name), desc=esc(desc), base=BASE),
                        encoding='utf-8')
        print(f'  {stub.relative_to(ROOT)}')

if __name__ == '__main__':
    main()
