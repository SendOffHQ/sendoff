// Publishes one of the feature posts to Instagram.
//
//   node tools/instagram-post.mjs <post> [--dry-run] [--force]
//
// <post> is a feature id from brand/social/features.html, e.g. live-race.
// The image is the JPEG sendoff.run already serves for it, and the caption is
// that post's entry in brand/social/captions.md, read by the same parser the
// contact sheet copies from. Nothing about a post is typed at posting time.
//
// Runs in .github/workflows/instagram-post.yml, which holds the credentials:
//   IG_USER_ID       the Instagram professional account's id
//   IG_ACCESS_TOKEN  a long-lived token with instagram_business_basic and
//                    instagram_business_content_publish
// Neither is ever printed. --dry-run needs neither and sends nothing.
//
// The API is Instagram's own content publishing, with Instagram Login:
// create a container from an image URL, wait for it to finish, publish it.
// Instagram fetches the image itself, which is why it has to be the public
// URL and not a file from this checkout.
import fs from 'node:fs';
import path from 'node:path';
import { parseCaptions, captionProblems } from '../brand/social/captions.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SOCIAL = path.join(ROOT, 'brand', 'social');
export const IMAGE_BASE = process.env.IMAGE_BASE || 'https://sendoff.run/brand/social';
const API = `https://graph.instagram.com/${process.env.IG_API_VERSION || 'v23.0'}`;

// The post as it would go out, checked, without touching the network.
export function preparePost(id, { md } = {}) {
  if (!/^[a-z0-9-]+$/.test(String(id || ''))) throw new Error(`Not a post id: ${JSON.stringify(id)}`);
  const png = `sendoff-feature-${id}.png`;
  const jpg = `sendoff-feature-${id}.jpg`;
  const captions = parseCaptions(md != null ? md : fs.readFileSync(path.join(SOCIAL, 'captions.md'), 'utf8'));
  const caption = captions[png];
  if (!caption) throw new Error(`No caption for ${png} in captions.md`);
  const problems = captionProblems(caption);
  if (problems.length) throw new Error(`Caption for ${id}: ${problems.join('; ')}`);
  if (md == null && !fs.existsSync(path.join(SOCIAL, jpg))) {
    throw new Error(`${jpg} is not in brand/social. Run shoot-features.js and commit it.`);
  }
  return { id, caption, imageUrl: `${IMAGE_BASE}/${jpg}` };
}

// Instagram's errors come back as { error: { message, code, ... } }. Only the
// message and code are repeated: the request itself carries the token.
async function call(fetchImpl, method, url, params) {
  const body = new URLSearchParams(params);
  const res = method === 'GET'
    ? await fetchImpl(`${url}?${body}`)
    : await fetchImpl(url, { method, body });
  let json = null;
  try { json = await res.json(); } catch (e) {}
  if (!res.ok || !json || json.error) {
    const e = json && json.error;
    throw new Error(`Instagram said ${res.status}: ${e ? `${e.message} (code ${e.code})` : 'no readable answer'}`);
  }
  return json;
}

// Who the token belongs to, and that it is the account IG_USER_ID names. A
// dry run does this when the credentials are there, so a setup can be proved
// without posting anything.
export async function verify({ userId, token, fetchImpl = fetch } = {}) {
  if (!userId || !token) throw new Error('IG_USER_ID and IG_ACCESS_TOKEN are both needed.');
  const me = await call(fetchImpl, 'GET', `${API}/me`, { fields: 'user_id,username', access_token: token });
  if (String(me.user_id) !== String(userId)) {
    throw new Error(`The token is for @${me.username}, whose id is ${me.user_id}, but IG_USER_ID is ${userId}.`);
  }
  return { username: me.username };
}

export async function publish(post, { userId, token, fetchImpl = fetch, force = false,
                                     wait = ms => new Promise(r => setTimeout(r, ms)), log = console.log } = {}) {
  if (!userId || !token) throw new Error('IG_USER_ID and IG_ACCESS_TOKEN are both needed to publish.');

  // Instagram has to be able to fetch the image, so check it can first. A 404
  // here is a post that was never merged, or a deploy that has not finished.
  const head = await fetchImpl(post.imageUrl, { method: 'HEAD' });
  const type = head.headers.get('content-type') || '';
  if (!head.ok || !/^image\/jpeg/.test(type)) {
    throw new Error(`${post.imageUrl} answered ${head.status} ${type || '(no type)'}; Instagram needs a public JPEG.`);
  }

  // The same post twice is the mistake nobody can take back quietly: a
  // repost is visible to every follower before it is deleted. The hook line
  // is unique per post, so a recent post starting with it means this one is
  // already up. --force is for the day that is on purpose.
  if (!force) {
    const hook = post.caption.split('\n')[0].trim();
    const recent = await call(fetchImpl, 'GET', `${API}/${userId}/media`,
      { fields: 'caption,permalink,timestamp', limit: '50', access_token: token });
    const dup = (recent.data || []).find(m => (m.caption || '').trim().startsWith(hook));
    if (dup) throw new Error(`Already posted ${dup.timestamp}: ${dup.permalink}. Pass --force to post it again.`);
  }

  const container = await call(fetchImpl, 'POST', `${API}/${userId}/media`,
    { image_url: post.imageUrl, caption: post.caption, access_token: token });
  log(`container ${container.id} created`);

  // Instagram processes the image before it can be published. Usually
  // seconds; give it two minutes before calling it stuck.
  for (let i = 0; ; i++) {
    const s = await call(fetchImpl, 'GET', `${API}/${container.id}`, { fields: 'status_code', access_token: token });
    if (s.status_code === 'FINISHED') break;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') {
      throw new Error(`Instagram could not process the image: ${s.status_code}`);
    }
    if (i >= 24) throw new Error(`Still ${s.status_code || 'processing'} after two minutes; nothing was published.`);
    await wait(5000);
  }

  const done = await call(fetchImpl, 'POST', `${API}/${userId}/media_publish`,
    { creation_id: container.id, access_token: token });
  let permalink = null;
  try {
    permalink = (await call(fetchImpl, 'GET', `${API}/${done.id}`, { fields: 'permalink', access_token: token })).permalink;
  } catch (e) { /* published either way; the link is a nicety */ }
  return { mediaId: done.id, permalink };
}

// The command line. Only when run directly, so the test can import the above.
if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const args = process.argv.slice(2);
  const id = args.find(a => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  try {
    const post = preparePost(id);
    console.log(`post:  ${post.id}`);
    console.log(`image: ${post.imageUrl}`);
    console.log(`caption (${[...post.caption].length} characters):\n\n${post.caption}\n`);
    if (dryRun) {
      const head = await fetch(post.imageUrl, { method: 'HEAD' });
      const type = head.headers.get('content-type') || '';
      if (!head.ok || !/^image\/jpeg/.test(type)) {
        throw new Error(`${post.imageUrl} answered ${head.status} ${type || '(no type)'}; Instagram needs a public JPEG.`);
      }
      console.log('Image is live and a JPEG.');
      if (process.env.IG_USER_ID && process.env.IG_ACCESS_TOKEN) {
        const { username } = await verify({ userId: process.env.IG_USER_ID, token: process.env.IG_ACCESS_TOKEN });
        console.log(`Credentials work: this would post as @${username}.`);
      }
      console.log('Dry run: checked and not sent.');
    } else {
      const out = await publish(post, {
        userId: process.env.IG_USER_ID, token: process.env.IG_ACCESS_TOKEN,
        force: args.includes('--force')
      });
      console.log(`Published: ${out.permalink || 'media ' + out.mediaId}`);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
