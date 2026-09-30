// Reads captions.md. The one parser for it, used by the contact sheet's copy
// links and by tools/instagram-post.mjs, so the caption somebody copies and
// the caption that gets published cannot come out different.
//
// A caption is the text between a heading of the form
//   ## 3. Race photos (`sendoff-feature-photos.png`)
// and the next "---" rule, trimmed. That is exactly what goes on the post.

export function parseCaptions(md) {
  const out = {};
  for (const block of String(md).split(/^---\s*$/m)) {
    const m = block.match(/^##\s.*\(`([^`]+)`\)\s*$/m);
    if (!m) continue;
    out[m[1]] = block.slice(block.indexOf(m[0]) + m[0].length).trim();
  }
  return out;
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
