import assert from "node:assert/strict";
import test from "node:test";
import { assertVerificationBinding, IdentityGateError, TenantContactMismatchError } from "./domain.js";

const baseBinding = {
  inboundTenantId: "tenant-a",
  inboundWhatsappId: "971500000001",
  verificationTenantId: "tenant-a",
  verificationWhatsappId: "971500000001",
  contactSubject: "uaepass-subject-1",
  verificationSubject: "uaepass-subject-1",
  verificationExpiresAt: new Date("2026-10-06T12:30:00.000Z"),
  now: new Date("2026-10-06T12:00:00.000Z"),
};

// Confirms an active proof bound to the same tenant and WhatsApp contact is accepted.
test("verification gate accepts a live identity bound to the same tenant and WhatsApp contact", () => {
  assert.doesNotThrow(() => assertVerificationBinding(baseBinding));
});

// Confirms proofs from another tenant or WhatsApp contact are rejected.
test("verification gate rejects cross-tenant or cross-contact identities", () => {
  assert.throws(
    () => assertVerificationBinding({ ...baseBinding, verificationTenantId: "tenant-b" }),
    TenantContactMismatchError,
  );
  assert.throws(
    () => assertVerificationBinding({ ...baseBinding, verificationWhatsappId: "971500000002" }),
    TenantContactMismatchError,
  );
});

// Confirms an expired identity proof cannot pass the verification gate.
test("verification gate rejects expired proof", () => {
  assert.throws(
    () => assertVerificationBinding({
      ...baseBinding,
      verificationExpiresAt: new Date("2026-10-06T11:59:59.000Z"),
    }),
    IdentityGateError,
  );
});
