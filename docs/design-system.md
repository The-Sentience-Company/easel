# Design system — `chrome/easel.css`

Static precompiled CSS. No build step, no Tailwind runtime, no CDN. Token names follow DaisyUI's vocabulary so existing artifact patterns port over unchanged.

## Themes

The shell page sets `data-theme` on the `<html>` element. Three families — default, `lantern`, `fig` — each in a light and a dark mode:

```html
<html data-theme="light">          <!-- default family -->
<html data-theme="dark">
<html data-theme="lantern-light">  <!-- named families suffix the mode -->
<html data-theme="fig-dark">
```

The default family follows the look of a Claude Artifact page: a cool grey ground with white panels in light, graphite in dark, one blue accent, and sans type throughout. lantern and fig keep their own palettes and the serif display face. Shapes are shared by all three: heading sizes, option buttons, badges and code blocks look the same in every family; only colour and type face differ.

Light or dark always follows the computer's setting, live. The default family is what every board shows; lantern and fig are reached only by a `?theme=<family>` link. The shell's inline script sets `data-theme` before first paint and on every OS change. The bar has no theme, tuner or width controls: page width is the board's, set by the agent with `"width": "wide"` in the data (1400px instead of 1040px).

Under 1500px the chrome opens collapsed: one row of the controls a reader acts on, with the diff legend and the round note folded away. The chevron at its right end expands it (localStorage `sf-chrome-compact`).

**It has to be `<html>`, not a wrapper div.** A wrapper resolves the base rules against `:root`'s light defaults, so dark tables render dark-on-dark. This bit once and the rule is pinned in the contract between the daemon and the chrome.

## Text tiers

Three, ordered by contrast, and the ordering is the point:

| Token | Used for | Measured on the default family's page ground |
|---|---|---|
| `--color-base-content` | headings, `<strong>`, table cells, controls | 16.2:1 light · 16.2:1 dark |
| `--color-body-content` | prose (`p`, `li`), inline `code` | 10.1:1 light · 11.5:1 dark |
| `--color-muted-content` | secondary text, `sd-muted` | 6.3:1 light · 7.5:1 dark |

Inline `code` **pins** the body tier rather than inheriting it. Inheriting put muted text on the raised code ground at 4.27:1 — each token fine alone, the stack below AA.

In the default dark the page ground is graphite, not black, and `--color-base-100` and `--color-base-300` step *up* from it, so panels lift off the page. In light the panels are white on a grey ground. The default's tiers lean slightly cool (hue 262–265) to match the ground; lantern's dark keeps its warm candlelit tiers.

`--border-subtle` is lighter than `--border`: internal table rules use it so the outer edge stays the stronger line.

**Collapsing** body prose into the emphasis tier is a regression: uniform near-maximum contrast is what made long documents read flat and fatiguing. Body may sit high — on dark it is deliberately bright — as long as a real gap remains. `test/design-system.e2e.test.js` pins both the ordering and the gap in each theme.

`sd-muted` is written with `#sf-content` in its selector, because `#sf-content p` would otherwise outrank a bare class — including when `sd-muted` wraps rendered markdown, whose children are `<p>`.

## Fonts

`--font-display` carries headings, ledes and entry names: `--font-sans` in the default family, `--font-serif` in lantern and fig. `--font-sans` sets body, `--font-mono` labels and code. Every face is a system face, so nothing is fetched and the publish path stays same-origin.

`[data-option]` pins `font-family` rather than relying on `font: inherit` alone: a control inside a monospace ancestor otherwise renders as what looks like a code sample.

## Two class namespaces

| Prefix | Owner | Meaning |
|---|---|---|
| `sd-*` | templates | Design system. Emitted by `templates/*.js`; `easel.css` styles it. |
| `sf-*` | chrome | Structure built by `chrome/client.js`, plus the content-layer markers it applies at runtime (`sf-annotated`, `sf-diff-*`, `sf-recorded`). |

**Templates never emit an `sf-` class** — `easel.css` only styles them. `page.js` actively rejects input that carries one, in every legal attribute syntax including the unquoted `class=sf-queue` form.

The chrome DOM vocabulary itself — which elements client.js builds and which classes it applies — is specified in `docs/api.md`.

## The `[hidden]` rule

`easel.css` sets `[hidden] { display: none !important; }`. Without it, an explicit `display:` on a chrome class beats the user-agent `[hidden]` rule and the attribute silently stops working — which is why panels appeared to ignore being hidden. `test/css.test.js` pins this with a computed-style check.
