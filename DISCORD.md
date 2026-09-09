# The SendOff Discord

How the server is laid out, why, and the copy that goes in it. Written
2026-09-09, before launch.

`ROADMAP.md` is what gets built. This is what gets said, and where.

---

## The constraint that decides everything else

**One person runs this, and there are not many members yet.** Every choice
below follows from that.

A new server with fifteen channels reads as abandoned within a week, because
fourteen of them are empty and the fifteenth has three messages. A new server
with five channels reads as small, which is what it is and which is fine.
Splitting conversation across channels at this size does not organise it, it
kills it: the same twenty messages that make one channel look alive make five
look dead.

So the rule is: **a channel earns its place by having something posted in it
this week.** Start with five. Add the sixth when a real conversation in
`#general` keeps happening and wants its own room, and it will be obvious when
that is.

---

## The five channels to launch with

### START HERE

**`#welcome`** — read only, nobody can post.
What SendOff is, what beta means, the links, and how to get in. One message,
pinned, edited rather than added to. Copy is below.

**`#announcements`** — read only, Jason and the webhook only.
Releases, changes, anything down. Low volume on purpose: a person who muted
this because it was chatty will not unmute it for the one message that
mattered.

### TALK

**`#general`**
Everything that is not a support question. Deliberately one room. This is where
the community either happens or does not, so it gets the widest remit.

**`#help`**
"How do I", "is it meant to do this", "I cannot sign in". Separate from
`#general` for one reason: an unanswered question is visible here, and visible
means it gets answered. Buried in `#general`, it does not.

### RACES

**`#race-feed`** — read only, webhook only.
Nobody types in here. It is the channel that gives people a reason to come back
on a weekend, and the one that will make the server feel alive before there are
enough members to do that on their own.

Built and shipped 2026-09-09. The Worker posts two things:

- **a public race is created**, with its name, where and when, and a link
- **a racer finishes one**, with their name and elapsed time, and a link

Discord unfurls the link into a preview using the race page's own social tags,
so each post carries the race's card without any of that being built twice.

Three things it deliberately does not post: **anything about an unlisted race**,
feedback, and access requests. The last two are full of names and email
addresses and belong in the admin panel where they already are. The first is the
whole point: an unlisted race's address is the only thing keeping it off the
public list.

It is off until `DISCORD_WEBHOOK` is set on the Worker. Unset, none of that code
runs.

---

## What to add second, and when

**`#crewing`**, for crewing talk that is not about SendOff at all: what to pack,
how to work a hand off, what went wrong last time. It is what turns a support
server into a community, and it is also the one most likely to sit empty on day
one.

**The trigger for adding it**: when crewing talk in `#general` has happened
three or four times and somebody has had to scroll to find it. Not before.

---

## Roles

Two, and resist a third.

- **`@Beta`** — has a SendOff account. The gate already exists (creating a race
  is invite only), so this role mirrors something real rather than inventing a
  hierarchy. Useful for one thing: pinging the people who can actually test a
  change.
- **`@Jason`** — admin. Named rather than "Staff", because there is one person
  and pretending otherwise is worse than owning it.

**Skip self-assign role menus for now.** Racer / crew / spectator sounds tidy
and buys nothing at this size: there is nobody to ping selectively, and a
reaction-role menu in an empty server is a machine with no work to do. Add it
when a ping would go to more people than would read the channel anyway.

---

## Moderation, with one person

The honest position is that nobody is watching this server most of the time.
Set it up so that is survivable rather than pretending otherwise.

**Community has to be on**, because rules screening is a Community only
feature. On a plain server the setting is not merely off, it is not in the menu
at all. Checked 2026-09-09 against Discord's own documentation.

Turning it on is not free, and these are the conditions rather than
suggestions:

- **A verified email is required** to post, at minimum. Medium (account older
  than five minutes as well) is the setting to pick: it costs a new member
  nothing and stops the throwaway accounts. High, which wants a phone number,
  is too much friction for a running club.
- **The explicit media filter is forced to scan everything**, from every
  member. No say in it.
- **Moderators must have two factor authentication** to take moderation
  actions. With one admin that means Jason's own account, and it should have
  had 2FA anyway.
- **Two channels are mandated**: a rules channel, and a Community Updates
  channel that only moderators can see, where Discord posts admin notices. So
  the server has seven channels, five of which a member can see. The five
  above are still the five that matter.

