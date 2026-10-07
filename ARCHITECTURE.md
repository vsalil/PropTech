# Dubai PropTech SaaS — Architecture Blueprint

**Status:** Initial target architecture and implementation baseline  
**Region:** AWS Middle East (UAE), `me-central-1`  
**Isolation:** Dedicated runtime and tenant database per property manager  
**Backend baseline:** Node.js 22 LTS, TypeScript, Fastify, PostgreSQL  

## 1. Scope and invariants

The platform accepts maintenance-related tenant messages through WhatsApp, retains them durably, obtains the required identity verification, turns verified requests into maintenance work, and synchronizes that work to the property manager's existing PMS (for example, Yardi).

Non-negotiable invariants:

1. An inbound message is **not** a maintenance request. It can be durably recorded while identity verification is pending.
2. A maintenance request cannot be created unless the tenant has a valid UAE PASS verification associated with the correct property-manager tenant and WhatsApp identity.
3. No dispatch is reported as successful until the PMS confirms the external work order (or an explicitly approved alternative dispatch path is recorded).
4. A PMS outage must not lose an accepted request or make an unconfirmed external side effect look successful.
5. Each property manager's operational data and runtime reside in a dedicated tenant cell. Cross-tenant access is denied by construction and tested at API and database boundaries.

This is a design baseline, not legal advice or a claim of regulatory certification. Validate applicable UAE federal, Dubai, free-zone, contractual, and sector-specific requirements with counsel and each customer.

## 2. System context and workflow

```mermaid
sequenceDiagram
    participant T as Tenant (WhatsApp)
    participant M as Meta WhatsApp Cloud API
    participant G as Inbound Gateway
    participant DB as Tenant PostgreSQL
    participant ID as UAE PASS Identity Service
    participant AI as Triage Service
    participant C as Maintenance Core
    participant O as Outbox Relay / Broker
    participant Y as PMS Integration (Yardi)
    participant N as Notification Service

    T->>M: Message
    M->>G: Signed webhook
    G->>DB: Idempotently persist inbound message + outbox event
    G-->>M: 200 after durable commit
    O->>AI: tenant.message.received
    AI->>DB: Store proposed classification (no request creation)
    N->>T: UAE PASS verification link / next step
    T->>ID: Authenticate with UAE PASS
    ID->>DB: Persist verified subject binding (OIDC validation required)
    ID->>C: identity.verified
    C->>DB: Validate same tenant/contact + unexpired verification; create request + outbox atomically
    O->>Y: maintenance.requested
    Y->>Y: Idempotent upsert/create in PMS
    Y->>DB: Persist PMS work-order reference and sync result
    Y->>O: maintenance.pms_synced
    N->>T: Confirm only after appropriate state transition
```

The initial WhatsApp reply can explain that verification is required and provide the identity flow. Keep the original message linked to a short-lived pending intake; after verification, resume triage and require any missing property/unit details. Use a customer-approved emergency process for urgent safety incidents; do not bypass identity silently.

## 3. Microservices

Services are bounded by business ownership and can be separately scaled/deployed. The initial codebase is a TypeScript monorepo; service boundaries are contracts, not a requirement to create a network hop for every module on day one.

