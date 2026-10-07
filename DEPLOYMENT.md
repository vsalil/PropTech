# Kubernetes Deployment Runbook

This runbook deploys the current PropTech API and outbox relay to an existing Kubernetes cluster. It is written for PowerShell and uses the manifests in [`k8s/base`](./k8s/base).

> **Scope and safety:** This deploys the current starter only. UAE PASS OIDC validation, AI triage, WhatsApp outbound messaging, and Yardi/PMS dispatch are not implemented. Do not use it for real tenant dispatches. Treat one deployment/namespace as one manager cell, but a namespace is not an isolation boundary from cluster administrators, shared nodes, or cluster add-ons.

## Deployment flow

1. Prepare cluster, DNS, ingress, database, broker, and registry.
2. Build and push the immutable application image.
3. Configure Kustomize image and webhook hostname.
4. Provision the runtime Secret and TLS certificate.
5. Render and inspect the manifests.
6. Apply resources and wait for the migration Job.
7. Verify API, worker, ingress, and webhook configuration.
8. Record rollback and follow-up operational checks.

## 1. Prerequisites

Run commands from the repository root (`C:\Docs\DEV\PropTech`).

Required:

- Kubernetes 1.25+ and a working `kubectl` context with permission to create resources in the target cluster.
- Docker CLI/daemon or an approved image build system, plus push access to a container registry reachable by cluster nodes.
- Kustomize support in `kubectl` (`kubectl apply -k` and `kubectl kustomize`).
- A working Ingress controller. The base manifest assumes NGINX Ingress and `ingressClassName: nginx`.
- A DNS hostname for the WhatsApp webhook, pointing to the Ingress controller's public endpoint.
- PostgreSQL 16-compatible database, with the `proptech` database created, network access from the cluster, and TLS enabled.
- RabbitMQ 4-compatible broker, with the target vhost and application user configured, network access from the cluster, and TLS enabled.
- A TLS certificate and private key valid for the webhook hostname.
- A secure secret-delivery process. For example, provision from AWS Secrets Manager through an already-installed External Secrets Operator or Secrets Store CSI Driver. The application manifests do not install these operators or provision the database/broker.

Check cluster and tool context:

```powershell
kubectl config current-context
kubectl version
kubectl get nodes -o wide
kubectl get ingressclass
docker version
```

Confirm that the current Kubernetes context points to the intended environment before running any apply/delete/rollout command. In a production cluster, use the approved change-management window and verify that the cluster and backing services are in the intended UAE region.

## 2. Create the application image

Choose an immutable version tag for this deployment. Do not use `latest`.

```powershell
$Version = "0.1.0"
$RegistryImage = "registry.example.com/team/proptech-platform:$Version"
docker build --pull -t $RegistryImage .
docker push $RegistryImage
```

Replace `registry.example.com/team` with your actual registry host/namespace before running the commands.

The Docker build runs the unit tests and TypeScript compilation in its build stage. If the registry is private, make sure the Kubernetes nodes can pull the image using the organization's approved `imagePullSecret` or workload identity. Add `imagePullSecrets` to the API, outbox, and migration pod specs in the base manifests if the cluster requires it.

## 3. Configure the image and webhook hostname

Edit [`k8s/base/kustomization.yaml`](./k8s/base/kustomization.yaml). Set `newName` to the same registry image name without the version tag, and set `newTag` to the selected immutable version:

```yaml
images:
  - name: proptech-platform
    newName: registry.example.com/team/proptech-platform
    newTag: "0.1.0"
```

Edit [`k8s/base/ingress.yaml`](./k8s/base/ingress.yaml):

- Change `spec.ingressClassName` if your cluster uses a different IngressClass.
- Replace both occurrences of `webhook.example.com` with the real webhook hostname. Use the same value in `$WebhookHost` below.
- Replace `proptech-webhook-tls` if using a differently named TLS Secret.
- Retain the exact `/webhooks/whatsapp` path. The base intentionally does not route internal service endpoints through public ingress.

## 4. Provision credentials and TLS

### Application runtime Secret

Create a Kubernetes Secret named `proptech-runtime` in namespace `proptech` through the approved secret integration. It must provide these keys:

| Key | Required value |
|---|---|
| `DATABASE_URL` | PostgreSQL URL for the tenant cell, with TLS required, e.g. provider-supported `sslmode=require`. |
| `RABBITMQ_URL` | RabbitMQ TLS URL (`amqps://`) for the tenant cell/vhost. |
| `WHATSAPP_APP_SECRET` | Meta app secret used to verify webhook signatures. |
| `WHATSAPP_VERIFY_TOKEN` | High-entropy webhook subscription verification token. |
| `INTERNAL_SERVICE_TOKEN` | At least 32 characters of high-entropy secret material. Keep internal endpoints private; this shared bearer token is a starter-only mechanism, not a production service identity design. |

