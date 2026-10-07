import "dotenv/config";
import { Pool } from "pg";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { PostgresWorkflowRepository } from "./postgres-repository.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.DATABASE_URL });
const app = await createApp(config, new PostgresWorkflowRepository(pool));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  // Releases the database connection if the HTTP server cannot start.
  app.log.error({ errorName: error instanceof Error ? error.name : "UnknownError" }, "Server startup failed");
  await pool.end();
  process.exitCode = 1;
}

// Closes the HTTP server and database pool cleanly during process shutdown.
const shutdown = async (): Promise<void> => {
  await app.close();
  await pool.end();
};

// Begins graceful shutdown when the process receives an operating-system signal.
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
