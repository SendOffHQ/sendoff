// Reads captions.md. The one parser for it, used by the contact sheet's copy
// links and by tools/instagram-post.mjs, so the caption somebody copies and
// the caption that gets published cannot come out different.
//
// A caption is the text between a heading of the form
//   ## 3. Race photos (`sendoff-feature-photos.png`)
// and the next "---" rule, trimmed. That is exactly what goes on the post.
//
// A post made with somebody else, shown on their profile as well as ours,
// names them on a line of its own straight under the heading:
//   Collaborators: @joe_rucco
// That line is not part of the caption: Instagram sends them an invite to
// accept, and the caption mentions them by name if it wants to.

export function parsePosts(md) {
  const out = {};
  for (const block of String(md).split(/^---\s*$/m)) {
    const m = block.match(/^##\s.*\(`([^`]+)`\)\s*$/m);
    if (!m) continue;
    let caption = block.slice(block.indexOf(m[0]) + m[0].length).trim();
    let collaborators = [];
    const c = caption.match(/^Collaborators:[ \t]*([^\n]*)(\n|$)/);
    if (c) {
      collaborators = c[1].split(/[\s,]+/).map(s => s.replace(/^@/, '')).filter(Boolean);
      caption = caption.slice(c[0].length).trim();
    }
    out[m[1]] = { caption, collaborators };
  }
  return out;
}

export function parseCaptions(md) {
  return Object.fromEntries(Object.entries(parsePosts(md)).map(([k, v]) => [k, v.caption]));
}

// Instagram takes up to three, by username.
export function collaboratorProblems(list) {
  const problems = [];
  if (list.length > 3) problems.push(`${list.length} collaborators, over 3`);
  for (const u of list) if (!/^[A-Za-z0-9._]{1,30}$/.test(u)) problems.push(`not an Instagram username: ${u}`);
  return problems;
}

// What Instagram will refuse, checked before anything is sent: 2,200
// characters and 30 hashtags. Counted the way Instagram counts, by character
// rather than by UTF-16 unit, so an emoji is one.
export const LIMITS = { chars: 2200, hashtags: 30 };

export function captionProblems(text) {
  const problems = [];
  const chars = [...String(text)].length;
  const tags = (String(text).match(/(^|\s)#[\p{L}\p{N}_]+/gu) || []).length;
  if (!chars) problems.push('empty');
  if (chars > LIMITS.chars) problems.push(`${chars} characters, over ${LIMITS.chars}`);
  if (tags > LIMITS.hashtags) problems.push(`${tags} hashtags, over ${LIMITS.hashtags}`);
  if (/^##\s|^---\s*$/m.test(text)) problems.push('markdown leaked into the caption');
  return problems;
}