| Service | Owns / responsibilities | Recommended implementation and data |
|---|---|---|
| Tenant Control Plane | Manager onboarding, cell provisioning, plan/feature flags, domain/branding, tenant-to-cell and WhatsApp number routing. No tenant message content. | Node.js/TypeScript, Fastify; control-plane PostgreSQL; audited provisioning workflow. |
| Inbound Gateway | Meta webhook handshake/signature verification, payload validation, deduplication, tenant routing, durable message acceptance. Never creates a maintenance request. | Node.js/TypeScript, Fastify; tenant-cell PostgreSQL inbox/outbox; rate limiting at edge. |
| Identity & Consent | UAE PASS OAuth 2.0/OIDC authorization-code flow, state/nonce/PKCE as supported by the UAE PASS service-provider profile, issuer/audience/signature/expiry validation, subject-to-tenant-contact binding, consent/audit evidence. | Node.js/TypeScript, Fastify; PostgreSQL; provider JWKS/metadata and credentials from Secrets Manager. Fail closed on provider or validation errors. |
| Conversation / Notification | WhatsApp responses, verification continuation links, templates, delivery-status webhooks, retries and opt-out/preferences. | Node.js/TypeScript worker; PostgreSQL delivery ledger; broker consumer; Meta API adapter. |
| AI Triage | Language detection (Arabic/English), extraction of issue/category/urgency/unit hints, confidence and evidence, prompt/model versioning, redaction, human-review routing. It proposes; it does not authorize or dispatch. | Node.js/TypeScript orchestration; private model endpoint or an approved UAE-resident inference arrangement. Do not send PII to a model/provider before residency, retention, and DPA review. |
| Maintenance Core | Authoritative request state machine, authorization and identity gate, work-order creation, assignment/approval policy, idempotency, audit history. | Node.js/TypeScript, Fastify; PostgreSQL per manager cell; transactional outbox. |
| PMS Integration & Sync Ledger | Adapter-per-PMS, external ID mapping, field mapping, credential rotation, retry scheduling, inbound reconciliation and sync state. | Node.js/TypeScript workers; PostgreSQL sync ledger; broker; per-customer Yardi/API credentials in Secrets Manager. |
| Reporting / Audit Export | Tenant-scoped operational metrics and customer-controlled exports; immutable audit evidence as required by retention policy. | Node.js/TypeScript worker; tenant-scoped database/read model; encrypted S3 export bucket if approved. |
| Platform Operations | Per-cell deployment, secrets/keys, migration orchestration, telemetry, backups, restore tests, quotas and incident tooling. | AWS CDK/Terraform; ECS Fargate or EKS; CloudWatch/OpenTelemetry; KMS. Prefer ECS Fargate until platform requirements justify Kubernetes. |

### Initial deployment cells

- **Shared control plane:** tenant registry, billing metadata, deployment orchestration. No WhatsApp text, identity tokens, or maintenance payloads.
- **Dedicated manager cell:** private service tasks, dedicated PostgreSQL database/cluster and credentials, dedicated broker namespace/virtual host or queue set, dedicated KMS data key, secrets, storage prefix/bucket policy, and per-cell network policies.
- **Cell placement:** deploy in `me-central-1` after enabling the opt-in region and verifying each required AWS service, quota, and AZ capacity. Do not assume every AWS service is available in every region.
- **Connectivity:** public HTTPS ingress only through WAF/API Gateway or ALB; tasks and databases in private subnets; private egress through controlled NAT/VPC endpoints; no inbound public database/broker access.

## 4. Inter-service communication

Use synchronous calls only when the caller needs an immediate decision. Prefer asynchronous commands/events for work that must survive peer outages.

| Interaction | Transport | Semantics |
|---|---|---|
| WhatsApp webhook → Inbound Gateway | HTTPS | Verify Meta signature against exact raw request bytes. Return success only after inbox/outbox transaction commits. |
| Gateway → tenant routing / cell | HTTPS or gRPC | Resolve WhatsApp phone-number ID to one tenant cell; reject unknown or disabled routes. |
| Identity → Maintenance Core | gRPC (private) or authenticated command event | Submit verified subject and correlation; core independently re-checks tenant/contact association and expiry. |
| Core → AI Triage | Asynchronous event; gRPC only for a bounded online assist | AI result is advisory, versioned, and correlated with original message. Timeout/failure means review/pending, not invented certainty. |
| Services → other services | RabbitMQ topic exchange (initial choice) | At-least-once delivery, durable queues, publisher confirms, manual consumer ack after commit, bounded retries and DLQ. |
| Browser/admin API → services | HTTPS REST/JSON | External API boundary, OAuth/OIDC user identity, tenant-scoped authorization; never expose internal service credentials. |

Representative routing keys (version in message schema, not just the key):

```text
tenant.message.received.v1
tenant.identity.verification.requested.v1
tenant.identity.verified.v1
tenant.identity.verification.failed.v1
maintenance.triage.completed.v1
maintenance.requested.v1
maintenance.approval.required.v1
maintenance.approved.v1
maintenance.pms.sync.requested.v1
maintenance.pms.synced.v1
maintenance.pms.sync.failed.v1
notification.send.requested.v1
```

