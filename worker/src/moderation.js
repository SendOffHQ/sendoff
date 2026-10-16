// Foul language in a race's name, checked when a race is made or renamed.
//
// A name that trips this is held, not refused: the race is made and works for
// everybody on it, and stays off the hub, the share cards and the Discord
// post until an admin has looked. So the list leans towards catching the
// clearly foul and leaving the merely salty alone. "Hellgate", "Badass 50K"
// and "Dick Collins Firetrails" are real races and pass; a false alarm costs
// a race a few hours off the hub, and a miss puts a slur on the front page.
//
// The words are spelled out because a list that has to be decoded to be
// checked is a list nobody checks. They are matched three ways:
//   ANYWHERE  inside any word: "bullshit", "clusterfuck"
//   START     at the start of a word: "bitching", "wankers"
//   WHOLE     as the whole word, give or take an ending: "cocks" but not
//             "Cockeysville", "cum" but not "Cumberland"
// after the name is lowered, stripped of accents, read through the usual
// stand-ins (0 for o, 1 and ! for i, $ for s, @ for a), spaced-out letters
// joined back up ("f u c k", "s.h.i.t"), stretched letters squeezed ("fuuuck")
// and starred-out vowels filled in ("f*ck", "sh*t").

const ANYWHERE = ['fuck', 'shit', 'nigg'];
const START = ['bitch', 'bastard', 'asshole', 'arsehole', 'dickhead', 'cunt', 'wank', 'whore', 'slut',
  'faggot', 'retard', 'cocksuck', 'pussy', 'dildo', 'blowjob', 'handjob', 'jizz', 'biatch', 'phuck'];
const WHOLE = ['cock', 'twat', 'prick', 'cum', 'fag', 'tits', 'titty', 'piss', 'arse', 'fuk', 'fck', 'fuq',
  'tranny', 'kike', 'spic', 'spick', 'chink', 'gook', 'wetback', 'raghead', 'towelhead', 'beaner', 'paki',
  'nazi', 'nazis', 'hitler', 'kkk', 'rape', 'rapist', 'porn', 'porno', 'jackass', 'dumbass'];

const STAND_INS = { '0': 'o', '1': 'i', '!': 'i', '|': 'i', '3': 'e', '4': 'a', '@': 'a', '$': 's', '5': 's', '7': 't', '+': 't' };

// The words of a name, as the checks below read them.
function words(name) {
  const s = String(name == null ? '' : name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[01!|34@$57+]/g, c => STAND_INS[c]);
  const out = [];
  let run = '';
  for (const w of s.split(/[^a-z*]+/).filter(Boolean)) {
    // Single letters in a row are one word spaced out.
    if (w.length === 1) { run += w; continue; }
    if (run) { out.push(run); run = ''; }
    out.push(w);
  }
  if (run) out.push(run);
  return out;
}

// Each way a word might be read: as written, with stretched letters squeezed,
// and with up to two starred-out letters filled in with each vowel.
function readings(w) {
  let forms = [w];
  const stars = (w.match(/\*/g) || []).length;
  if (stars && stars <= 2) {
    forms = [];
    const fill = (s) => {
      if (!s.includes('*')) { forms.push(s); return; }
      for (const v of 'aeiou') fill(s.replace('*', v));
    };
    fill(w);
  }
  forms = forms.map(f => f.replace(/\*/g, ''));
  return [...new Set(forms.flatMap(f => [f, f.replace(/(.)\1+/g, '$1')]))];
}

// The word with a plural or a verb ending taken off, for WHOLE.
function stems(w) {
  return [...new Set([w, w.replace(/(ings|ing|ers|er|es|ed|s)$/, '')])];
}

// The listed words a name trips, or [] for a clean one.
export function nameProblems(name) {
  const hit = new Set();
  for (const w of words(name)) {
    for (const r of readings(w)) {
      for (const bad of ANYWHERE) if (r.includes(bad)) hit.add(bad);
      for (const bad of START) if (r.startsWith(bad)) hit.add(bad);
      for (const s of stems(r)) if (WHOLE.includes(s)) hit.add(s);
    }
  }
  return [...hit];
}
