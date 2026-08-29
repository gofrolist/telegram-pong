/**
 * Migration runner.
 *
 * Run against the **direct** Neon connection string, not the pooled one:
 * pgbouncer in transaction mode cannot hold the session-level advisory lock a
 * migration needs, and DDL through a pooler can interleave with itself.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL or DATABASE_URL is required');
  process.exit(1);
}

if (url.includes('-pooler.')) {
  console.warn(
    '[migrate] this looks like a POOLED Neon connection string. ' +
      'Migrations should use the direct one — set MIGRATION_DATABASE_URL.',
  );
}

// `max: 1` — a migration is a single ordered session, never a pool.
const sql = postgres(url, { max: 1, prepare: false });

try {
  await migrate(drizzle(sql), { migrationsFolder: './drizzle' });
  console.log('[migrate] up to date');
} finally {
  await sql.end({ timeout: 5 });
}
