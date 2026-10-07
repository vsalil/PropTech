import { Pool, type PoolClient } from "pg";
import {
  assertVerificationBinding,
  IdempotencyConflictError,
  IdentityGateError,
  TenantChannelNotConfiguredError,
  TenantContactMismatchError,
} from "./domain.js";
import type {
  CreatedMaintenanceRequest,
  IdentityVerificationInput,
  InboundMessage,
  MaintenanceRequestInput,
} from "./domain.js";
import type { WorkflowRepository } from "./repository.js";

// Writes a domain event to the outbox inside the caller's transaction.
async function insertOutboxEvent(
  client: PoolClient,
  tenantId: string,
  eventType: string,
  correlationId: string,
  causationId: string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO outbox_events
       (tenant_id, event_type, correlation_id, causation_id, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [tenantId, eventType, correlationId, causationId, JSON.stringify(payload)],
  );
}

export class PostgresWorkflowRepository implements WorkflowRepository {
  /** Stores the connection pool used by repository operations. */
  constructor(private readonly pool: Pool) {}

  // Confirms the database is reachable and the required schema migration is applied.
  async checkHealth(): Promise<void> {
    const result = await this.pool.query(
      "SELECT 1 FROM schema_migrations WHERE version = '001_initial'",
    );
    if (result.rowCount !== 1) {
      throw new Error("Database migrations are not applied");
    }
  }

