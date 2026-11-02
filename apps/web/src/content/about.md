# About Hexstory

**Every place has a story.** Hexstory is a shared map of what happened where: protests, battles, discoveries,
disasters, landmarks and everyday local history, written by anyone and connected to each other.

## Finding something to read

You don't need to know what to look for. The home panel beside the map shows **featured stories**, **events
that are still developing**, **newly documented history** (older events someone has just written about),
**recent events** and **collections** of stories worth exploring. You can also:

- **Surprise me**: opens a well-sourced or well-connected story at random.
- **Explore a random event**: opens any published story at random.
- **History near me**: lists the stories closest to where you are. Your browser asks before sharing your
  location, and it stays on your device: Hexstory works out the nearest stories in your browser and never
  receives or stores where you are.
- **On this day**: events that began or ended on today's date in other years.
- **Search** for a place with the box at the top of the map, or **explore** every story with filters.

## The map

Every story is a dot at the place it happened. Click a dot to read the story, or click anywhere else to see
the stories in that hexagon. The hexagons are only a way to browse: a story is placed at its own precise
point, and may also cover a wider area.

- **The timeline** at the bottom of the map lets you pick a year, a decade or a range of years. The map and
  the lists that follow it show only what happened in that period.
- **Filters** show only some kinds of events: wars and conflicts, protests, political decisions, science and
  discoveries, disasters, cultural movements, historical landmarks and local events. You can pick several.
- **Layers** change what the map draws: plain dots, dots coloured by **category** or by **period**, only
  **developing** events, or **density**. Density shades hexagons by how many stories people have written
  there. It shows where Hexstory's writers have been busy, **not** how important a place is.

## Stories

Each story starts with the essentials, so you can judge it before reading the full account: **when** it
happened, **where** (a place on the map, and optionally a wider area), a **short summary**, its
**categories**, its **sources**, the **people** involved, and how it **connects to other stories**.

- **Connections**: a story can say what it was *preceded by*, what it *led to*, what it is *part of*, what it
  *includes*, and what it is *related to*. Each connection shows on both stories. When you write a story,
  find the stories to connect by typing a few letters of their title.
- **Event timelines**: an event that keeps unfolding (a war, a protest movement, a political crisis) doesn't
  need a new story for every development. Anyone can add a dated **development** with its own place and
  sources to the event's timeline.
- **Versions**: every edit is kept. Nothing is ever overwritten, and any change can be undone.
- **Imported stories**: to give the map a starting point, some stories were added in bulk by the
  **Hexstory Archive** account from public sources (encyclopedias and established news organisations, each
  listed on the story) with freely licensed photos. They are labelled "Imported from public sources" and
  are open to edits and corrections like any other story.

Lists can be ordered by when events **happened**, when they were **published**, by **latest updates**, by how
**connected** they are (how many other stories name them as a cause or a part, how far their timeline has
developed, how well they are sourced), or by **relevance** to a search or a place. Lists can also separate
**events written about as they happened** from **newly documented history**.

## Corrections

If a statement in a story is wrong, misleading or unsupported, select it and choose **Dispute a statement**. Say
what it should say instead and give your evidence (at least one source). Reviewers accept or reject each
correction with a public note, and everyone can see the outcome under the story. The disputed version always
stays in the story's history: corrections are made as new versions, never by erasing old ones. You can
propose up to {{correctionsPerDay.0}} corrections a day as a Newcomer ({{correctionsPerDay.1}} as a Member).

## Collections

