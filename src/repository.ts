import type {
  CreatedMaintenanceRequest,
  IdentityVerificationInput,
  InboundMessage,
  MaintenanceRequestInput,
} from "./domain.js";

export interface WorkflowRepository {
  /** Checks that required storage dependencies are reachable and initialized. */
  checkHealth(): Promise<void>;
  /** Stores a tenant-mapped inbound message and returns null for a duplicate. */
  persistInboundMessage(message: InboundMessage): Promise<string | null>;
  /** Stores a UAE PASS verification bound to an existing tenant contact. */
  persistIdentityVerification(input: IdentityVerificationInput): Promise<string>;
  /** Creates an identity-authorized maintenance request idempotently. */
  createMaintenanceRequest(
    input: MaintenanceRequestInput,
  ): Promise<CreatedMaintenanceRequest>;
}