  // Stores a tenant-mapped inbound message and its outbox event atomically.
  async persistInboundMessage(message: InboundMessage): Promise<string | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const channel = await client.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM whatsapp_channels
         WHERE phone_number_id = $1 AND enabled = true`,
        [message.phoneNumberId],
      );
      if (channel.rowCount !== 1) {
        throw new TenantChannelNotConfiguredError();
      }
      const tenantId = channel.rows[0]!.tenant_id;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO inbound_messages
           (tenant_id, whatsapp_message_id, whatsapp_id, message_type, body, provider_timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (whatsapp_message_id) DO NOTHING
         RETURNING id`,
        [
          tenantId,
          message.whatsappMessageId,
          message.whatsappId,
          message.messageType,
          message.body,
          message.providerTimestamp,
        ],
      );
      const inboundMessageId = inserted.rows[0]?.id;
      if (!inboundMessageId) {
        await client.query("COMMIT");
        return null;
      }
      await insertOutboxEvent(
        client,
        tenantId,
        "tenant.message.received.v1",
        inboundMessageId,
        message.whatsappMessageId,
        { inboundMessageId },
      );
      await client.query("COMMIT");
      return inboundMessageId;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // Persists an identity proof only when its UAE PASS subject matches the tenant contact.
  async persistIdentityVerification(
    input: IdentityVerificationInput,
  ): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const binding = await client.query(
        `SELECT 1 FROM tenant_contacts
         WHERE tenant_id = $1 AND whatsapp_id = $2 AND uaepass_subject = $3`,
        [input.tenantId, input.whatsappId, input.uaepassSubject],
      );
      if (binding.rowCount !== 1) {
        throw new TenantContactMismatchError();
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO tenant_verifications
           (tenant_id, whatsapp_id, uaepass_subject, issuer, assurance_level, authenticated_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, uaepass_subject, authenticated_at) DO NOTHING
         RETURNING id`,
        [
          input.tenantId,
          input.whatsappId,
          input.uaepassSubject,
          input.issuer,
          input.assuranceLevel,
          input.authenticatedAt,
          input.expiresAt,
        ],
      );
      let verificationId = inserted.rows[0]?.id;
      if (!verificationId) {
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM tenant_verifications
           WHERE tenant_id = $1 AND uaepass_subject = $2 AND authenticated_at = $3`,
          [input.tenantId, input.uaepassSubject, input.authenticatedAt],
        );
        verificationId = existing.rows[0]?.id;
        if (!verificationId) {
          throw new Error("Could not resolve duplicate UAE PASS verification");
        }
      } else {
        await insertOutboxEvent(
          client,
          input.tenantId,
          "tenant.identity.verified.v1",
          verificationId,
          null,
          { verificationId, whatsappId: input.whatsappId },
        );
      }
      await client.query("COMMIT");
      return verificationId;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // Creates a maintenance request only after identity binding checks, recording its event atomically.
  async createMaintenanceRequest(
    input: MaintenanceRequestInput,
  ): Promise<CreatedMaintenanceRequest> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${input.tenantId}:${input.idempotencyKey}`],
      );

      const gate = await client.query<{
        inbound_tenant_id: string;
        inbound_whatsapp_id: string;
        inbound_status: string;
        verification_tenant_id: string;
        verification_whatsapp_id: string;
        verification_subject: string;
        contact_subject: string | null;
        verification_expires_at: Date;
      }>(
        `SELECT i.tenant_id AS inbound_tenant_id,
                i.whatsapp_id AS inbound_whatsapp_id,
                i.status AS inbound_status,
                v.tenant_id AS verification_tenant_id,
                v.whatsapp_id AS verification_whatsapp_id,
                v.uaepass_subject AS verification_subject,
                c.uaepass_subject AS contact_subject,
                v.expires_at AS verification_expires_at
         FROM inbound_messages i
         JOIN tenant_verifications v
           ON v.id = $3 AND v.tenant_id = i.tenant_id
         JOIN tenant_contacts c
           ON c.tenant_id = v.tenant_id AND c.whatsapp_id = v.whatsapp_id
         WHERE i.id = $2 AND i.tenant_id = $1
         FOR UPDATE OF i`,
        [input.tenantId, input.inboundMessageId, input.verificationId],
      );
      const binding = gate.rows[0];
      if (!binding) {
        throw new IdentityGateError(
          "Inbound message or tenant-bound UAE PASS verification was not found",
        );
      }
      const existing = await client.query<{
        id: string;
        status: string;
        inbound_message_id: string;
        verification_id: string;
        property_reference: string;
        category: string;
        summary: string;
      }>(
        `SELECT id, status, inbound_message_id, verification_id,
                property_reference, category, summary
         FROM maintenance_requests
         WHERE tenant_id = $1 AND idempotency_key = $2`,
        [input.tenantId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        const request = existing.rows[0];
        if (
          request.inbound_message_id !== input.inboundMessageId ||
          request.verification_id !== input.verificationId ||
          request.property_reference !== input.propertyReference ||
          request.category !== input.category ||
          request.summary !== input.summary
        ) {
          throw new IdempotencyConflictError();
        }
        await client.query("COMMIT");
        return { id: request.id, status: request.status, created: false };
      }
      if (!binding.contact_subject) {
        throw new IdentityGateError("Tenant contact has no linked UAE PASS identity");
      }
      assertVerificationBinding({
        inboundTenantId: binding.inbound_tenant_id,
        inboundWhatsappId: binding.inbound_whatsapp_id,
        verificationTenantId: binding.verification_tenant_id,
        verificationWhatsappId: binding.verification_whatsapp_id,
        contactSubject: binding.contact_subject,
        verificationSubject: binding.verification_subject,
        verificationExpiresAt: binding.verification_expires_at,
        now: new Date(),
      });
      if (binding.inbound_status !== "INTAKE_PENDING_IDENTITY") {
        throw new IdentityGateError("Inbound message is not eligible for request creation");
      }

      const created = await client.query<{ id: string; status: string }>(
        `INSERT INTO maintenance_requests
           (tenant_id, inbound_message_id, verification_id, idempotency_key,
            property_reference, category, summary)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, status`,
        [
          input.tenantId,
          input.inboundMessageId,
          input.verificationId,
          input.idempotencyKey,
          input.propertyReference,
          input.category,
          input.summary,
        ],
      );
      const request = created.rows[0];
      if (!request) {
        throw new Error("Maintenance request insert returned no row");
      }
      await client.query(
        `UPDATE inbound_messages SET status = 'CONVERTED'
         WHERE id = $1 AND tenant_id = $2`,
        [input.inboundMessageId, input.tenantId],
      );
      await insertOutboxEvent(
        client,
        input.tenantId,
        "maintenance.requested.v1",
        input.inboundMessageId,
        input.verificationId,
        { maintenanceRequestId: request.id },
      );
      await client.query("COMMIT");
      return { ...request, created: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
