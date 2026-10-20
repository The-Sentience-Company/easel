# tabs

Tabs split a long board into groups the reader moves between, instead of one page they scroll forever. Use them when the content falls into groups the reader would jump between: phases, areas, chapters, one tab per component. Most boards don't need them; a board that fits in a few screens stays one page.

## review

Give sections a `tab` label. Sections that share a label form one tab, in order.

```jsonc
{
  "title": "Video series: 29 videos",
  "summary": "…",            // summary and metrics stay above the tabs
  "sections": [
    { "heading": "Series at a glance", "body": "…" },               // no tab: stays above the tab bar
    { "heading": "1. Your new job", "body": "…", "tab": "Planning" },
    { "heading": "2. Facts vs decisions", "body": "…", "tab": "Planning" },
    { "heading": "10. Who does what", "body": "…", "tab": "Running" }
  ],
  "decisions": [ … ]           // board-wide decisions render below the tabs and are always visible
}
```

Rules (a broken one fails the publish with the section's path):

- Sections before the first `tab` render above the bar and are always visible. Put the overview there.
- Once tabs start, every later section names its tab.
- Keep each tab's sections together. A label can't come back after another tab.
- You need at least two different labels.
- A section that only introduced a group ("Planning (videos 1 to 9)") is now the tab label; drop it rather than repeat it as the tab's first heading.

## page

Wrap each group in an element with `data-tab="Label"`. Sibling elements that carry it become one tab set:

```html
<h1>…</h1>
<div class="sd-metrics">…</div>
<div data-tab="Planning"> …sections… </div>
<div data-tab="Running"> …sections… </div>
```

## Labels

One to three words, ideally with the range they hold ("Planning · 1–9"). A long label pushes the other tabs off the bar on a phone.

## What the reader gets

You don't build any of this; it comes with the tabs:

- a bar that stays on screen while they scroll, and a "Next tab" button at the end of each tab
- a dot on tabs whose content changed this round, and a count of annotations on each tab
- the open tab in the URL (`#tab=Label`), so a link opens the right tab; it stays open when they switch rounds
- clicking a feedback row opens the tab that holds it

Nothing in the bar can be annotated. Content inside a tab is annotated, diffed and anchored as usual, and moving existing sections into tabs adds no change marks.