Every event has an immutable `eventId`, `eventType`, `schemaVersion`, `occurredAt`, `tenantId`, `correlationId`, `causationId`, and `data`. Do not place access tokens, Emirates ID numbers, or unnecessary message bodies in broker headers. Use tenant-scoped queue permissions and enforce tenant ID in consumer persistence queries.

## 5. Data and state ownership

| Data | System of record | Notes |
|---|---|---|
| Tenant routing and cell location | Control Plane | No tenant message body or identity token. |
| WhatsApp inbound message and provider ID | Tenant-cell Inbox | Unique provider message ID; encrypt sensitive content; retention/deletion schedule; webhook retries are idempotent. |
| UAE PASS verification evidence | Identity service / tenant DB | Persist minimal subject reference, issuer, authentication time/level when available, consent/audit reference and expiry. Do not retain ID/access tokens unless an approved requirement makes it necessary. |
| Maintenance request and state transitions | Maintenance Core | Append audit/state history; optimistic versioning; request idempotency key. |
| Yardi work-order ID and sync attempts | Integration ledger | External reference, last outcome, retry time and reconciliation status. Never treat local request ID as proof of Yardi creation. |
| Outgoing messages and provider receipt | Notification service | Idempotency by business command and provider deduplication key where supported. |

Suggested maintenance lifecycle:

```text
INTAKE_PENDING_IDENTITY -> IDENTITY_VERIFIED -> TRIAGE_PENDING
-> AWAITING_TENANT_DETAILS | AWAITING_MANAGER_APPROVAL | READY_TO_SYNC
-> PMS_SYNC_PENDING -> PMS_SYNCED -> DISPATCHED -> COMPLETED
                         \-> PMS_SYNC_REVIEW (ambiguous result)
```

Failures are explicit states (`IDENTITY_VERIFICATION_FAILED`, `TRIAGE_REVIEW`, `PMS_SYNC_RETRY`, `PMS_SYNC_REVIEW`); they are not converted to success-shaped responses.

## 6. Security, identity, and UAE data localization

### Residency and legal boundary

- Target tenant data, backups, logs containing tenant identifiers, queues, object storage, and encryption keys in AWS UAE `me-central-1`; document any approved cross-border flows and obtain customer approval.
- AWS lists `me-central-1` as Middle East (UAE), but services/features differ by region. Check the live regional service list and the exact data-plane/control-plane behavior before selecting a managed service.
- UAE hosting is a residency control, not proof of compliance. Determine applicability of Federal Decree-Law No. 45 of 2021 on Personal Data Protection, its implementing decisions/exemptions, DIFC/ADGM regimes where relevant, Dubai government/customer rules, telecom/platform terms, and contractual transfer rules with UAE counsel. The government overview linked below references multiple separate regimes; scope depends on the parties and processing.
- WhatsApp Cloud API necessarily processes the conversation through Meta before the webhook reaches the UAE cell; AWS UAE storage does not make that upstream processing UAE-local. UAE PASS, PMS, support tooling, observability, and any AI inference vendor are also independent processors/subprocessors. Confirm endpoints, support access, retention, transfer mechanisms, and incident notification obligations contractually; obtain required notices/consents and customer approval for each flow.
- Data minimization: store message content only as long as operationally necessary, redact telemetry, keep authentication tokens out of logs, and define deletion/subject-request processes across inbox, search, backups, and broker retention.

### Encryption and access controls

- TLS 1.2 minimum (TLS 1.3 preferred) externally and service-to-service; mTLS for private gRPC where feasible. Validate certificates and rotate keys/certs automatically.
- At rest: AES-256 via AWS KMS-backed encryption for RDS/Aurora, EBS, S3, logs, and managed queues where supported. Use separate per-cell KMS keys and least-privilege key policies. Consider application-level envelope encryption for especially sensitive fields; rotate data keys without making records unrecoverable.
- Store WhatsApp app secrets, UAE PASS client credentials, and Yardi credentials in Secrets Manager; retrieve through task roles, rotate, and never bake into images/env files committed to source.
- Meta webhook: constant-time verification of `X-Hub-Signature-256` over raw bytes; bounded payload size; timestamp/replay/deduplication controls; validate event shape; acknowledge only after durable acceptance.
- UAE PASS: use the UAE PASS service-provider onboarding environment and published protocol. Validate OIDC issuer, audience/client, signature/JWKS, nonce/state, authorization code, redirect URI, and time claims; bind subject to the tenant's pre-established tenant/contact record. Step-up assurance level and name attributes must be agreed with the provider/customer; do not infer Emirates ID proof from WhatsApp phone possession.
- Human/admin access: workforce SSO + MFA, short-lived role sessions, just-in-time production access, tenant-scoped authorization, audited break-glass. Service identity via IAM/workload identity, not shared human credentials.
- Store minimal identity claims. Never put UAE PASS bearer/refresh tokens, Emirates ID, raw access credentials, or message text in application logs, traces, metrics labels, or DLQ dashboards.

