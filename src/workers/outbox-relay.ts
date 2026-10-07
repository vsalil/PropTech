import "dotenv/config";
import amqp from "amqplib";
import { Pool } from "pg";

type OutboxEvent = {
  event_id: string;
  tenant_id: string;
  event_type: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
  payload: Record<string, unknown>;
  attempts: number;
};

const databaseUrl = process.env.DATABASE_URL;
const rabbitUrl = process.env.RABBITMQ_URL;
if (!databaseUrl || !rabbitUrl) {
  throw new Error("DATABASE_URL and RABBITMQ_URL are required");
}

const pool = new Pool({ connectionString: databaseUrl });
const connection = await amqp.connect(rabbitUrl);
const channel = await connection.createConfirmChannel();
const exchange = "proptech.events";
const queue = "proptech.events.local";
await channel.assertExchange(exchange, "topic", { durable: true });
await channel.assertQueue(queue, { durable: true });
await channel.bindQueue(queue, exchange, "#");
let brokerClosed = false;
// Records broker disconnection so the relay can stop its polling loop.
connection.on("close", () => {
  brokerClosed = true;
});
// Logs broker connection failures without exposing connection details.
connection.on("error", (error) => {
  console.error(JSON.stringify({
    event: "outbox_broker_connection_error",
    errorName: error instanceof Error ? error.name : "UnknownError",
  }));
});

// Claims a small batch of eligible outbox events while locking them against concurrent workers.
async function claimBatch(): Promise<OutboxEvent[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<OutboxEvent>(
      `WITH claimed AS (
         SELECT event_id
         FROM outbox_events
         WHERE published_at IS NULL
           AND dead_lettered_at IS NULL
           AND available_at <= now()
           AND (locked_until IS NULL OR locked_until < now())
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 5
       )
       UPDATE outbox_events o
       SET locked_until = now() + interval '60 seconds'
       FROM claimed
       WHERE o.event_id = claimed.event_id
       RETURNING o.event_id, o.tenant_id, o.event_type, o.correlation_id,
                 o.causation_id, o.created_at, o.payload, o.attempts`,
    );
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Publishes an event and resolves only after RabbitMQ confirms durable receipt.
function publishConfirmed(
  routingKey: string,
  event: OutboxEvent,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Rejects publishing when the broker does not confirm within the deadline.
    const timeout = setTimeout(() => {
      reject(new Error("broker publisher confirm timed out"));
    }, 10_000);
    channel.publish(
      exchange,
      routingKey,
      Buffer.from(JSON.stringify({
        eventId: event.event_id,
        eventType: event.event_type,
        schemaVersion: 1,
        occurredAt: event.created_at.toISOString(),
        tenantId: event.tenant_id,
        correlationId: event.correlation_id,
        causationId: event.causation_id,
        data: event.payload,
      })),
      {
        persistent: true,
        contentType: "application/json",
        messageId: event.event_id,
        headers: {
          eventType: event.event_type,
          tenantId: event.tenant_id,
          schemaVersion: 1,
        },
      },
      // Completes the publish promise when RabbitMQ confirms or rejects the message.
      (error) => {
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      },
    );
  });
}

// Publishes one event and records success, retry timing, or dead-letter status in PostgreSQL.
async function deliver(event: OutboxEvent): Promise<void> {
  try {
    await publishConfirmed(event.event_type, event);
    await pool.query(
      `UPDATE outbox_events
       SET published_at = now(), locked_until = NULL, last_error = NULL
       WHERE event_id = $1 AND published_at IS NULL`,
      [event.event_id],
    );
  } catch (error) {
    const delaySeconds = Math.min(300, 2 ** Math.min(event.attempts, 8));
    const exhausted = event.attempts + 1 >= 12;
    if (exhausted) {
      await pool.query(
        `UPDATE outbox_events
         SET attempts = attempts + 1,
             dead_lettered_at = now(),
             locked_until = NULL,
             last_error = 'broker publish retry budget exhausted'
         WHERE event_id = $1 AND published_at IS NULL`,
        [event.event_id],
      );
    } else {
      await pool.query(
        `UPDATE outbox_events
         SET attempts = attempts + 1,
             available_at = now() + ($2 * interval '1 second'),
             locked_until = NULL,
             last_error = 'broker publish failed'
         WHERE event_id = $1 AND published_at IS NULL`,
        [event.event_id, delaySeconds],
      );
    }
    console.error(JSON.stringify({
      event: exhausted ? "outbox_event_dead_lettered" : "outbox_publish_failed",
      eventId: event.event_id,
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
  }
}

let stopping = false;
// Stops polling after the process receives an interrupt signal.
process.on("SIGINT", () => { stopping = true; });
// Stops polling after the process receives a termination signal.
process.on("SIGTERM", () => { stopping = true; });

try {
  while (!stopping && !brokerClosed) {
    try {
      const events = await claimBatch();
      if (events.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      for (const event of events) {
        await deliver(event);
      }
    } catch (error) {
      // Logs a failed polling iteration and waits before retrying.
      console.error(JSON.stringify({
        event: "outbox_relay_iteration_failed",
        errorName: error instanceof Error ? error.name : "UnknownError",
      }));
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
} finally {
  await Promise.allSettled([channel.close(), connection.close()]);
  await pool.end();
}

if (brokerClosed && !stopping) {
  process.exitCode = 1;
}
