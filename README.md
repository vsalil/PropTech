# Dubai PropTech Platform

Initial Node.js/TypeScript backend foundation for a Dubai-focused, whitelabel property maintenance platform. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the system blueprint, [PropTech-Architecture.drawio](./PropTech-Architecture.drawio) for the editable architecture diagram, and [DEPLOYMENT.md](./DEPLOYMENT.md) for the Kubernetes runbook.

## Local prerequisites

- Node.js 22+
- Docker Desktop with Docker Compose

## Start dependencies

```powershell
Copy-Item .env.example .env
docker compose up -d
npm install
npm run migrate
npm run dev
```

The API listens on `http://localhost:3000`. RabbitMQ management is at `http://localhost:15672` (`proptech` / `local-dev-only`). Run the relay in a second terminal:

```powershell
npm run worker:outbox
```

Run checks:

```powershell
npm test
npm run build
```

## Deploy to Kubernetes

See the step-by-step [Kubernetes Deployment Runbook](./DEPLOYMENT.md) for a complete first install, upgrade, verification, rollback, and troubleshooting process.

The manifests deploy the API and outbox relay as separate workloads from the same non-root, multi-stage image. PostgreSQL and RabbitMQ are external services: use managed/private endpoints in the target region and do not put their credentials in ConfigMaps or image layers.

Prerequisites:

- Kubernetes 1.25+ with Kustomize support (`kubectl apply -k`).
- An NGINX Ingress Controller, a DNS name for the webhook, and a TLS secret/certificate in the `proptech` namespace.
- PostgreSQL with TLS enabled and database `proptech` created; RabbitMQ with the credentials/vhost configured for the cell.
- A secret-delivery mechanism (recommended: External Secrets Operator backed by AWS Secrets Manager/Secrets Store CSI). The workloads expect a Secret named `proptech-runtime` with keys `DATABASE_URL`, `RABBITMQ_URL`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, and `INTERNAL_SERVICE_TOKEN`. Supply values through your approved secret manager; do not commit a Secret manifest or use placeholder credentials.

Build and push the image from the repository root, then update `images.newName` and `images.newTag` in `k8s/base/kustomization.yaml` to the immutable registry image and tag:

```powershell
docker build -t <registry>/<namespace>/proptech-platform:0.1.0 .
docker push <registry>/<namespace>/proptech-platform:0.1.0
```

For a private registry, provision an `imagePullSecret` using your cluster's approved credential flow and add it to the pod specs. Before applying, edit `k8s/base/ingress.yaml` to use your IngressClass, public webhook DNS name, and TLS Secret name; create the referenced TLS Secret before exposing traffic. Ensure `DATABASE_URL` uses TLS (for example, the provider-supported `sslmode=require`) and `RABBITMQ_URL` uses TLS (`amqps://`) for production.

Apply the base and verify the migration before exposing the webhook:

```powershell
kubectl apply -k k8s/base
kubectl -n proptech wait --for=condition=complete job/proptech-migrate-v001 --timeout=10m
kubectl -n proptech rollout status deployment/proptech-api --timeout=5m
kubectl -n proptech rollout status deployment/proptech-outbox --timeout=5m
kubectl -n proptech get pods,svc,ingress
```

The migration job is deliberately versioned (`v001`). For each future migration revision, update the job name and image tag before applying; Kubernetes Jobs are immutable and must not be reused for a different migration image. The API readiness probe checks database connectivity and the `schema_migrations` marker, so it remains out of service until the schema is fully applied. The ingress exposes only the exact `/webhooks/whatsapp` route; internal routes remain ClusterIP-only and still require service authentication.

The manifests do not install an ingress controller, database, broker, external-secret operator, certificate issuer, or provider integrations. Keep each property manager in a separate namespace/cell with separate database, credentials, keys, and broker resources as required by the architecture blueprint. Do not use the local development credentials from `.env.example` in a cluster.

## First slice

- `GET /webhooks/whatsapp` implements the Meta webhook challenge.
- `POST /webhooks/whatsapp` verifies `X-Hub-Signature-256` against raw request bytes, validates inbound messages, and stores each message and `tenant.message.received.v1` event in one PostgreSQL transaction. Configure `whatsapp_channels` out of band to route a Meta phone-number ID to a tenant UUID.
- `POST /internal/identity-verifications` records a short-lived UAE PASS verification **only** when the supplied subject matches the pre-provisioned `tenant_contacts` binding. It is an internal boundary for a future UAE PASS OIDC validator, not an OIDC callback or proof validator. Never let an untrusted caller reach it.
- `POST /internal/maintenance-requests` requires an unexpired verification bound to the same tenant and WhatsApp contact as the original inbound message. It creates a request and outbox event transactionally; `202` means accepted for PMS synchronization, not dispatched.
- `npm run worker:outbox` publishes committed outbox events to the durable `proptech.events` RabbitMQ topic exchange using publisher confirms. A crash after publish and before marking the outbox row may produce a duplicate; consumers must deduplicate by `messageId`.
- The local relay binds a durable catch-all queue so confirmed events are retained before consumers exist. Publishing retries are bounded; exhausted events are marked for operator review in the outbox table and alerted through structured stderr logs.
- On broker connection loss, the relay exits non-zero for supervisor restart; any claimed outbox records are retried after the 60-second lease expires.
- `/health/live` and `/health/ready` provide liveness and PostgreSQL readiness checks.

The internal API uses a shared bearer secret only to make local integration possible. Before deployment, replace it with workload identity/mTLS or an equivalent managed service-auth mechanism; add user-facing OAuth/OIDC authorization and tenant-scoped authorization before exposing business APIs. No live UAE PASS, AI model, WhatsApp outbound, Yardi, or dispatch adapter is included yet. No endpoint in this starter claims successful identity verification unless an authorized verifier calls the internal boundary, and no code reports a request as dispatched.

## Local database seed for manual integration

After migrations, provision an isolated test tenant, WhatsApp channel and identity binding with a local-only SQL client. Do not use real tenant details or production credentials in development.

```sql
INSERT INTO whatsapp_channels (phone_number_id, tenant_id)
VALUES ('local-phone-number-id', '00000000-0000-4000-8000-000000000001');

INSERT INTO tenant_contacts (tenant_id, whatsapp_id, uaepass_subject)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  '971500000001',
  'local-uaepass-subject'
);
```

## Current implementation limits

This is an initial vertical slice, not production-ready SaaS. It has no cell provisioner, tenant UI, public user authentication, UAE PASS OAuth/OIDC callback validation, AI triage, approval workflow, Yardi client, notification sender, production infrastructure-as-code, production secrets, or compliance certification. Keep internal endpoints private and do not process real tenant messages until the provider and security integrations, privacy review, retention controls, and operational runbooks are complete.
