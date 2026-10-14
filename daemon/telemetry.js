// Anonymous usage heartbeat: a random install id, the version and the OS, once a day and on each version change.
// What is sent and how to turn it off: docs/usage.md#telemetry.

import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

export const DEFAULT_TELEMETRY_URL = 'https://api.sentience.com/telemetry/easel-heartbeat'
const DAY_MS = 24 * 60 * 60 * 1000
const TIMEOUT_MS = 2000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const optOutPath = (dataDir) => join(dataDir, 'telemetry.off')

export async function telemetryOff(dataDir, env = process.env) {
  if (env.EASEL_TELEMETRY === 'off') return true
  return access(optOutPath(dataDir)).then(() => true, () => false)
}

async function installId(dataDir) {
  const path = join(dataDir, 'install-id')
  const existing = (await readFile(path, 'utf8').catch(() => '')).trim()
  if (UUID_RE.test(existing)) return existing
  const id = randomUUID()
  await mkdir(dataDir, { recursive: true })
  await writeFile(path, id + '\n', { mode: 0o600 })
  return id
}

/** Never throws: resolves to 'off', 'throttled', 'sent' or 'failed', and a failure never touches boot. */
export async function sendHeartbeat({ dataDir, version, env = process.env, fetchImpl = fetch, now = Date.now }) {
  try {
    if (await telemetryOff(dataDir, env)) return 'off'
    const lastPath = join(dataDir, 'telemetry-last')
    // An older daemon wrote a bare timestamp here; it has no version, so it never throttles.
    const last = await readFile(lastPath, 'utf8').then(JSON.parse).catch(() => ({}))
    if (last.version === version && now() - last.at < DAY_MS) return 'throttled'
    const res = await fetchImpl(env.EASEL_TELEMETRY_URL || DEFAULT_TELEMETRY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installId: await installId(dataDir), version, os: process.platform }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return 'failed'
    await writeFile(lastPath, JSON.stringify({ at: now(), version }))
    return 'sent'
  } catch {
    return 'failed'
  }
}