### UAE PASS gate

Identity must complete before the core commits a maintenance request. A UAE PASS outage leaves intake in `INTAKE_PENDING_IDENTITY`; retry/callback continuation is offered without fabricating verification. The Maintenance Core verifies the signed/validated identity result, tenant binding, WhatsApp/contact binding and validity window itself. Approval policy and dispatch authorization remain separate from identity proof.

## 7. Fault tolerance, retries, and reconciliation

### Durable event publication

Use a transactional outbox in the same PostgreSQL transaction as each state change:

1. Insert/update authoritative business state.
2. Insert an outbox record with unique `eventId`, tenant, schema version, and payload.
3. Commit once.
4. Relay claims batches using `FOR UPDATE SKIP LOCKED`, publishes persistent messages with publisher confirms, and only then marks rows delivered.
5. Consumers insert the event ID into an inbox/deduplication table and apply their local state change in one DB transaction before acking.

Outbox delivery is at least once. Every side effect must be idempotent; exactly-once delivery is not assumed.

### Yardi/PMS outage topology

- Per-tenant adapter has connect/read timeouts, bounded concurrency, rate limits, exponential backoff with jitter, and a circuit breaker (`closed → open → half-open`). Configure threshold/window from observed provider behavior.
- When Yardi is unavailable, preserve the maintenance request and mark sync `PMS_SYNC_RETRY`; do not block inbound message acceptance or discard the event. Queue retries with `next_attempt_at`; alert on oldest pending age and retry budget.
- A timeout after sending a create call is ambiguous: query/search the PMS by stable idempotency/reference key before retrying. If the API cannot provide idempotent create or lookup, route to `PMS_SYNC_REVIEW` to prevent duplicate work orders.
- After a consumer/provider retry budget is exhausted, move to a DLQ/review queue with tenant, correlation ID, sanitized failure class, and replay procedure. The starter relay separately marks broker-publish failures as dead-lettered in the outbox ledger after its bounded retry budget; alert and require operator review/replay after restoring broker health. Operators replay from the ledger after correcting credentials/mapping/provider health; do not manually delete queue messages as a recovery mechanism.
- Periodically reconcile local pending/synced work with Yardi by external IDs and changed-since cursors. Reconciliation detects both missed callbacks and uncertain create outcomes.
- Only send "dispatched" notification after confirmed external work-order ID or a separately approved manager dispatch transition. Surface delayed sync truthfully to tenants/managers.

### Other partial failures

| Failure | Required behavior |
|---|---|
| Meta webhook duplicate | Unique provider message ID; acknowledge duplicate after confirming original durable record. |
| PostgreSQL unavailable | Return non-2xx to webhook so provider can retry; readiness fails; page on DB connectivity. |
| RabbitMQ unavailable | Continue committing business state + outbox; relay backs off for publish errors and exits non-zero on connection loss so its supervisor can restart it. Claimed rows become eligible after their lock lease expires. Alert on outbox age/volume. |
| UAE PASS unavailable/invalid callback | Keep intake pending; fail closed; allow safe retry; no request creation. |
| AI timeout/low confidence | Keep triage pending or route to human review; do not create/dispatch from an unsupported guess. |
| Notification provider failure | Retry from notification ledger independently; do not roll back a committed request. |
| Cell deployment/migration failure | Stop rollout for that cell, preserve old task set, use expand/migrate/contract DB changes, and verify backups/restore path. |