Community is **not** the same as Discovery. Turning it on does not list the
server in Discord's public directory; that is a separate opt in with its own
requirements. The server stays invite only.

The rest:

- **AutoMod on** for spam, mention spam and invite links. Discord's built in
  rules are enough; a moderation bot is another dependency to keep alive.
- **Slow mode off** everywhere. It solves a problem this server does not have.
- Nothing that pings `@everyone` except Jason.

**If Community is not turned on**, the fallback is a plain `#rules` channel
with a pinned message. It is worth having either way, but be clear about what
it is not: nobody has to read it, nobody has to accept it, and a new account
can post the moment it joins. The gate is the whole value, and the gate needs
Community.

---

## The one that is easy to get wrong: bugs

**Bug reports should keep going through the in-app feedback button, not
Discord.** This is worth being firm about because the instinct is the other
way.

The in-app button already captures the page, the race, the app version, whether
the device was offline, how many writes were queued, and the browser, and it
lands in the admin panel with a count. A Discord message captures a person's
memory of what happened. On the offline path especially, that difference is the
difference between fixing something and guessing at it.

So `#help` is for questions, and its pinned message points at the in-app button
for anything broken. When somebody reports a bug in Discord anyway, which they
will, the useful reply is a thank you and a nudge to press the button from the
page it happened on, so the context comes with it.

---

## The thing to say about unlisted races

Somebody will paste a race link. If that race is unlisted, pasting it in a
public Discord is what un-unlists it: the address is the only thing keeping it
off the public list, and now the address is in a searchable channel.

That belongs in `#welcome` rather than in a rule nobody reads, and it is in the
copy below.

---

## Copy

### `#welcome`

> # SendOff
>
> Live crew tracking for ultras. Your crew works one board at the aid station,
> and everyone back home watches the splits land live.
>
> **sendoff.run**
>
> **SendOff is in beta.** It has run real races and the crew work is solid, but
> it moves week to week and you will find rough edges.
>
> **Watching a race needs nothing.** No account, no app. Anyone with the link
> can follow along, and every public race stays readable forever.
>
> **Running a race of your own is invite only** while the beta lasts. Ask at
> sendoff.run and you will get an answer.
>
> **Found something broken?** Use the feedback button inside the app rather
> than posting here. It sends the page, the race and the version with your
> message, which is usually what makes a bug fixable. `#help` is for questions.
>
> **One thing worth knowing before you paste a link.** A race marked unlisted
> is kept off the public list, but its address is the only thing keeping it
> there. Pasting that link in here makes it public in practice. Public races,
> paste away.
>
> Terms: sendoff.run/terms.html · Privacy: sendoff.run/privacy.html

### Rules screen

Four, because nobody reads seven.

> 1. **Be decent.** Crewing is a kind sport. Keep it that way.
> 2. **No medical advice.** Share what worked for you, not what somebody else
>    should do with their body. Nobody here is your doctor.
> 3. **Do not post somebody else's race data or address** without asking them.
>    That includes screenshots with names in.
> 4. **No promotion** unless it is a race you are running, crewing or putting
>    on.

### First post in `#announcements`

> This server is new, and so is SendOff.
>
> What is here: the app, at sendoff.run, and the people using it. Right now
> that is a small number of us.
>
> What is coming: **Sangre de Cristo 100 on 26 September.** That is the race
> this whole thing was built for, after a DNF there in 2025. It will be logged
> live in SendOff, and `#race-feed` will post as it happens. If you want to see
> what the app actually does under load, that weekend is the one to watch.

---

## Launch order

1. Turn on Community first. It mandates a rules channel and a Community
   Updates channel, so doing it before you build anything saves rearranging.
2. Create the five member facing channels and the two roles. Set rules
   screening, verification Medium, AutoMod.
3. Post `#welcome`, pin it, lock the channel.
4. Post the `#announcements` message.
5. Create the `#race-feed` webhook (Server Settings, Integrations, Webhooks)
   and put its URL in the Worker with `wrangler secret put DISCORD_WEBHOOK`.
   Never in this repository: Discord resets webhooks it finds in public repos,
   and anyone holding the URL can post to the channel as SendOff. Until the
   secret is set the feature is inert, so there is no rush to do this before
   the rest.
6. Invite ten people you know. Not more. A server that is quiet with ten feels
   small; quiet with two hundred feels dead.

The race on the 26th is the launch. Everything before it is setting the table.
