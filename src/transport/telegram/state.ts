import type { Queryable } from '../../db/db.js';

/** The last update id each bot has ingested in polling mode (telegram_state). */
export function telegramStateRepo(db: Queryable) {
  return {
    async get(botId: string): Promise<{ lastUpdateId: number; updatedAt: Date } | null> {
      const res = await db.query<{ id: string; updated_at: Date | string }>(
        'SELECT last_update_id::text AS id, updated_at FROM telegram_state WHERE bot_id = $1',
        [botId],
      );
      const row = res.rows[0];
      return row ? { lastUpdateId: Number(row.id), updatedAt: new Date(row.updated_at) } : null;
    },
    async lastUpdateId(botId: string): Promise<number | null> {
      return (await this.get(botId))?.lastUpdateId ?? null;
    },
    /**
     * Records the update just ingested. Not clamped with GREATEST: after a quiet week
     * Telegram may restart ids lower, and the offset must follow (one poller per bot,
     * updates are saved in the order Telegram sends them).
     */
    async save(botId: string, updateId: number, at: Date): Promise<void> {
      await db.query(
        `INSERT INTO telegram_state (bot_id, last_update_id, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (bot_id) DO UPDATE SET last_update_id = EXCLUDED.last_update_id, updated_at = EXCLUDED.updated_at`,
        [botId, updateId, at],
      );
    },
  };
}
