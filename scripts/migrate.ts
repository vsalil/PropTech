import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import "dotenv/config";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

const pool = new Pool({ connectionString });

try {
  // Applies the versioned initial schema migration from the repository.
  const migration = await readFile(
    resolve(process.cwd(), "db/migrations/001_initial.sql"),
    "utf8",
  );
  await pool.query(migration);
  console.info("Database migrations applied");
} finally {
  await pool.end();
}