Do not commit the secret or put credentials into ConfigMaps, image build arguments, source files, or shell command literals. Do not use the local values from `.env.example`. Apply your external-secret resource only after confirming the target namespace exists, or use the secrets platform's documented namespace bootstrapping workflow.

After provisioning, check that the Secret and required key names exist without printing values:

```powershell
$secret = kubectl -n proptech get secret proptech-runtime -o json | ConvertFrom-Json
$secret.data.PSObject.Properties.Name
```

The expected keys are listed in the table above. If this JSONPath output is inconvenient for your PowerShell version, inspect only the Secret's key names through your approved secret operator tooling; never output `.data` values.

### Webhook TLS Secret

Create the TLS Secret using the certificate chain and private key supplied by your certificate team/issuer:

```powershell
kubectl create namespace proptech --dry-run=client -o yaml | kubectl apply -f -
kubectl -n proptech create secret tls proptech-webhook-tls `
  --cert="C:\secure\certs\webhook-fullchain.pem" `
  --key="C:\secure\certs\webhook-key.pem"
```

The private-key file must be protected and must not be added to this repository. Alternatively, provision the Secret using cert-manager or an approved external certificate controller.

## 5. Render and inspect manifests

Render the exact resources Kustomize will submit:

```powershell
kubectl kustomize k8s/base
```

Review the output for the correct namespace, registry image and tag, Ingress hostname/class, TLS Secret name, Secret references, and resource count. The output should not contain credential values; the runtime Secret is referenced by name only.

Optional server-side dry run (requires the namespace and referenced CRDs/resources to be present as appropriate):

```powershell
kubectl apply --dry-run=server -k k8s/base
```

Do not continue if the rendered image still points at the example/local image, or if the hostname/TLS/secret references do not match the prepared environment.

## 6. Apply the initial deployment

Apply the base. It creates the namespace and resources, starts the migration Job, creates the API/outbox workloads, and configures ingress:

```powershell
kubectl apply -k k8s/base
```

Wait for the versioned schema migration to finish:

```powershell
kubectl -n proptech wait --for=condition=complete job/proptech-migrate-v001 --timeout=10m
kubectl -n proptech logs job/proptech-migrate-v001
```

If the Job fails, stop here and inspect its logs/events. Do not repeatedly delete/recreate it without understanding the database error.

Wait for the API and outbox workloads:

```powershell
kubectl -n proptech rollout status deployment/proptech-api --timeout=5m
kubectl -n proptech rollout status deployment/proptech-outbox --timeout=5m
```

The API readiness probe requires PostgreSQL connectivity and the `001_initial` schema migration marker. A pod should not become Ready while the database is unavailable or the migration has not completed.

## 7. Verify the deployment

Inspect resources and recent events:

```powershell
kubectl -n proptech get deployments,pods,services,pdb,ingress,jobs
kubectl -n proptech get events --sort-by=.metadata.creationTimestamp
```

Check pod health and application logs:

```powershell
kubectl -n proptech describe deployment proptech-api
kubectl -n proptech describe deployment proptech-outbox
kubectl -n proptech logs deployment/proptech-api --all-containers=true --tail=100
kubectl -n proptech logs deployment/proptech-outbox --all-containers=true --tail=100
```

Test API liveness and readiness from inside the cluster using a temporary approved diagnostic pod, or port-forward the ClusterIP service:

```powershell
kubectl -n proptech port-forward service/proptech-api 3000:80
```

In another PowerShell window:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health/live
Invoke-RestMethod http://127.0.0.1:3000/health/ready
```

Both should return `status: ok` or `status: ready`, respectively. Stop port-forwarding with `Ctrl+C`.

Confirm the public webhook DNS and TLS before configuring Meta:

```powershell
$WebhookHost = "webhook.yourdomain.ae"
Resolve-DnsName $WebhookHost
try {
  $response = Invoke-WebRequest "https://$WebhookHost/webhooks/whatsapp" -Method Get -UseBasicParsing -ErrorAction Stop
  Write-Output "Unexpected HTTP status: $([int]$response.StatusCode)"
} catch {
  if ($_.Exception.Response) {
    Write-Output "HTTP status: $([int]$_.Exception.Response.StatusCode) (403 is expected without Meta verification query parameters)"
  } else {
    Write-Output "Connection failed: $($_.Exception.Message)"
  }
}
```

The unauthenticated GET probe is expected to return HTTP 403 because it lacks Meta's verification query parameters. A TLS/certificate error, DNS failure, 404, or 502 indicates ingress/DNS/TLS/routing needs correction. Then configure Meta's webhook URL as `https://$WebhookHost/webhooks/whatsapp`, set the same `WHATSAPP_VERIFY_TOKEN`, and subscribe to the WhatsApp message field. Confirm that `whatsapp_channels` has been provisioned in PostgreSQL for the Meta `phone_number_id` before accepting real traffic.

