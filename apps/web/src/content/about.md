# About Hexstory

**Every place has a story.** Hexstory is a map of the world cut into hexagons. Pick any hexagon and you can read
what people say happened there (protests, battles, discoveries, celebrations, everyday history) and talk
with whoever else is looking at the same place right now.

## How it works

- **Stories** are short accounts of events, written by anyone. Each one names the regions it covers, when it
  happened, and at least one source. Stories are listed with the most recent events first.
- **The Square** is the live conversation for each hexagon. It's public, so be kind. New accounts can post
  after {{chatMinAccountMinutes}} minutes.
- **Versions**: every edit is kept. Nothing is ever overwritten, and any change can be undone.

## Roles

Anyone can write, but trust is earned. Everyone starts as a Newcomer and moves up automatically as their
contributions are accepted. You can see your role and how close you are to the next one on
[your account page](/me).

- **Newcomer**: everyone who has just signed in. You can write stories, suggest edits and chat. Your new
  stories stay private until a reviewer approves them, and your edits wait for a reviewer.
- **Member**: after {{promotion.member.minAgeDays}} days, once you've contributed accepted text to
  {{promotion.member.minStories}} different published stories. Your stories and edits go live straight away.
- **Reviewer**: after {{promotion.reviewer.minAgeDays}} days, once you've contributed to
  {{promotion.reviewer.minStories}} different published stories, at least {{promotion.reviewer.minOthersStories}}
  of them started by someone else. Reviewers look after the **Watchtower**: they approve new stories, accept or
  turn down edits that are waiting, restore or remove versions, hide harmful stories and messages, and handle
  reports.
- **Moderator**: appointed by the people who run Hexstory. Moderators can do everything reviewers can, and can
  also ban people, change someone's role, protect stories that keep being vandalised, adjust the waiting
  periods and thresholds on this page, and read the log of every moderation action.

Only **published** stories count toward promotion, and each story counts once however many times you edit it.
A moderator can also set someone's role by hand; automatic promotion is then paused for them.

## When do my changes go live?

- **A Newcomer's new story** is private at first: only you and reviewers can see it. It's published as soon as
  a reviewer approves it, and you can keep editing it until then.
- **A Newcomer's edit** to any other story (or to their own story once it's published) waits for a reviewer to
  accept it. So does a Newcomer's story or edit with more than {{newcomerMaxLinks}} links.
- **Members' stories and edits** go live straight away, with two exceptions that wait for a reviewer:
  - an edit that removes more than {{largeRemovalPercent}}% of a story's text (reviewers' own edits don't wait);
  - an edit to a story a moderator has protected, unless your role is high enough to edit it directly.

You can follow everything you've written, and whether it's live or still waiting, on [your account page](/me).

## Daily limits

To keep things calm, everyone has a daily limit, counted over the last 24 hours. It grows with your role.

| | Newcomer | Member | Reviewer | Moderator |
|---|---|---|---|---|
| New stories | {{storiesPerDay.0}} | {{storiesPerDay.1}} | {{storiesPerDay.2}} | {{storiesPerDay.3}} |
| Edits | {{editsPerDay.0}} | {{editsPerDay.1}} | {{editsPerDay.2}} | {{editsPerDay.3}} |
| Photo uploads | {{uploadsPerDay.0}} | {{uploadsPerDay.1}} | {{uploadsPerDay.2}} | {{uploadsPerDay.3}} |
| Photo megabytes | {{uploadMegabytesPerDay.0}} MB | {{uploadMegabytesPerDay.1}} MB | {{uploadMegabytesPerDay.2}} MB | {{uploadMegabytesPerDay.3}} MB |

A story can be up to {{limits.bodyMax}} characters long with up to {{limits.imagesMax}} photos (each under
{{limits.imageMegabytesMax}} MB) and {{limits.sourcesMax}} sources. Very heavy formatting or hundreds of links can
also make a story too large to save ({{limits.contentKilobytesMax}} KB of stored content), because every
version is kept.

## Reports and bans

If you see vandalism, harassment, someone's personal details, spam or a copyright problem, use **Report** on the
story, version, chat message or person (up to {{reportsPerDay}} reports a day). Reviewers look at every report.
They can hide the content, and they can ask a moderator to ban someone. A ban stops the person from writing or
chatting straight away, and moderators can also take down what they posted.

## Please remember

Stories reflect the views of the people who wrote them. Sources are listed but **not verified**. The source
count shown next to each story is a hint, not a guarantee. Read critically and check the sources yourself.

Hexstory exists to get people talking about the places they care about. Disagreement is welcome; harassment,
doxxing and deliberate falsehoods are not.

Text is shared under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). See the
[Terms](/terms) and [Privacy Policy](/privacy).
