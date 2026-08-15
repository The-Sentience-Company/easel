# Chart pre-rendering

A ```` ```chart ```` fence in any prose field becomes `<pre class="sd-chart">JSON</pre>` at template-render time. `render/chart.js` `preRender()` then replaces each one with a themed inline SVG at publish time. No charting library, and no JavaScript, ships to the browser.

## When not to reach for one

**A table is the default.** It carries exact values, it is readable at any width, it survives copy-paste, and a reader can scan it for the one number they came for. A chart trades all of that for shape — so it earns its place only when shape is the point:

- the reader asked for a chart;
- a trend over an ordered sequence, where the slope is the finding;
- a distribution or a ranking, where the profile across categories is the finding;
- several series compared, where the gap between them is the finding.

Fewer than about five data points is a table, or a sentence. Two numbers are a sentence — "background spend is 3.4× chat" says more than any two bars. A chart of one series with no comparison and no trend is decoration, and decoration costs the reader a scan and gains nothing.

When the chart supports a claim you already made in prose, keep it `sm` and keep the claim.

## The shape

```chart
{
  "type": "bar",
  "title": "Spend by month",
  "x": ["Jan", "Feb", "Mar"],
  "series": [
    { "label": "Chat", "values": [120, 90, 140] },
    { "label": "Background", "values": [300, 410, 445] }
  ],
  "unit": "$"
}
```

| Field | Type | Rules |
|---|---|---|
| `type` | string, **required** | `bar`, `hbar` (horizontal — categories on the y-axis), or `line`. No pie, no stacked, no area. |
| `size` | string, optional | `sm`, `md`, or `lg`. Default `md`. |
| `x` | array, **required** | 1–120 category labels (`hbar`: 1–40), coerced to strings. Evenly spaced and categorical — no date math. |
| `series` | array, **required** | 1–5 entries. |
| `series[i].label` | string | Required once there are 2+ series; the legend needs it. Optional for a single series. |
| `series[i].values` | array, **required** | Same length as `x`. Finite numbers, or `null` for a gap. |
| `title` | string, optional | Rendered as the caption and the SVG's `aria-label`. |
| `yLabel` | string, optional | Short axis annotation, rotated at the left edge. Ignored for `hbar`. |
| `unit` | string, optional | `$ € £ ¥` prefix (`$1.2k`); anything else suffixes (`12 ms`). |

Unknown keys are ignored. Grouped bar is not a type — it is `bar` (or `hbar`) with 2+ series.

## The three types

**`bar`** — a value per category, compared across categories. Bars always grow from zero; there is no truncated-axis option, because a truncated bar axis misstates the ratio the bars exist to show.

```chart
{ "type": "bar", "size": "sm", "x": ["p50", "p90", "p99"], "series": [{ "values": [120, 340, 910] }], "unit": "ms" }
```

**`hbar`** — the same chart transposed. Reach for it when category names are long, or when the chart is a ranking: names read horizontally at full length, and the eye runs down a ranked list naturally. **Never rotate a label to make a vertical bar fit — that is what `hbar` is for.** A name past ~35% of the chart width is truncated with `…` and keeps its full text in a hover title.

```chart
{ "type": "hbar", "x": ["retrieval latency", "model call", "post-processing"], "series": [{ "values": [220, 1400, 95] }], "unit": "ms" }
```

**`line`** — a trend across an ordered sequence. `null` breaks the line into segments rather than interpolating across the gap, so missing data reads as missing.

```chart
{ "type": "line", "x": ["w1", "w2", "w3", "w4"], "series": [{ "label": "pass rate", "values": [0.62, 0.71, null, 0.83] }] }
```

## Sizes

`md` (480px) is the default and the right answer most of the time. `sm` (320px) is for a chart that supports a sentence you already wrote. `lg` (640px) is only for a chart that is the subject of its section. All three use the same text size, so `sm` is genuinely smaller rather than a shrunken `lg` — and every chart shrinks to fit a narrow column.

## Colours carry identity

Series take colours in fixed order: series 0 → chart-1, series 1 → chart-2, and so on through five. The set is validated colorblind-safe and legible in both themes, and the colours ride CSS classes, so a chart re-themes live when the reader hits the theme toggle.

**Same meaning, same slot, across every chart on a board.** If "Background" is series 1 on the first chart, it is series 1 on the last. A reader who learned a colour carries it.

Text never wears a series colour — labels, ticks, and legend text stay in ink; the swatch carries identity. Gridlines and axes stay recessive. There are no per-point value labels: the value is in the hover title, and the axis is right there.

## Caps, and what to do about them

Five series and 120 categories (40 for `hbar`) are the caps. Past either, the fix is splitting the chart, not raising the cap — a chart with six series is already unreadable, and the split usually reveals that two charts were being asked of one.

Dense x-axes sample their labels (every Nth, by size) rather than overprinting, and rotate them when they still don't fit. `hbar` never samples: every category gets a row.

## Failure behavior

`preRender()` never throws. A chart with malformed JSON or a bad shape degrades to a small `sd-chart`-less error block carrying the reason and the original source, and the surrounding document still publishes.

As with mermaid, this is deliberately not symmetric with the templates, which *do* throw on bad data: bad template data is an authoring error worth stopping for, while one chart that will not draw is worth shipping the document without.
