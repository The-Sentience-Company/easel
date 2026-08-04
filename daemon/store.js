// Prepared-statement data access over db.js. All mutations stamp updated_at.

import { openDb, now } from './db.js'

export function createStore(db = openDb()) {
  const q = {
    insertBoard: db.prepare(
      `INSERT INTO surfaces (key, title, file, template, data_file, status, created_at, updated_at)
       VALUES (@key, @title, @file, @template, @data_file, 'open', @at, @at)`
    ),
    boardByKey: db.prepare(`SELECT * FROM surfaces WHERE key = ?`),
    openBoardByFile: db.prepare(
      `SELECT * FROM surfaces WHERE status = 'open' AND file = ? ORDER BY created_at DESC LIMIT 1`
    ),
    openBoardByData: db.prepare(
      `SELECT * FROM surfaces WHERE status = 'open' AND template = ? AND data_file = ? ORDER BY created_at DESC LIMIT 1`
    ),
    allBoards: db.prepare(`SELECT * FROM surfaces WHERE status != 'archived' ORDER BY updated_at DESC`),
    touchBoard: db.prepare(`UPDATE surfaces SET updated_at = ? WHERE key = ?`),
    // Only fills a blank: an explicit --title is the author's, not the data's.
    fillTitle: db.prepare(`UPDATE surfaces SET title = ? WHERE key = ? AND (title IS NULL OR title = '')`),
    setStatus: db.prepare(`UPDATE surfaces SET status = ?, updated_at = ? WHERE key = ?`),
    setWip: db.prepare(
      `UPDATE surfaces SET wip_html = ?, wip_updated_at = ?, wip_diagrams_json = ?, wip_islands_json = ?, updated_at = ? WHERE key = ?`
    ),
    setAudit: db.prepare(`UPDATE surfaces SET audit_json = ?, updated_at = ? WHERE key = ?`),

    insertRound: db.prepare(
      `INSERT INTO rounds (surface_key, seq, html, note, diff_json, audit_json, diagrams_json, islands_json, published_at)
       VALUES (@surface_key, @seq, @html, @note, @diff_json, @audit_json, @diagrams_json, @islands_json, @at)`
    ),
    rounds: db.prepare(`SELECT seq, note, published_at FROM rounds WHERE surface_key = ? ORDER BY seq`),
    // One grouped count, because the index asks every board for its round count.
    roundCounts: db.prepare(`SELECT surface_key, count(*) AS n FROM rounds GROUP BY surface_key`),
    round: db.prepare(`SELECT * FROM rounds WHERE surface_key = ? AND seq = ?`),
    lastRound: db.prepare(`SELECT * FROM rounds WHERE surface_key = ? ORDER BY seq DESC LIMIT 1`),

    insertFeedback: db.prepare(
      `INSERT INTO feedback (surface_key, round_seq, kind, state, client_id, sid, quote, prefix, suffix,
                             excerpt, comment, widget_id, widget_value, text, payload_json, created_at, submitted_at)
       VALUES (@surface_key, @round_seq, @kind, @state, @client_id, @sid, @quote, @prefix, @suffix,
               @excerpt, @comment, @widget_id, @widget_value, @text, @payload_json, @at, @submitted_at)`
    ),
    feedbackById: db.prepare(`SELECT * FROM feedback WHERE id = ?`),
    deleteFeedback: db.prepare(`DELETE FROM feedback WHERE id = ?`),
    submittedSince: db.prepare(
      `SELECT * FROM feedback WHERE surface_key = ? AND state = 'submitted' AND id > ? ORDER BY id`
    ),
    // "Is the round on screen one a reader has already seen" — auto-open asks.
    markViewed: db.prepare(
      `UPDATE surfaces SET viewed_round = ? WHERE key = ? AND (viewed_round IS NULL OR viewed_round < ?)`
    ),
    unseenRound: db.prepare(
      `SELECT (SELECT max(seq) FROM rounds WHERE surface_key = s.key) > coalesce(s.viewed_round, 0) AS unseen
       FROM surfaces s WHERE s.key = ?`
    ),
    draftsForClient: db.prepare(
      `SELECT * FROM feedback WHERE surface_key = ? AND state = 'draft' AND client_id = ? ORDER BY id`
    ),
    draftIdsForClient: db.prepare(
      `SELECT id FROM feedback WHERE surface_key = ? AND state = 'draft' AND client_id = ? ORDER BY id`
    ),
    widgetDraft: db.prepare(
      `SELECT * FROM feedback WHERE surface_key = ? AND state = 'draft' AND kind = 'widget'
       AND widget_id = ? AND client_id = ?`
    ),
    updateWidgetDraft: db.prepare(
      `UPDATE feedback SET widget_value = ?, round_seq = ?, sid = ?, excerpt = ?, created_at = ? WHERE id = ?`
    ),
    maxFeedbackId: db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM feedback`),
    renumberAndSubmit: db.prepare(
      `UPDATE feedback SET id = ?, state = 'submitted', submitted_at = ? WHERE id = ?`
    ),
    syncSequence: db.prepare(
      `UPDATE sqlite_sequence SET seq = (SELECT MAX(id) FROM feedback) WHERE name = 'feedback'`
    ),
    maxSubmittedId: db.prepare(
      `SELECT COALESCE(MAX(id), 0) AS m FROM feedback WHERE surface_key = ? AND state = 'submitted'`
    ),

    getCursor: db.prepare(`SELECT acked_upto FROM cursors WHERE surface_key = ? AND agent_id = ?`),
    upsertCursor: db.prepare(
      `INSERT INTO cursors (surface_key, agent_id, acked_upto, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (surface_key, agent_id) DO UPDATE SET
         acked_upto = MAX(acked_upto, excluded.acked_upto), updated_at = excluded.updated_at`
    ),
    cursorsFor: db.prepare(`SELECT agent_id, acked_upto FROM cursors WHERE surface_key = ?`),

    whiteboard: db.prepare(`SELECT * FROM whiteboards WHERE surface_key = ? AND diagram_index = ?`),
    // The WHERE makes the update itself conditional: a stale writer changes no
    // rows rather than winning by arriving last.
    upsertWhiteboard: db.prepare(
      `INSERT INTO whiteboards (surface_key, diagram_index, source_hash, scene_json, version, updated_at)
       VALUES (@surface_key, @diagram_index, @source_hash, @scene_json, @version, @at)
       ON CONFLICT (surface_key, diagram_index) DO UPDATE SET
         source_hash = excluded.source_hash, scene_json = excluded.scene_json,
         version = excluded.version, updated_at = excluded.updated_at
       WHERE whiteboards.version = @base_version`
    ),

    insertChat: db.prepare(
      `INSERT INTO chat (surface_key, role, agent_id, text, created_at) VALUES (?, ?, ?, ?, ?)`
    ),
    chatFor: db.prepare(
      `SELECT id, role, agent_id AS agent, text, created_at AS at FROM chat WHERE surface_key = ? ORDER BY id`
    ),

    archiveStale: db.prepare(
      `UPDATE surfaces SET status = 'archived', updated_at = @at
       WHERE status = 'ended' AND updated_at < @cutoff`
    ),

    stalePurgeKeys: db.prepare(`SELECT key FROM surfaces WHERE updated_at < ?`),
    allKeys: db.prepare(`SELECT key FROM surfaces`),
    purgeChat: db.prepare(`DELETE FROM chat WHERE surface_key = ?`),
    purgeCursors: db.prepare(`DELETE FROM cursors WHERE surface_key = ?`),
    purgeFeedback: db.prepare(`DELETE FROM feedback WHERE surface_key = ?`),
    purgeRounds: db.prepare(`DELETE FROM rounds WHERE surface_key = ?`),
    purgeWhiteboards: db.prepare(`DELETE FROM whiteboards WHERE surface_key = ?`),
    purgeBoard: db.prepare(`DELETE FROM surfaces WHERE key = ?`),
  }

  const parseJson = (raw) => {
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  const feedbackItem = (row) => ({
    id: row.id,
    key: row.surface_key,
    round: row.round_seq,
    kind: row.kind,
    state: row.state,
    ...(row.kind === 'chat'
      ? { text: row.text }
      : {
          anchor: { sid: row.sid, quote: row.quote || undefined, prefix: row.prefix || undefined, suffix: row.suffix || undefined },
          excerpt: row.excerpt,
        }),
    ...(row.kind === 'widget' ? { widgetId: row.widget_id, value: row.widget_value } : {}),
    ...(row.kind === 'annotation' ? { comment: row.comment } : {}),
    ...(row.kind === 'whiteboard' ? { comment: row.comment, whiteboard: parseJson(row.payload_json) } : {}),
    createdAt: row.created_at,
    submittedAt: row.submitted_at || undefined,
  })

  return {
    db,
    createBoard(fields) {
      q.insertBoard.run({ ...fields, at: now() })
      return q.boardByKey.get(fields.key)
    },
    board: (key) => q.boardByKey.get(key),
    findOpen({ file, template, data_file }) {
      if (template && data_file) return q.openBoardByData.get(template, data_file)
      return file ? q.openBoardByFile.get(file) : undefined
    },
    allBoards: () => q.allBoards.all(),
    touch: (key) => q.touchBoard.run(now(), key),
    fillTitle: (key, title) => q.fillTitle.run(title, key),
    setStatus: (key, status) => q.setStatus.run(status, now(), key),
    setWip: (key, html, diagrams, islands) =>
      q.setWip.run(
        html,
        html == null ? null : now(),
        html != null && diagrams?.length ? JSON.stringify(diagrams) : null,
        html != null && islands?.length ? JSON.stringify(islands) : null,
        now(),
        key
      ),
    setAudit: (key, audit) => q.setAudit.run(JSON.stringify(audit), now(), key),

    addRound(key, seq, html, note, diff, audit, diagrams, islands) {
      q.insertRound.run({
        surface_key: key, seq, html, note: note ?? null,
        diff_json: diff ? JSON.stringify(diff) : null,
        audit_json: audit ? JSON.stringify(audit) : null,
        diagrams_json: diagrams?.length ? JSON.stringify(diagrams) : null,
        islands_json: islands?.length ? JSON.stringify(islands) : null,
        at: now(),
      })
      q.touchBoard.run(now(), key)
    },
    roundDiagrams(key, seq) {
      const row = seq != null ? q.round.get(key, seq) : q.lastRound.get(key)
      return parseJson(row?.diagrams_json)
    },
    wipDiagrams: (key) => parseJson(q.boardByKey.get(key)?.wip_diagrams_json),
    roundIslands(key, seq) {
      const row = seq != null ? q.round.get(key, seq) : q.lastRound.get(key)
      return parseJson(row?.islands_json)
    },
    wipIslands: (key) => parseJson(q.boardByKey.get(key)?.wip_islands_json),
    rounds: (key) => q.rounds.all(key).map((r) => ({ seq: r.seq, note: r.note, publishedAt: r.published_at })),
    roundCounts: () => new Map(q.roundCounts.all().map((r) => [r.surface_key, r.n])),
    round: (key, seq) => q.round.get(key, seq),
    lastRound: (key) => q.lastRound.get(key),

    addFeedback(fields) {
      const info = q.insertFeedback.run({
        round_seq: null, kind: 'annotation', state: 'draft', client_id: null, sid: null,
        quote: null, prefix: null, suffix: null, excerpt: null, comment: null,
        widget_id: null, widget_value: null, text: null, payload_json: null, submitted_at: null,
        ...fields, at: now(),
      })
      q.touchBoard.run(now(), fields.surface_key)
      return feedbackItem(q.feedbackById.get(info.lastInsertRowid))
    },
    // One live draft per (widget, client): a reclick replaces it in place.
    upsertWidgetDraft(fields) {
      const existing = q.widgetDraft.get(fields.surface_key, fields.widget_id, fields.client_id)
      if (!existing) return this.addFeedback({ ...fields, kind: 'widget', state: 'draft' })
      q.updateWidgetDraft.run(fields.widget_value, fields.round_seq, fields.sid, fields.excerpt, now(), existing.id)
      q.touchBoard.run(now(), fields.surface_key)
      return feedbackItem(q.feedbackById.get(existing.id))
    },
    feedbackRow: (id) => q.feedbackById.get(id),
    deleteFeedback: (id) => q.deleteFeedback.run(id),
    submittedSince: (key, since) => q.submittedSince.all(key, since).map(feedbackItem),
    markViewed: (key, seq) => q.markViewed.run(seq, key, seq),
    hasUnseenRound: (key) => Boolean(q.unseenRound.get(key)?.unseen),
    draftsForClient: (key, clientId) => q.draftsForClient.all(key, clientId).map(feedbackItem),
    // Drafts move to the top of the id sequence on submit so they always land
    // ahead of every cursor (id-as-cursor breaks if an old draft submits late).
    submitDrafts: db.transaction((key, clientId) => {
      const drafts = q.draftIdsForClient.all(key, clientId)
      if (!drafts.length) return []
      let nextId = q.maxFeedbackId.get().m
      const ids = []
      const at = now()
      for (const { id } of drafts) {
        nextId += 1
        q.renumberAndSubmit.run(nextId, at, id)
        ids.push(nextId)
      }
      q.syncSequence.run()
      q.touchBoard.run(at, key)
      return ids
    }),
    maxSubmittedId: (key) => q.maxSubmittedId.get(key).m,

    cursor: (key, agent) => q.getCursor.get(key, agent)?.acked_upto ?? 0,
    // Clamp: acking past the newest id would silently swallow future items.
    ack(key, agent, upto) {
      const clamped = Math.min(upto, q.maxFeedbackId.get().m)
      q.upsertCursor.run(key, agent, clamped, now())
      return q.getCursor.get(key, agent).acked_upto
    },
    cursorsFor: (key) => q.cursorsFor.all(key),

    whiteboard(key, index) {
      const row = q.whiteboard.get(key, index)
      if (!row) return null
      try {
        return {
          scene: JSON.parse(row.scene_json),
          sourceHash: row.source_hash,
          version: row.version,
          updatedAt: row.updated_at,
        }
      } catch {
        return null
      }
    },
    /** Null means the base version is not the stored one — a conflict, never a
        write. The caller re-reads and asks the human what to keep. */
    saveWhiteboard(key, index, scene, sourceHash, baseVersion) {
      const current = q.whiteboard.get(key, index)
      // An insert has no row for the WHERE to test, so a claim above 0 against a
      // scene that does not exist is stale by definition.
      if (!current && baseVersion !== 0) return null
      const info = q.upsertWhiteboard.run({
        surface_key: key,
        diagram_index: index,
        source_hash: sourceHash ?? null,
        scene_json: JSON.stringify(scene),
        version: baseVersion + 1,
        base_version: baseVersion,
        at: now(),
      })
      if (info.changes === 0) return null
      q.touchBoard.run(now(), key)
      return this.whiteboard(key, index)
    },

    addChat(key, role, text, agentId = null) {
      const info = q.insertChat.run(key, role, agentId, text, now())
      q.touchBoard.run(now(), key)
      return Number(info.lastInsertRowid)
    },
    chatFor: (key) => q.chatFor.all(key),

    gc(olderThanDays) {
      const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString()
      return q.archiveStale.run({ at: now(), cutoff }).changes
    },

    /* Any status; VACUUM (illegal inside the transaction) so the file shrinks
       — DELETE alone only frees pages for reuse. */
    purge(olderThanDays) {
      const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString()
      const keys = q.stalePurgeKeys.all(cutoff).map((r) => r.key)
      db.transaction((ks) => {
        for (const k of ks) {
          for (const stmt of [q.purgeChat, q.purgeCursors, q.purgeFeedback, q.purgeRounds, q.purgeWhiteboards, q.purgeBoard]) {
            stmt.run(k)
          }
        }
      })(keys)
      if (keys.length) db.exec('VACUUM')
      return keys
    },

    boardKeys() {
      return q.allKeys.all().map((r) => r.key)
    },

    feedbackItem,
  }
}
