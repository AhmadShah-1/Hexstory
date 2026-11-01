import type { SessionUser } from '../auth/sessions.js';
import type { Db, Sql } from '../db.js';
import { tooMany } from '../errors.js';
import { POLICY } from '../policy.js';

const MB = 1024 * 1024;

/**
 * Records an upload slot, refusing it if the user has used up today's photo quota (count, and total
 * size of originals). Runs under the per-user advisory lock so parallel requests can't overshoot.
 * Every slot counts, completed or not: an abandoned original still sat in staging storage.
 */
export async function reserveUpload(sql: Sql, user: SessionUser, id: string, declaredBytes: number): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`;
    const [today] = await tx<{ count: number; bytes: number }[]>`
      SELECT count(*)::int AS count, COALESCE(sum(declared_bytes), 0)::bigint::float8 AS bytes
      FROM uploads WHERE user_id = ${user.id} AND created_at > now() - interval '1 day'`;
    const maxCount = POLICY.uploadsPerDay[user.trustLevel];
    const maxBytes = POLICY.uploadMegabytesPerDay[user.trustLevel] * MB;
    if ((today?.count ?? 0) >= maxCount) {
      throw tooMany(`You've reached today's limit of ${maxCount} photo uploads. It grows as you contribute.`);
    }
    if ((today?.bytes ?? 0) + declaredBytes > maxBytes) {
      throw tooMany(`That would go over today's limit of ${POLICY.uploadMegabytesPerDay[user.trustLevel]} MB of photos. Try a smaller photo or come back tomorrow.`);
    }
    await tx`INSERT INTO uploads (id, user_id, declared_bytes) VALUES (${id}, ${user.id}, ${declaredBytes})`;
  });
}

/** Notes what a completed upload stored (WebP full size + thumbnail). */
export async function recordStoredUpload(sql: Db, userId: string, id: string, storedBytes: number): Promise<void> {
  await sql`UPDATE uploads SET stored_bytes = ${storedBytes}, completed_at = now() WHERE id = ${id} AND user_id = ${userId}`;
}
