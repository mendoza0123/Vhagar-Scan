// Tiny runner: applies a .sql file to your Neon DB.
//   node scripts/run-sql.mjs db/schema.sql
//   node scripts/run-sql.mjs db/seed.sql
// Reads DATABASE_URL from .env.local
import { readFileSync } from "node:fs";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { config } from "dotenv";

// Next.js reads .env.local; mirror that here so a single file holds the URL.
// .env is loaded as a fallback; neither call overrides an already-set var.
config({ path: ".env.local" });
config();

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/run-sql.mjs <path-to.sql>");
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Copy .env.example to .env.local first.");
  process.exit(1);
}

// The HTTP driver runs one statement per call and can't handle a whole .sql
// file (the $$-quoted process_sale function, BEGIN/COMMIT, etc). The WebSocket
// Pool speaks the full Postgres wire protocol, so pool.query(wholeFile) runs
// every statement in order. Node 18+ ships a global WebSocket constructor.
neonConfig.webSocketConstructor = globalThis.WebSocket;

// Strip a leading UTF-8 BOM — PowerShell's Out-File (gen-seed.ps1) writes one
// and Postgres rejects it as a syntax error at the very first token.
const sqlText = readFileSync(file, "utf8").replace(/^﻿/, "");
const pool = new Pool({ connectionString: url });

try {
  await pool.query(sqlText);
  console.log(`✓ applied ${file}`);
} catch (e) {
  console.error(`✗ failed on ${file}:`, e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