### Targets and operations

Set explicit per-tier SLOs before launch. Initial design objectives: durable webhook response within a few seconds under normal load; no accepted-message loss after DB commit; alert on oldest outbox/PMS retry age; restore tests at least quarterly. Define customer-specific RPO/RTO, retention, and recovery-region policy before enabling disaster recovery, especially where cross-border replication is restricted.

## 8. Observability and operations

- OpenTelemetry traces across `correlationId` and `causationId`; metrics by service/cell and outcome, never high-cardinality tenant message/identity fields.
- Structured JSON logs with PII redaction at source; audit events are access-controlled and tamper-evident.
- Key dashboards: webhook verification failures/latency, DB connection/lock health, outbox backlog and oldest age, queue depth/DLQ, UAE PASS completion/errors, AI review rate, PMS breaker state and sync lag, per-cell cost/CPU, tenant-isolation denials.
- Alarms route to on-call with runbooks for provider outages, replay, credential rotation, cell isolation, and data-deletion requests.
- Use per-cell canaries, staged migrations, image signing/scanning, SBOM, dependency alerts, secret scanning, and least-privilege deploy roles.

## 9. Initial implementation scope

The starter in this repository is intentionally a vertical-slice foundation, not the complete production platform. It establishes a TypeScript/Fastify API, PostgreSQL schema and RabbitMQ outbox boundary, with a hardened container image and Kubernetes base manifests. Treat one deployment of the Kubernetes base as one manager cell; a namespace alone is not a strong isolation boundary from cluster administrators, shared nodes, or cluster-level add-ons. Real UAE PASS OIDC verification, tenant onboarding/UI, AI provider, Yardi adapter, notification sending, cloud cell provisioning and production service-to-service identity are follow-on integration work. Until those are implemented and tested against provider sandboxes, do not expose this starter to real tenant data or claim automated dispatch.

## 10. Architecture decisions and open validation

| Decision | Rationale / validation |
|---|---|
| Dedicated runtime and DB per manager | Matches chosen isolation requirement; automate cell provisioning, patching, backup, observability, and cost allocation. Validate minimum viable customer economics. |
| TypeScript + Node.js + Fastify | Shared language across webhook/API/workers; small, explicit HTTP boundary. Adopt NestJS only if team needs its DI/module conventions. |
| PostgreSQL + outbox/inbox | Strong transactional state and durable event publication; use schema migrations and tenant-cell isolation. |
| RabbitMQ initially | Fits task routing and work queues. Confirm service availability/operations for AWS UAE; if Amazon MQ is unavailable or unsuitable in the selected region, operate a supported broker in the cell or use region-available SQS/EventBridge with equivalent idempotency semantics. |
| AI advisory, not authority | Prevents model output from authenticating tenants, approving work, or claiming dispatch. |
| UAE PASS for every maintenance request | Product requirement; validate service-provider eligibility, login/assurance level, consent wording, linking process, and callback behavior with UAE PASS and customers. |

### Primary references

- [AWS Regions and Availability Zones](https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html) — region geography/opt-in; `me-central-1` is UAE.
- [AWS regional service list](https://aws.amazon.com/about-aws/global-infrastructure/regional-product-services/) — service-by-region validation; catalog availability is time-sensitive.
- [Amazon RDS Multi-AZ deployments](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZSingleStandby.html) — HA behavior and limitations.
- [UAE PASS overview](https://docs.uaepass.ae/overview.md) — service-provider authentication uses OAuth 2.0; account assurance levels differ.
- [UAE PASS authorization-code endpoint guide](https://docs.uaepass.ae/web-registration/endpoints/1.-authorization-code.md) — use the current provider endpoint/profile and onboarding environment.
- [Meta WhatsApp webhooks overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview) — inbound messages and delivery/status notifications arrive as webhooks.
- [UAE Government: data protection laws](https://u.ae/en/about-the-uae/digital-uae/data/data-protection-laws) — overview of multiple relevant laws; not a substitute for legal applicability analysis.
- [UAE Federal Decree-Law No. 45 of 2021 (Personal Data Protection)](https://uaelegislation.gov.ae/en/legislations/1972) — official legislation portal (verify current amendments, implementing rules and applicability).