## 8. Upgrade procedure

For every release:

1. Build, test, and push a new immutable image tag.
2. Review and apply database migrations as a backwards-compatible expand step. **The current migration runner applies only `001_initial.sql`; it is not yet a general versioned migration framework.** A future schema change requires adding a new migration and extending/replacing the runner before following this procedure.
3. In [`k8s/base/kustomization.yaml`](./k8s/base/kustomization.yaml), update `newTag` to the new image.
4. For a new schema migration, update [`k8s/base/migration-job.yaml`](./k8s/base/migration-job.yaml) metadata name to a new unique version (for example, `proptech-migrate-v002`) and ensure the image contains the migration code.
5. Render and inspect `kubectl kustomize k8s/base`.
6. Apply and wait for the new migration Job to complete.
7. Apply again if your release procedure separates migration and workload rollout; otherwise apply the full base once and wait for both migration and rollout. Verify readiness and logs after each stage.
8. Keep migrations compatible with the previous application version until rollback is no longer needed; use a later contract migration to remove old schema.

Kubernetes Jobs are immutable. Do not change the image or command under an already-created Job name. The current `001_initial.sql` is idempotent for initial bootstrap, but future migrations should be new versioned scripts and tracked in `schema_migrations`; do not edit an already-applied migration to change production schema.

## 9. Rollback and recovery

### Application rollback

If a new application rollout fails:

```powershell
kubectl -n proptech rollout history deployment/proptech-api
kubectl -n proptech rollout undo deployment/proptech-api
kubectl -n proptech rollout undo deployment/proptech-outbox
kubectl -n proptech rollout status deployment/proptech-api --timeout=5m
kubectl -n proptech rollout status deployment/proptech-outbox --timeout=5m
```

Use the cluster's release history to restore the previous immutable image and manifest configuration. Do not roll back database schema changes unless a reviewed database recovery plan explicitly supports it. A failed migration requires database-owner review and a tested forward-fix or restore decision.

### Troubleshooting commands

```powershell
$PodName = "replace-with-pod-name"
kubectl -n proptech describe pod $PodName
kubectl -n proptech logs $PodName --previous
kubectl -n proptech describe job proptech-migrate-v001
kubectl -n proptech logs job/proptech-migrate-v001
kubectl -n proptech get endpoints proptech-api
kubectl -n proptech get ingress proptech-whatsapp-webhook -o yaml
```

Common causes:

- `ImagePullBackOff`: registry name/tag, pull credentials, or node-to-registry connectivity.
- `CreateContainerConfigError`: missing `proptech-runtime` Secret key or wrong Secret namespace.
- API pods remain unready: check migration completion, PostgreSQL TLS/network/permissions, and schema marker.
- Outbox pods restart: check RabbitMQ TLS/vhost/network/credentials and worker logs; connection loss exits for Kubernetes restart.
- Ingress returns 404/502: check IngressClass/controller, exact hostname/path, API readiness/endpoints, DNS, and TLS Secret.
- Webhook returns 403 to Meta verification: token mismatch, missing subscription parameters, or wrong configured callback path.
- Signed webhook returns `tenant_channel_not_configured`: provision the Meta phone-number ID to tenant routing row before sending traffic.

## 10. Operational requirements before production

- Provision a dedicated property-manager cell with separate namespace, database, broker resources, credentials, keys, and deployment pipeline. For stronger isolation, use a dedicated cluster/account and nodes as required by the threat model.
- Replace the starter shared internal bearer token with managed workload identity/mTLS and network policies. Keep internal endpoints off public ingress.
- Enable Kubernetes audit logging, secret encryption at rest, admission policy, image scanning/signing, resource quotas, NetworkPolicies, and tested backup/restore procedures.
- Define HPA/replica strategy, disruption/maintenance windows, alert thresholds, RPO/RTO, event replay, and on-call ownership.
- Validate AWS UAE region service support and data-transfer implications for the cluster, database, broker, registry, telemetry, Meta, UAE PASS, and any AI provider.
- Complete UAE PASS OIDC callback validation and security review before treating identity verification as production-grade.
