# Dry run

A rehearsal for race day, at a kitchen table. Two phones and a laptop, about
forty minutes. Nobody drives anywhere.

The race is **Dry Run: Sangre**, private, on the real 16 segment Sangre course
with the real GPX and the real 38 hour cutoff. It is not on the public hub;
reach it from the hub while signed in, under your own races.

The point is not to see whether the app works. It is to find the things that
only appear when two people, two phones and a bad connection are involved at
once, while there is still time to fix them.

Work down the list. Each step says what should happen, so a step that does
something else is a finding rather than a shrug.

---

## Before you start

- [ ] Your phone and one other person's phone, both on cellular, not wifi.
- [ ] Reset the dry run to empty if it has been used before: delete every
      leg from the pit board, or ask for a fresh copy.

## 1. Access, which is the part with no workaround on race day

1. On the laptop, open the dry run and go to **Settings → Manage access**.
2. Invite your crew member as **crew**.
3. They open the invite on their phone and sign in.

   *Should happen:* the race appears in their hub. They can open the pit board.
   The nav shows Pit, Racer and Settings, not just Race.

4. Have them add themselves to the home screen.

   *Should happen:* it opens without browser chrome, and still opens after
   force-quitting the browser.

**If this step fails, nothing after it matters.** It is also the step most
likely to fail, because it is the one nobody has run.

## 2. A normal aid station

5. On their phone, on the pit board, press **Send off** for the start.
6. Wait a minute. Press **Arrived** at the first aid station.
7. Press **Send off** again.

   *Should happen:* each press shows immediately on their phone, and on your
   laptop within about ten seconds. The segment table shows Out and In times
   to the second.

## 3. The thing that actually happens at 2am

8. Put their phone in **airplane mode**.
9. Press through two more aid stations. Arrived, send off, arrived, send off.

   *Should happen:* every press is accepted with no error. The connection bar
   says the presses are held, with a count.

10. Turn airplane mode off. Do not touch anything else.

    *Should happen:* the held presses go, unprompted, within a poll. The count
    goes to zero. Your laptop shows all four in the right order with the right
    times.

11. While still offline, switch to the **Race** page.

    *Should happen:* the splits and the elevation profile are there, from the
    saved copy. The map tiles will be blank, which is expected and correct.

## 4. Mistakes, because there will be some

12. On the pit board, **edit the end time** of a segment to five minutes
    earlier.

    *Should happen:* the leg duration and everything computed from it move.
    Nothing else changes.

13. Delete a leg entirely and re-add it.

14. Change the **start time** of the race after a send-off has been logged.

    *Should happen:* the option is there at all, and every elapsed time and
    cutoff margin recomputes.

## 5. Two people at once

15. Both of you press something on **different** aid stations within a few
    seconds of each other.

    *Should happen:* both survive. Neither overwrites the other.

16. Both of you press the **same** thing at once.

    *Should happen:* one press, not two. Or a duplicate that is obvious and
    fixable, which is worth knowing now rather than then.

## 6. Racer mode, on your phone

17. Open **Racer** on your own phone. Confirm it knows which runner you are
    without being told.
18. Press the one button. Undo it inside fifteen seconds.
19. Press it again and let it stand.

    *Should happen:* the clock, the next aid station and the cutoff margin are
    all readable at arm's length, in sunlight, with one thumb.

## 7. The end

20. Log the remaining segments quickly to finish the race.
21. Open the **finish card**, try all four shapes, toggle a couple of parts
    off, and save one to the phone's camera roll.

## After

Write down what broke. Anything on this list that did not do what it says is
worth fixing before the 26th; anything that merely annoyed you is worth
writing down and leaving alone until after.

Then delete the dry run, or leave it: it is private and off the hub either way.
