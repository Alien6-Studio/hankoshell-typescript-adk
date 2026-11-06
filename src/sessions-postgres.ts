import type { HankoSessionStore, HankoStoredSession } from "./sessions.js";

/** Compatible with pg.Pool/Client without making a database driver mandatory. */
export interface HankoPostgresClient {
  query(text: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}
/** Apply through the application's migration procedure, never at request time. */
export const HANKO_POSTGRES_SESSION_SCHEMA = `CREATE TABLE hanko_sessions (
  scope text NOT NULL,
  id text NOT NULL,
  revision text NOT NULL,
  expires_at bigint NOT NULL,
  lease_until bigint NOT NULL,
  sealed text NOT NULL,
  PRIMARY KEY (scope, id)
);
CREATE INDEX hanko_sessions_expiry ON hanko_sessions (expires_at);`;

export function createHankoPostgresSessionStore(client: HankoPostgresClient): HankoSessionStore {
  return {
    async create(scope, value) {
      const result = await client.query("INSERT INTO hanko_sessions (scope,id,revision,expires_at,lease_until,sealed) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [scope, value.id, value.revision, value.expiresAt, value.leaseUntil, value.sealed]);
      return result.rowCount === 1;
    },
    async read(scope, id) {
      const result = await client.query("SELECT id,revision,expires_at,lease_until,sealed FROM hanko_sessions WHERE scope=$1 AND id=$2", [scope, id]);
      const row = result.rows[0];
      if (!row) return null;
      const value: HankoStoredSession = { id: String(row.id), revision: String(row.revision), expiresAt: Number(row.expires_at), leaseUntil: Number(row.lease_until), sealed: String(row.sealed) };
      if (value.id !== id || !Number.isSafeInteger(value.expiresAt) || !Number.isSafeInteger(value.leaseUntil)) throw new Error("Invalid Hanko session record");
      return value;
    },
    async replace(scope, revision, value) {
      const result = await client.query("UPDATE hanko_sessions SET revision=$4,expires_at=$5,lease_until=$6,sealed=$7 WHERE scope=$1 AND id=$2 AND revision=$3", [scope, value.id, revision, value.revision, value.expiresAt, value.leaseUntil, value.sealed]);
      return result.rowCount === 1;
    },
    async remove(scope, id) { await client.query("DELETE FROM hanko_sessions WHERE scope=$1 AND id=$2", [scope, id]); },
  };
}
