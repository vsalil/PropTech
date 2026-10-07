export type InboundMessage = {
  phoneNumberId: string;
  whatsappMessageId: string;
  whatsappId: string;
  messageType: string;
  body: string | null;
  providerTimestamp: Date | null;
};

export type IdentityVerificationInput = {
  tenantId: string;
  whatsappId: string;
  uaepassSubject: string;
  issuer: string;
  assuranceLevel: string | null;
  authenticatedAt: Date;
  expiresAt: Date;
};

export type MaintenanceRequestInput = {
  tenantId: string;
  inboundMessageId: string;
  verificationId: string;
  idempotencyKey: string;
  propertyReference: string;
  category: string;
  summary: string;
};

export type CreatedMaintenanceRequest = {
  id: string;
  status: string;
  created: boolean;
};

export class TenantChannelNotConfiguredError extends Error {
  /** Identifies webhook messages whose phone-number channel has no active tenant mapping. */
  constructor() {
    super("WhatsApp channel is not configured");
    this.name = "TenantChannelNotConfiguredError";
  }
}

export class IdentityGateError extends Error {
  /** Creates a workflow error with a specific identity-gate failure reason. */
  constructor(message: string) {
    super(message);
    this.name = "IdentityGateError";
  }
}

export class TenantContactMismatchError extends IdentityGateError {
  /** Represents an identity proof that does not match the tenant's configured contact. */
  constructor() {
    super("Verified identity is not bound to this tenant contact");
    this.name = "TenantContactMismatchError";
  }
}

export class IdempotencyConflictError extends Error {
  /** Identifies reuse of an idempotency key for different request details. */
  constructor() {
    super("Idempotency key was already used for a different maintenance request");
    this.name = "IdempotencyConflictError";
  }
}

// Ensures the inbound message and unexpired UAE PASS proof belong to the same tenant and contact.
export function assertVerificationBinding(input: {
  inboundTenantId: string;
  inboundWhatsappId: string;
  verificationTenantId: string;
  verificationWhatsappId: string;
  contactSubject: string;
  verificationSubject: string;
  verificationExpiresAt: Date;
  now: Date;
}): void {
  if (
    input.inboundTenantId !== input.verificationTenantId ||
    input.inboundWhatsappId !== input.verificationWhatsappId ||
    input.contactSubject !== input.verificationSubject
  ) {
    throw new TenantContactMismatchError();
  }
  if (input.verificationExpiresAt.getTime() <= input.now.getTime()) {
    throw new IdentityGateError("UAE PASS verification is expired");
  }
}
