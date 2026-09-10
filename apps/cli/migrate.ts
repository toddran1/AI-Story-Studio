#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvironment } from "../../src/config/env.js";
import { createDatabasePool } from "../../src/queue/database.js";

const env = loadEnvironment();
if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required. Add a Postgres connection URL to .env.");
const pool = createDatabasePool(env.DATABASE_URL, { max: 1 });
try {
  const directory = resolve(process.cwd(), "migrations");
  for (const name of (await readdir(directory)).filter((value) => /^\d+.*\.sql$/.test(value)).sort()) {
    const version = name.replace(/\.sql$/, "");
    await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const existing = await pool.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
    if (existing.rowCount) { process.stdout.write(`Already applied ${name}\n`); continue; }
    await pool.query(await readFile(resolve(directory, name), "utf8"));
    process.stdout.write(`Applied ${name}\n`);
  }
} finally { await pool.end(); }
