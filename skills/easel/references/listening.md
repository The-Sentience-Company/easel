# Listening — failure modes and feedback mechanics

The SKILL.md rules are the behavior; this file is the why and the edge cases. Read it when a listener misbehaves or when placing/attributing feedback needs more than the batch JSON gives you.

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
