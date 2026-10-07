import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import { createApp, extractWhatsAppMessages, verifyMetaSignature } from "./app.js";
import type { AppConfig } from "./config.js";
import type { WorkflowRepository } from "./repository.js";

const config: AppConfig = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3000,
  DATABASE_URL: "postgres://unused",
  RABBITMQ_URL: "amqp://unused",
  WHATSAPP_APP_SECRET: "test-meta-secret",
  WHATSAPP_VERIFY_TOKEN: "test-verify-token",
  INTERNAL_SERVICE_TOKEN: "a".repeat(48),
  UAE_PASS_ISSUER: "https://id.uaepass.ae",
};

class FakeRepository implements WorkflowRepository {
  readonly inbound: Array<{ phoneNumberId: string; whatsappMessageId: string }> = [];
  ready = true;

  // Simulates database readiness for API route tests.
  async checkHealth(): Promise<void> {
    if (!this.ready) {
      throw new Error("database migrations are not applied");
    }
  }

  // Records a submitted message and returns a generated identifier.
  async persistInboundMessage(message: {
    phoneNumberId: string;
    whatsappMessageId: string;
  }): Promise<string> {
    this.inbound.push(message);
    return randomUUID();
  }

  // Returns a generated identifier for a simulated identity verification.
  async persistIdentityVerification(): Promise<string> {
    return randomUUID();
  }

  // Returns a successful simulated maintenance request.
  async createMaintenanceRequest(): Promise<{
    id: string;
    status: string;
    created: boolean;
  }> {
    return { id: randomUUID(), status: "PMS_SYNC_PENDING", created: true };
  }
}

// Confirms signatures validate only the exact body that Meta signed.
test("Meta signature uses the exact raw body and rejects modified content", () => {
  const body = Buffer.from('{"object":"whatsapp_business_account"}');
  const signature = `sha256=${createHmac("sha256", config.WHATSAPP_APP_SECRET).update(body).digest("hex")}`;
  assert.equal(verifyMetaSignature(body, signature, config.WHATSAPP_APP_SECRET), true);
  assert.equal(verifyMetaSignature(Buffer.from(`${body.toString()} `), signature, config.WHATSAPP_APP_SECRET), false);
  assert.equal(verifyMetaSignature(body, "sha256=invalid", config.WHATSAPP_APP_SECRET), false);
});

// Confirms webhook parsing preserves text and metadata for non-text messages.
test("webhook parser extracts text and retains non-text message metadata", () => {
  const messages = extractWhatsAppMessages({
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: "phone-number-1" },
          messages: [
            {
              from: "971500000001",
              id: "wamid.1",
              timestamp: "1791288000",
              type: "text",
              text: { body: "Leaking under the kitchen sink" },
            },
            {
              from: "971500000001",
              id: "wamid.2",
              timestamp: "1791288001",
              type: "image",
              image: { id: "media-id" },
            },
          ],
        },
      }],
    }],
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.phoneNumberId, "phone-number-1");
  assert.equal(messages[0]?.body, "Leaking under the kitchen sink");
  assert.equal(messages[1]?.messageType, "image");
  assert.equal(messages[1]?.body, null);
});

// Confirms unsigned webhooks are rejected and valid signed messages are stored.
test("webhook route rejects unsigned calls and acknowledges signed events", async () => {
  const repository = new FakeRepository();
  const app = await createApp(config, repository);
  try {
    const raw = JSON.stringify({
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: "phone-number-1" },
            messages: [{
              from: "971500000001",
              id: "wamid.3",
              timestamp: "1791288000",
              type: "text",
              text: { body: "AC not cooling" },
            }],
          },
        }],
      }],
    });
    const unsigned = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      headers: { "content-type": "application/json" },
      payload: raw,
    });
    assert.equal(unsigned.statusCode, 401);

    const signature = `sha256=${createHmac("sha256", config.WHATSAPP_APP_SECRET).update(raw).digest("hex")}`;
    const signed = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
      },
      payload: raw,
    });
    assert.equal(signed.statusCode, 200);
    assert.equal(signed.json<{ accepted: number; stored: number }>().stored, 1);
    assert.equal(repository.inbound[0]?.phoneNumberId, "phone-number-1");
  } finally {
    await app.close();
  }
});

// Confirms internal workflow endpoints reject requests without the service token.
test("internal identity and maintenance routes reject callers without service authentication", async () => {
  const app = await createApp(config, new FakeRepository());
  try {
    const verification = await app.inject({
      method: "POST",
      url: "/internal/identity-verifications",
      payload: {},
    });
    assert.equal(verification.statusCode, 401);

    const request = await app.inject({
      method: "POST",
      url: "/internal/maintenance-requests",
      payload: {},
    });
    assert.equal(request.statusCode, 401);
  } finally {
    await app.close();
  }
});

// Confirms readiness reports unavailable while repository dependencies are not ready.
test("readiness stays unavailable until repository dependencies are ready", async () => {
  const repository = new FakeRepository();
  repository.ready = false;
  const app = await createApp(config, repository);
  try {
    const response = await app.inject({
      method: "GET",
      url: "/health/ready",
    });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: "dependency_unavailable" });
  } finally {
    await app.close();
  }
});
