import { createHmac, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import rawBody from "fastify-raw-body";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import {
  IdempotencyConflictError,
  IdentityGateError,
  TenantChannelNotConfiguredError,
} from "./domain.js";
import type {
  IdentityVerificationInput,
  InboundMessage,
  MaintenanceRequestInput,
} from "./domain.js";
import type { WorkflowRepository } from "./repository.js";

const whatsappPayloadSchema = z.object({
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          value: z.object({
            metadata: z.object({ phone_number_id: z.string().min(1).max(128) }),
            messages: z
              .array(
                z.object({
                  from: z.string().min(1).max(128),
                  id: z.string().min(1).max(512),
                  timestamp: z.string().regex(/^\d{1,12}$/),
                  type: z.string().min(1).max(64),
                  text: z.object({ body: z.string().max(50_000) }).optional(),
                }).passthrough(),
              )
              .optional(),
          }).passthrough(),
        }),
      ),
    }),
  ),
}).passthrough();

const identityVerificationSchema = z.object({
  tenantId: z.string().uuid(),
  whatsappId: z.string().min(1).max(128),
  uaepassSubject: z.string().min(1).max(512),
  issuer: z.string().url(),
  assuranceLevel: z.string().max(64).nullable(),
  authenticatedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
});

const maintenanceRequestSchema = z.object({
  tenantId: z.string().uuid(),
  inboundMessageId: z.string().uuid(),
  verificationId: z.string().uuid(),
  propertyReference: z.string().min(1).max(256),
  category: z.string().min(1).max(128),
  summary: z.string().min(1).max(2_000),
});

// Verifies the SHA-256 HMAC signature supplied by Meta for a raw webhook body.
export function verifyMetaSignature(
  rawBodyValue: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader || !/^sha256=[a-f0-9]{64}$/i.test(signatureHeader)) {
    return false;
  }
  const expected = createHmac("sha256", appSecret).update(rawBodyValue).digest();
  const actual = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Compares a supplied secret without leaking content through timing differences.
