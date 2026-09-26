import type {
  PublicActionName,
  PublicDispatchState,
  PublicErrorCode,
  PublicExecutionState,
  PublicOperationResources,
  PublicOperationState,
  PublicReceipt,
} from "@orkestrator/protocol/public-api";
import type { CommandContext } from "../commands-context.js";
import type { CommandInvoker } from "../control-shared-actions.js";
import type { RegistryDependencies } from "../commands-registry-types.js";
import type { PublicAuthority, PublicOperationRecord } from "./operation-ledger.js";

export interface PublicActionContext {
  command: CommandContext;
  dependencies: RegistryDependencies;
  /** Calls a registered backend command with this context. */
  invoke: CommandInvoker;
  authority: PublicAuthority;
  installationId: string;
  generation: string;
  now(): number;
}

export interface ReadResult {
  result: unknown;
  receipt?: PublicReceipt;
}

export interface ReadActionHandler<I = unknown> {
  kind: "read";
  action: PublicActionName;
  parse(input: Record<string, unknown>): I;
  run(input: I, context: PublicActionContext): Promise<ReadResult>;
}

export interface ParsedMutation<I> {
  value: I;
  /** Canonical target scope for the request key, derived from the input alone. */
  scope: string;
  /** Canonical intent for the fingerprint (validated, no defaults applied). */
  intent: unknown;
}

export type OperationPatch = Partial<
  Pick<
    PublicOperationRecord,
    | "state"
    | "stage"
    | "dispatch"
    | "execution"
    | "error"
    | "result"
    | "completedAt"
    | "stopRequestedAt"
  >
> & { resources?: PublicOperationResources };

export interface OperationHandle {
  readonly operationId: string;
  current(): PublicOperationRecord;
  /** Persist a patch; resources merge, everything else replaces. */
  update(patch: OperationPatch): Promise<PublicOperationRecord>;
}

export type ExecuteOutcome =
  | {
      state: "succeeded";
      result: Record<string, unknown>;
      stage?: string;
      resources?: PublicOperationResources;
      dispatch?: PublicDispatchState;
      execution?: PublicExecutionState;
      warnings?: string[];
    }
  | {
      /** Accepted; a backend-owned continuation finishes the operation. */
      state: "running";
      result: Record<string, unknown>;
      stage: string;
      resources?: PublicOperationResources;
      dispatch?: PublicDispatchState;
      execution?: PublicExecutionState;
      warnings?: string[];
    }
  | {
      state: Extract<PublicOperationState, "failed" | "partial" | "unknown" | "cancelled">;
      error: { code: PublicErrorCode; message: string };
      result?: Record<string, unknown>;
      stage?: string;
      resources?: PublicOperationResources;
      dispatch?: PublicDispatchState;
      execution?: PublicExecutionState;
      retryable?: boolean;
    };

export interface PreparedMutation {
  /** Content-free defaults resolved now and kept for replay. */
  resolved?: PublicOperationRecord["resolved"];
  resources?: PublicOperationResources;
  execute(operation: OperationHandle): Promise<ExecuteOutcome>;
}

export interface MutationActionHandler<I = unknown> {
  kind: "mutation";
  action: PublicActionName;
  parse(input: Record<string, unknown>): ParsedMutation<I>;
  /** Existence, readiness and default resolution. Throws before admission. */
  prepare(input: I, context: PublicActionContext): Promise<PreparedMutation>;
}

export type PublicActionHandler = ReadActionHandler<any> | MutationActionHandler<any>;
