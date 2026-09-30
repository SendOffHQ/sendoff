# Posting to Instagram

The feature posts can be published to SendOff's Instagram from GitHub, by
hand from the Actions tab or by Claude once you have said to post. This is the
one-time setup. It takes about fifteen minutes, all of it in Meta's and
GitHub's settings, and none of it involves pasting a token into a chat.

## How it works

- `.github/workflows/instagram-post.yml` publishes one post. You pick it from
  a list of the eighteen.
- The image is the JPEG that sendoff.run serves for that post. Instagram
  fetches it from there itself, which is why a post has to be merged and
  deployed before it can go out.
- The caption is that post's entry in `captions.md`, the same text the copy
  link on the brand page gives you.
- A dry run is the default. It checks the caption against Instagram's limits,
  checks the image is live, and proves the token works for the right account,
  all without posting.
- A post that is already on the account is refused, so the same one cannot go
  out twice by accident. Tick force if you mean to repost it.
- `.github/workflows/instagram-token.yml` refreshes the token on the 1st and
  15th of every month. Tokens last 60 days, so this keeps yours from running
  out. If that run fails, GitHub emails you, and the token needs attention
  before the next post.

## 1. Make the Instagram account a professional one

Instagram only lets professional accounts (Business or Creator) publish
through its API. In the Instagram app go to Settings, then Account type and
tools, then Switch to professional account. Either type works. This costs
nothing, and it adds insights to the account.

## 2. Create a Meta app

1. Go to <https://developers.facebook.com/apps> and sign in. Register as a
   developer if it asks.
2. Create an app. When asked for a use case, pick the one for managing
   messaging and content on Instagram.
3. In the app, open the Instagram product's API setup with Instagram
   business login.

Meta renames these screens every so often. The thing to look for is
**Instagram API with Instagram Login**, not the older Facebook Login route,
which needs a Facebook Page.

## 3. Let the app use your account

While the app is in development mode, it can only act for accounts that have
a role on it, and that is all this needs: it posts to your own account and
nobody else's. No app review is needed for that.

1. In the app, go to App roles, then Roles, and add SendOff's Instagram
   account as an **Instagram tester**.
2. Accept the invite from the Instagram side. It is under Settings, then
   Website permissions or Apps and websites, then Tester invites. On the web
   it is at instagram.com under Settings, Apps and websites.

## 4. Generate the token

Back in the API setup screen, under Generate access tokens, add the account
and sign in with it. Meta shows you two things:

- the account's **Instagram user ID**, a long number
- a **long-lived access token**, good for 60 days

Keep that page open for the next step. Do not paste the token anywhere else.

## 5. Put them in GitHub

In the repository on GitHub, go to Settings, then Secrets and variables,
then Actions, then New repository secret. Add two:

| Name | Value |
|---|---|
| `IG_USER_ID` | the Instagram user ID |
| `IG_ACCESS_TOKEN` | the access token |

Only the two workflows above can read them. They never appear in a log, and
nothing in a session can read them back.

## 6. Optional: let the token refresh save itself

A refresh sometimes comes back with a new token, which has to be written back
into `IG_ACCESS_TOKEN`. The workflow's own GitHub token is not allowed to
write secrets, so without this the refresh fails and emails you instead, and
you generate a token again as in step 4.

To make that automatic:

1. On GitHub go to your Settings, then Developer settings, then Personal
   access tokens, then Fine-grained tokens, then Generate new token.
2. Repository access: only `sendoffhq/sendoff`.
3. Permissions: **Secrets: Read and write**. Nothing else.
4. Add it as another repository secret called `SECRETS_WRITE_TOKEN`.

A fine-grained token expires too, a year at most. Put a reminder in your
calendar for the date you pick.

## 7. Check it

Tell Claude it is set up. Claude runs a dry run, which posts nothing and
reports the account the token is for (for example, "this would post as
@sendoff.run"). Or run it yourself: Actions, then Post to Instagram, then Run
workflow, with dry run ticked.

## Posting

Ask Claude to post one, or several over a few days. Claude confirms which one
and when before each post, because a post goes out to every follower and
cannot be quietly taken back. Or from the Actions tab: Post to Instagram, pick
the post, untick dry run, then Run workflow.

## If something goes wrong

- **"answered 404"**: the JPEG is not on sendoff.run yet. Merge, wait for
  the Pages deploy, and run it again.
- **"Invalid OAuth access token"**: the token expired or was revoked.
  Generate one again (step 4) and replace `IG_ACCESS_TOKEN`.
- **"The token is for @someone"**: `IG_USER_ID` and the token are for
  different accounts.
- **"Already posted"**: it is already up, with the link. Tick force to
  repost it on purpose.
