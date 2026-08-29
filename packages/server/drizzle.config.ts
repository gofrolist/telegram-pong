import { defineConfig } from 'drizzle-kit';

/**
 * Migrations are generated from `src/db/schema.ts` and applied explicitly.
 *
 * `push` is deliberately not part of any workflow: it diffs against a live
 * database and will happily drop a column it cannot account for.
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  // Neon's pooled endpoint does not support the advisory locks drizzle-kit
  // uses for introspection; migrations run against the DIRECT connection
  // string. See the README.
  strict: true,
  verbose: true,
});
