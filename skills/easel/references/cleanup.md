# Cleanup: `easel purge`

```
easel purge [--older-than 30d] [--json]
```

Deletes every board — any status, including abandoned "open" ones — whose last activity (`updated_at`) is older than the cutoff. Takes everything with it: rounds (the baked HTML that dominates DB size), feedback, chat, per-agent cursors, and whiteboard scenes both in the DB and on disk. Ends with a VACUUM so `~/.easel/easel.db` actually shrinks; a bare DELETE would only free pages for reuse. Never touches source files.

Run it at the user's discretion — nothing schedules it. Rule of thumb: run when the DB feels big (`ls -la ~/.easel/easel.db`); heavy multi-agent weeks accrue ~2–3MB/day, dominated by diagram rounds (~200KB each).

Related but different:

- `easel gc [--older-than 7d]` — archives ended boards (a dashboard-decluttering status flip; reclaims **zero** bytes).
- `daemon.log` — self-caps: the daemon truncates it at startup when it exceeds 5MB.

A purged board is gone: its URL 404s, feedback replay ends, and any parked `await` on it resolves cancelled. Purging cannot break a republish that wasn't already broken — republish needs the source file, which purge never touches.
