// ============================================================================
// Idempotency — dedupe replayed writes from the offline queue.
// ----------------------------------------------------------------------------
// The offline engine stamps each queued mutation with a client-generated
// op-id and replays it when signal returns; a flaky connection can replay the
// same op twice. `firstTime` records the op-id (PRIMARY KEY) and returns false
// on a repeat, so the caller can skip re-applying. No op-id → always process
// (every existing caller is unaffected).
// ============================================================================

let READY = false;
async function ensure(env) {
  if (READY) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS idempotency (
    tenant_id INTEGER NOT NULL DEFAULT 1,
    op_id TEXT PRIMARY KEY,
    scope TEXT,
    at TEXT
  )`).run();
  READY = true;
}

// true  → first time this op-id has been seen (and it's now recorded)
// false → a duplicate; the caller should NOT re-apply the write
export async function firstTime(env, tenantId, opId, scope) {
  if (!opId) return true;
  await ensure(env);
  try {
    await env.DB.prepare(
      "INSERT INTO idempotency (tenant_id, op_id, scope, at) VALUES (?,?,?,?)"
    ).bind(tenantId, String(opId).slice(0, 120), String(scope || "").slice(0, 60), new Date().toISOString()).run();
    return true;
  } catch {
    return false; // PRIMARY KEY conflict = already processed
  }
}
