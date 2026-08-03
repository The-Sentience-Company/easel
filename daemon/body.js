/* Oversized bodies drain (to a cap) before the 413: aborting mid-upload
   resets the socket, and the reset can destroy the 413 before it is read. */

export const MAX_BODY_BYTES = 1024 * 1024
export const DRAIN_LIMIT_BYTES = 32 * 1024 * 1024
export const DRAIN_LIMIT_MS = 2000

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export async function readBody(req, max = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  let overBy = 0
  let timer = null
  try {
    for await (const chunk of req) {
      if (overBy) {
        overBy += chunk.length
        if (overBy > DRAIN_LIMIT_BYTES) break
        continue
      }
      size += chunk.length
      if (size > max) {
        overBy = 1
        // The timer, not a loop check: a stalled upload blocks in the await.
        timer = setTimeout(() => req.destroy?.(new Error('drain deadline')), DRAIN_LIMIT_MS)
        continue
      }
      chunks.push(chunk)
    }
  } catch (err) {
    if (!overBy) throw err
  } finally {
    if (timer) clearTimeout(timer)
  }
  if (overBy) throw new HttpError(413, 'request body too large')
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'invalid JSON body')
  }
}