function equalSecret(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

// Validates a WhatsApp webhook payload and converts its messages to the repository format.
export function extractWhatsAppMessages(payload: unknown): InboundMessage[] {
  const parsed = whatsappPayloadSchema.parse(payload);
  const messages: InboundMessage[] = [];
  for (const entry of parsed.entry) {
    for (const change of entry.changes) {
      for (const message of change.value.messages ?? []) {
        const timestamp = Number(message.timestamp);
        messages.push({
          phoneNumberId: change.value.metadata.phone_number_id,
          whatsappMessageId: message.id,
          whatsappId: message.from,
          messageType: message.type,
          body: message.text?.body ?? null,
          providerTimestamp: Number.isSafeInteger(timestamp)
            ? new Date(timestamp * 1_000)
            : null,
        });
      }
    }
  }
  return messages;
}

// Checks the bearer token used to protect internal service endpoints.
function isInternalRequest(request: {
  headers: Record<string, string | string[] | undefined>;
}, token: string): boolean {
  const authorization = request.headers.authorization;
  return (
    typeof authorization === "string" &&
    authorization.startsWith("Bearer ") &&
    equalSecret(authorization.slice("Bearer ".length), token)
  );
}

// Creates the Fastify app, registers webhook and internal workflow routes, and configures logging.
export async function createApp(
  config: AppConfig,
  repository: WorkflowRepository,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === "test" ? "silent" : "info",
      redact: [
        "req.headers.authorization",
        "req.headers.x-hub-signature-256",
        "req.body",
      ],
    },
    bodyLimit: 1_000_000,
  });

  await app.register(rawBody, {
    field: "rawBody",
    global: false,
    encoding: false,
    runFirst: true,
  });

  // Confirms the process is alive without checking downstream dependencies.
  app.get("/health/live", async () => ({ status: "ok" }));

  // Reports ready only when the repository confirms the database schema is available.
  app.get("/health/ready", async (_request, reply) => {
    try {
      await repository.checkHealth();
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ error: "dependency_unavailable" });
    }
  });

  app.get<{ Querystring: { "hub.mode"?: string; "hub.verify_token"?: string; "hub.challenge"?: string } }>(
    "/webhooks/whatsapp",
    // Validates Meta's webhook subscription challenge and echoes it on success.
    async (request, reply) => {
      const query = request.query;
      if (
        query["hub.mode"] !== "subscribe" ||
        !equalSecret(query["hub.verify_token"], config.WHATSAPP_VERIFY_TOKEN) ||
        !query["hub.challenge"]
      ) {
        return reply.code(403).send({ error: "webhook_verification_failed" });
      }
      return reply.type("text/plain").send(query["hub.challenge"]);
    },
  );

  app.post<{ Body: unknown }>(
    "/webhooks/whatsapp",
    { config: { rawBody: true } },
    // Verifies Meta's signature, validates incoming messages, and persists them idempotently.
    async (request, reply) => {
      const raw = request.rawBody;
      const signatureHeader = request.headers["x-hub-signature-256"];
      if (
        !Buffer.isBuffer(raw) ||
        !verifyMetaSignature(
          raw,
          Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader,
          config.WHATSAPP_APP_SECRET,
        )
      ) {
        return reply.code(401).send({ error: "invalid_webhook_signature" });
      }

      const parsed = whatsappPayloadSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_webhook_payload" });
      }
      const messages = extractWhatsAppMessages(parsed.data);
      let stored = 0;
      try {
        for (const message of messages) {
          const id = await repository.persistInboundMessage(message);
          if (id) stored += 1;
        }
      } catch (error) {
        if (error instanceof TenantChannelNotConfiguredError) {
          return reply.code(503).send({ error: "tenant_channel_not_configured" });
        }
        throw error;
      }
      return reply.code(200).send({ accepted: messages.length, stored });
    },
  );

  app.post<{ Body: unknown }>(
    "/internal/identity-verifications",
    // Authenticates the internal caller and records a validated, contact-bound identity proof.
    async (request, reply) => {
      if (!isInternalRequest(request, config.INTERNAL_SERVICE_TOKEN)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const parsed = identityVerificationSchema.safeParse(request.body);
      if (!parsed.success || parsed.data.issuer !== config.UAE_PASS_ISSUER) {
        return reply.code(400).send({ error: "invalid_identity_verification" });
      }
      const authenticatedAt = new Date(parsed.data.authenticatedAt);
      const expiresAt = new Date(parsed.data.expiresAt);
      const now = Date.now();
      if (
        authenticatedAt.getTime() > now + 30_000 ||
        expiresAt.getTime() <= now ||
        expiresAt.getTime() - authenticatedAt.getTime() > 24 * 60 * 60 * 1_000
      ) {
        return reply.code(400).send({ error: "invalid_identity_verification_window" });
      }
      const input: IdentityVerificationInput = {
        ...parsed.data,
        assuranceLevel: parsed.data.assuranceLevel,
        authenticatedAt,
        expiresAt,
      };
      try {
        const verificationId = await repository.persistIdentityVerification(input);
        return reply.code(201).send({ verificationId });
      } catch (error) {
        if (error instanceof IdentityGateError) {
          return reply.code(403).send({ error: "identity_binding_rejected" });
        }
        throw error;
      }
    },
  );

  app.post<{ Body: unknown }>(
    "/internal/maintenance-requests",
    // Authenticates the caller and creates an identity-gated request with idempotency handling.
    async (request, reply) => {
      if (!isInternalRequest(request, config.INTERNAL_SERVICE_TOKEN)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const parsed = maintenanceRequestSchema.safeParse(request.body);
      const idempotencyKey = request.headers["idempotency-key"];
      if (
        !parsed.success ||
        typeof idempotencyKey !== "string" ||
        idempotencyKey.length < 8 ||
        idempotencyKey.length > 128
      ) {
        return reply.code(400).send({ error: "invalid_maintenance_request" });
      }
      const input: MaintenanceRequestInput = {
        ...parsed.data,
        idempotencyKey,
      };
      try {
        const result = await repository.createMaintenanceRequest(input);
        return reply.code(result.created ? 202 : 200).send({
          maintenanceRequestId: result.id,
          status: result.status,
          created: result.created,
        });
      } catch (error) {
        if (error instanceof IdempotencyConflictError) {
          return reply.code(409).send({ error: "idempotency_conflict" });
        }
        if (error instanceof IdentityGateError) {
          return reply.code(403).send({ error: "identity_verification_required" });
        }
        throw error;
      }
    },
  );

  // Logs unexpected request failures without exposing sensitive details to clients.
  app.setErrorHandler((error, request, reply) => {
    request.log.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Request failed",
    );
    return reply.code(500).send({ error: "internal_server_error" });
  });

  return app;
}
