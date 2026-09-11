import pg from "pg";

const { Pool } = pg;
export type DatabasePool = InstanceType<typeof Pool>;

export function createDatabasePool(connectionString: string, options: { max?: number } = {}) {
  return new Pool({ connectionString, max: options.max ?? 6, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, allowExitOnIdle: true });
}

export async function assertQueueSchema(pool: DatabasePool) {
  let result;
  try { result = await pool.query<{ version: string }>("SELECT version FROM schema_migrations WHERE version = ANY($1::text[])", [["001_durable_production_queue", "002_queue_lease_fencing"]]); }
  catch (error) { const code=(error as {code?:string}).code;if(code==="42P01")throw new Error("Postgres is reachable but the durable queue schema is missing. Run `npm run db:migrate`.", { cause: error });throw new Error("Unable to connect to the durable queue database. Check DATABASE_URL and confirm Postgres is running.",{cause:error}); }
  if (result.rowCount !== 2) throw new Error("Durable queue migrations are incomplete. Run `npm run db:migrate`.");
}
