# Listening — `easel await` mechanics and failure modes

```
easel await <key> [--agent ID] [--ack N]
```

Blocks until real feedback, cancel, or board end — it re-attaches across long-poll timeouts and daemon restarts, so run it once and stop polling (`--timeout-s` sizes one poll window, never the overall wait). Annotations, widget clicks, and chat ride the same stream; answer chat with `easel reply <key> "msg" --agent ID`.

- **Background it as a harness-tracked command** (`run_in_background: true`) — its exit wakes you to read the batch. A shell `&`/`nohup` launch exits into a file no one reads.
- **Relaunch once after each publish** — publishing with your own agent ID drops your parked listener (`dropped: true`, exit 0, expected).
- **A killed listener is a non-event**: relaunch the identical bare await in one call and say nothing — the cursor is server-side, nothing was lost. If it's killed instantly twice running, see "Fallback when relaunches die instantly" below.
- **Ack what you've handled**: relaunch with `--ack <upto>` from the batch you just applied, or the backlog re-delivers and you answer the same annotations twice.
- **`--agent` IDs are workspace-scoped and durable** — worktree basename + callsign (`my-project-a3:a3`); a bare callsign collides with other workspaces. A NEW ID replays the board's whole history. A handoff that names live boards must name the agent ID they were listened on.
- **Refer to feedback by chip ID (A1, A2 …), never internal item ids** — the chips are what the user sees. Derivation: "Chip IDs" below.
- **An answer given in prose is still an answer.** When the reader states a decision plainly — in board chat, in an annotation, or in the session itself — record it and act on it. Never hold a decision open waiting for the matching widget click, and never re-ask what they already answered; the widget is one way to answer, not the only one.

## Why a killed listener costs nothing

The harness kills its own tracked background commands — SIGKILL to the shell it tracks, so no wrapper, trap, or retry loop survives it, and nothing you write prevents the wakeup. `<status>killed</status>` is distinct from `completed`: the await never delivered, and the cursor is server-side, so nothing was lost. What you control is the recovery cost: re-run the identical await (same `--agent`, same `--ack`) in one call and stop. Reading the empty output file, checking `easel status`, and narrating the recovery is four turns against a full context for zero information. Launch the bare command — a `cd dir && easel await` prefix has gotten the relaunch killed where the bare form survived.

## Fallback when relaunches die instantly

If the same await is killed instantly two relaunches running (some harness setups kill tracked processes at every turn boundary), stop relaunching: poll `easel feedback <key> --since N` on a timer instead, and treat a grown `upto` as the wake signal. Cost of the fallback: the board shows no "agent waiting" badge while no await is parked. Never reach for a trap/supervisor wrapper — it does not survive the SIGKILL and hides the real state.

## Cursor semantics

The server keeps one cursor per agent ID. The same ID always resumes with exactly the unacked backlog — a re-run re-delivers it (so `--ack <upto>` what you already handled, or you'll answer the same annotations twice), and a newer await from the same ID supersedes the old one (`superseded: true`, exit 0). A NEW ID starts at cursor 0 and replays the board's entire feedback history — ack the replay if that's not wanted. `easel feedback <key> --since N` browses without touching any cursor. Publishing with your own agent ID drops your parked listener on that board (`dropped: true`, exit 0 — expected); relaunch once after each publish, and never pre-emptively relaunch one that hasn't fired.

## Placing an annotation: anchor context

Anchors carry `context` — `{heading, card, nth, of}`, computed from the annotated round — so when the same text repeats across sections (four tables with an identical header), read `context.heading` and `nth/of` to place the feedback instead of guessing from `excerpt`.

## Chip IDs — how to refer to feedback

The board UI labels each annotated anchor with a two-character chip (A1, A2, … A9, B1, …) — that is what the user sees, so "your A2" is meaningful and "item 816" is not. The await/feedback JSON carries no chip field; derive it: take the round's annotation items in id order and number each anchored item's unique anchor by first appearance (first → A1, second → A2), skipping widget clicks. The anchor is `sid` alone, or `sid@x,y` for island pins (`anchor.x`/`anchor.y` present: a pinned click point inside an island; its `quote` names the clicked element, and each distinct point is its own chip). Chat carries no anchor and so no chip.