Collections gather stories into a narrative: a **place** ("The history of Manhattan") or a **theme** ("The Arab
Spring", "How Europe's borders changed"). Stories can be picked by hand, in the order the curator chooses,
and gathered automatically by rules: everything in an area, in some categories or within a span of years.
Read a collection in its arranged order or by date, and see all its stories highlighted on the map.

Members and above can start collections (up to {{collectionsPerDay.1}} a day). Its creator and reviewers can
change a collection.

## Roles and reputation

Anyone can write, but trust is earned. Everyone starts as a Newcomer and moves up automatically. What counts
is the **quality** of what you contribute, not how much: your **reputation** grows when your work is accepted
and holds up, and shrinks when it is turned down, corrected or removed. Your reputation is private: only you
(on [your account page](/me)) and reviewers can see it. There are no public rankings.

| | Points |
|---|---|
| A story you started is published | +{{reputation.publishedStory}} |
| Each linked source on your published stories (up to {{reputation.sourcesPerStoryMax}} per story) | +{{reputation.linkedSource}} |
| Each published story by someone else that you improved (once per story, however many edits) | +{{reputation.improvedStory}} |
| Each accepted development you added to a timeline (up to {{reputation.developmentsPerStoryMax}} per story) | +{{reputation.development}} |
| Each of your corrections that was accepted | +{{reputation.correctionAccepted}} |
| Each week in which something of yours was accepted (up to {{reputation.activeWeeksMax}}) | +{{reputation.activeWeek}} |
| Each of your corrections that was rejected | −{{reputation.less.correctionRejected}} |
| Each of your stories or edits that was turned down | −{{reputation.less.editRejected}} |
| Each accepted correction to a story you started | −{{reputation.less.correctedStory}} |
| Each version, development or published story of yours that was removed | −{{reputation.less.removed}} |

- **Newcomer**: everyone who has just signed in. You can write stories, suggest edits, add developments and
  propose corrections. Your new stories stay private until a reviewer approves them, and your edits and
  developments wait for a reviewer.
- **Member**: after {{promotion.member.minAgeDays}} days, with a reputation of
  {{promotion.member.minReputation}}. Your stories, edits and developments go live straight away, and you can
  start collections.
- **Reviewer**: after {{promotion.reviewer.minAgeDays}} days, with a reputation of
  {{promotion.reviewer.minReputation}}, having improved or corrected at least
  {{promotion.reviewer.minOthers}} published stories other people started, over at least
  {{promotion.reviewer.minActiveWeeks}} different weeks. Reviewers look after the **Watchtower**: they approve
  new stories, accept or turn down edits and developments that are waiting, decide corrections, feature
  stories on the home page, restore or remove versions, hide harmful content and handle reports.
- **Moderator**: appointed by the people who run Hexstory. Moderators can do everything reviewers can, and can
  also ban people, change someone's role, protect stories that keep being vandalised, adjust the thresholds
  on this page, and read the log of every moderation action.

A moderator can also set someone's role by hand; automatic promotion is then paused for them.

## When do my changes go live?

- **A Newcomer's new story** is private at first: only you and reviewers can see it. It's published as soon as
  a reviewer approves it, and you can keep editing it until then.
- **A Newcomer's edit or development** to any other story (or to their own story once it's published) waits
  for a reviewer to accept it. So does a Newcomer's story or edit with more than {{newcomerMaxLinks}} links.
- **Members' stories, edits and developments** go live straight away, with two exceptions that wait for a
  reviewer:
  - an edit that removes more than {{largeRemovalPercent}}% of a story's text (reviewers' own edits don't wait);
  - a change to a story a moderator has protected, unless your role is high enough to edit it directly.

You can follow everything you've written, and whether it's live or still waiting, on [your account page](/me).

## Daily limits

To keep things calm, everyone has a daily limit, counted over the last 24 hours. It grows with your role.

| | Newcomer | Member | Reviewer | Moderator |
|---|---|---|---|---|
| New stories | {{storiesPerDay.0}} | {{storiesPerDay.1}} | {{storiesPerDay.2}} | {{storiesPerDay.3}} |
| Edits and developments | {{editsPerDay.0}} | {{editsPerDay.1}} | {{editsPerDay.2}} | {{editsPerDay.3}} |
| Corrections | {{correctionsPerDay.0}} | {{correctionsPerDay.1}} | {{correctionsPerDay.2}} | {{correctionsPerDay.3}} |
| New collections | {{collectionsPerDay.0}} | {{collectionsPerDay.1}} | {{collectionsPerDay.2}} | {{collectionsPerDay.3}} |
| Photo uploads | {{uploadsPerDay.0}} | {{uploadsPerDay.1}} | {{uploadsPerDay.2}} | {{uploadsPerDay.3}} |
| Photo megabytes | {{uploadMegabytesPerDay.0}} MB | {{uploadMegabytesPerDay.1}} MB | {{uploadMegabytesPerDay.2}} MB | {{uploadMegabytesPerDay.3}} MB |

A story can be up to {{limits.bodyMax}} characters long with up to {{limits.imagesMax}} photos (each under
{{limits.imageMegabytesMax}} MB) and {{limits.sourcesMax}} sources. Very heavy formatting or hundreds of links can
also make a story too large to save ({{limits.contentKilobytesMax}} KB of stored content), because every
version is kept.

## Reports and bans

If you see vandalism, harassment, someone's personal details, spam or a copyright problem, use **Report** on the
story, version, development, correction, collection or person (up to {{reportsPerDay}} reports a day).
Reviewers look at every report. They can hide or remove the content, and they can ask a moderator to ban
someone. A ban stops the person from contributing straight away, and moderators can also take down what they
posted.

## Please remember

Stories reflect the views of the people who wrote them. Sources are listed but **not verified**. The source
count shown next to each story is a hint, not a guarantee. Read critically, check the sources yourself, and
dispute what you can show is wrong.

Disagreement is welcome; harassment, doxxing and deliberate falsehoods are not.

Text is shared under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). See the
[Terms](/terms) and [Privacy Policy](/privacy).
