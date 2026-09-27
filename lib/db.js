// Shared Neon Postgres client for all API routes.
//
// Uses @neondatabase/serverless's HTTP-based driver (`neon()`), not a
// pooled TCP connection — the right choice for Vercel Functions, which are
// short-lived and would otherwise exhaust a traditional connection pool
// under concurrent invocations. Each call is a single HTTP request to
// Neon's data API; no connection to manage or close.
//
// Usage: const sql = require('../lib/db'); const rows = await sql`select * from plants`;

const { neon } = require('@neondatabase/serverless');

if (!process.env.DATABASE_URL) {
  // Fails loudly at import time rather than on the first query, so a
  // missing env var shows up immediately in the function logs.
  throw new Error(
    'DATABASE_URL is not set. Add the Neon connection string as a Vercel ' +
    'environment variable (Project Settings -> Environment Variables), or ' +
    'via the Neon Marketplace integration which sets it automatically.'
  );
}

const sql = neon(process.env.DATABASE_URL);

module.exports = sql;
