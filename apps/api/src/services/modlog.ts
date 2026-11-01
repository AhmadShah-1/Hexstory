import type { Db } from '../db.js';

export async function logModAction(
  sql: Db,
  actorId: string,
  action: string,
  targetType: string,
  targetId: string,
  reason: string | null = null,
): Promise<void> {
  await sql`
    INSERT INTO mod_actions (actor_id, action, target_type, target_id, reason)
    VALUES (${actorId}, ${action}, ${targetType}, ${targetId}, ${reason})`;
}
