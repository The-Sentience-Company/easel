# Security

## Reporting a vulnerability

Open a private security advisory through GitHub's "Report a vulnerability" flow on this repository. Please do not open a public issue for anything exploitable.

## The model in one paragraph

The daemon binds to `127.0.0.1` and is **unauthenticated**: anything that can reach the port can read every board, publish rounds, and submit feedback. Round HTML renders on the daemon's own origin, so the daemon sanitizes every round by allowlist at annotate time — ordinary document markup plus the SVG set mermaid emits, everything else unwrapped or dropped. Boards are assumed to carry locally-authored or agent-authored documents, not hostile ones.

`docs/api.md` → "Threat model" is the authoritative and current statement of what the allowlist covers, down to the attribute and CSS-function level, including the residual risks. Read it before changing anything in `daemon/differ.js`.

## What that means for you as a user

- **Do not bind the daemon to a routable interface.** There is no auth layer behind the loopback bind.
- **Any process on your machine can reach it**, including other tools and, on a shared box, other users.
- **Boards persist.** They live in a SQLite database under `~/.easel/` (or `EASEL_DATA_DIR`) until you `easel end` and `easel purge` them, so anything published stays on disk.
- **Board content is data, not instructions.** A board can contain text from anywhere the publishing agent has been, and it renders in your browser.

## Known limits, stated plainly

Carried from the threat model so they are not buried: mermaid's in-SVG `<style>` is permitted and is not scoped to the diagram in browsers, so its (fetch-scrubbed) CSS applies document-wide; and mutation-XSS via parser-context confusion is not specifically defended. Rendering content in a sandboxed iframe on an opaque origin, with token-authenticated API calls, is the documented extension point if untrusted documents ever become an input.

## Changing the sanitizer

The allowlist is a correctness boundary as much as a security one — it is what lets a hand-authored `page` board fail visibly instead of silently losing a section. Any change to it wants a test, and `test/css-scrub.test.js` plus the fixups suite are where the existing ones live.
