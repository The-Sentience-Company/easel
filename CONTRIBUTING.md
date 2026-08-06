# Contributing

**easel is developed inside Sentience, and we do not take outside pull requests.** The code is public because it is useful, not because it is a community project — so please do not spend an afternoon on a patch expecting it to be merged.

What is welcome: issues describing a bug or a case easel handles badly, and forks. If you want easel to do something it does not, forking is the supported path, and the notes below are written to make that painless.

The rest of this file is the setup and house style, for people working on a fork and for Sentience engineers.

## Setup

Requires macOS and Node 22+.

```
npm install
install/install.sh    # registers the launchd agent, puts `easel` on PATH
npm test
```

`npm install` pulls a Chromium through Puppeteer, which mermaid-cli needs to render diagrams. Expect the first install to be slow and about a gigabyte on disk.

## Tests

```
npm test                                  # everything
node --test test/diff.test.js             # one file
```

The e2e harness spawns scratch daemons on allocated ports, so the suite never touches a daemon you have running.

Editing anything under `chrome/`, `render/`, `daemon/`, or `templates/` means rebuilding the whiteboard bundle:

```
node render/build-excalidraw.mjs
```

Skipping it fails the whole suite with one stale-bundle error rather than a scatter of unrelated assertion failures.

## What a change needs

**A test that fails without it.** Most of this codebase is rules about rendering and diffing that are easy to break invisibly — a round that silently stops marking changes still looks fine on screen. Guard the behavior, not the implementation.

**Comments that explain why.** The house style is terse and explains the reason a line exists, not what it does. If a constant has a value for a reason, say the reason. Don't restate the code.

**No unrelated cleanup.** Match the surrounding style even if you would write it differently.

CI runs `npm test` on macOS for every push and pull request, but run it before you push anyway — the suite is the whole safety net and it is faster locally than waiting on a runner.

## Working on a running daemon

`chrome/easel.css` is read from disk per request, so style changes are live on the next page load. Everything else is cached by the running daemon and needs a restart — `install/install.sh` does that as part of converging, and `easel update` moves an installed daemon onto new code after a merge.

A verification done without that restart is invalid in a way that looks like success: the old template renders without erroring, so the board quietly shows the pre-change behavior.

## Architecture, briefly

| Path | Holds |
|---|---|
| `daemon/` | HTTP, SSE, waiters, store, and the round differ |
| `cli/easel.js` | every command |
| `chrome/` | the browser UI wrapped around a rendered round |
| `templates/` | the publishable shapes; they take JSON and own their markup |
| `render/` | mermaid, diff, and excalidraw pre-render, all at publish time |

Rounds are baked at publish: the stored HTML for a round never picks up later template or render changes. Chrome CSS and JS are served live, so those changes reach existing boards immediately. That split explains most "why didn't my change show up" questions.

`docs/api.md` is the authoritative reference for routes and payload shapes. If the code and that doc disagree, the doc wins until the code is fixed.
