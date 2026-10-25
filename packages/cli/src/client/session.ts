import { createHash, randomUUID } from "node:crypto";
import {
  canonicalJson,
  isPublicActionAvailable,
  isPublicActionResponse,
  isPublicCapabilities,
  isPublicRequestId,
  PUBLIC_ACTION_COMMAND,
  PUBLIC_ACTIONS,
  PUBLIC_ALL_NODES,
  PUBLIC_API_SCHEMA_VERSION,
  PUBLIC_LOCAL_ONLY_ACTIONS,
  type PublicActionName,
  type PublicActionRequest,
  type PublicActionResponse,
  type PublicCapabilities,
  type PublicConnectionIdentity,
  type PublicReceipt,
  type PublicNodeTag,
} from "@orkestrator/protocol/public-api";
import { CliError } from "./errors.js";
import { LocalReceiptStore, type LocalReceipt } from "./receipts.js";
import type { ResolvedTarget } from "./targets.js";
import { GatewayTransport, type FetchLike } from "./transport.js";

export interface MutationResult<T = unknown> {
  result: T;
  receipt?: PublicReceipt;
  warnings?: string[];
  node?: PublicNodeTag;
}

/**
 * One connected backend for the duration of a command. It checks the
 * backend's identity on every response, negotiates capabilities before any
 * mutation, and owns the request-key lifecycle: a local receipt is saved
 * before the mutation leaves the process and updated with what came back.
 */
export class ClientSession {
  private capabilitiesPromise: Promise<PublicCapabilities> | null = null;
  private transport: GatewayTransport;
  private readonly readWarnings = new Set<string>();
  private responseNode?: PublicNodeTag;

  get warnings(): string[] {
    return [...this.readWarnings];
  }
  get nodeTag(): PublicNodeTag | undefined {
    return (
      this.responseNode ??
      (this.options.node && this.options.node !== PUBLIC_ALL_NODES
        ? { nodeId: this.options.node, name: this.options.node }
        : undefined)
    );
  }

  constructor(
    private target: ResolvedTarget,
    private readonly receipts: LocalReceiptStore,
    private readonly options: {
      fetchImpl?: FetchLike;
      requestTimeoutMs?: number;
      signal?: AbortSignal;
      /** `--node`: every action of this command runs there (`request.node`). */
      node?: string;
    } = {},
  ) {
    this.transport = new GatewayTransport(target, options.fetchImpl, options.requestTimeoutMs);
  }

  get identity(): PublicConnectionIdentity {
    return this.target.identity;
  }

  /** The node `--node` named, if any. */
  get node(): string | undefined {
    return this.options.node;
  }

  private routingChecked: Promise<void> | null = null;

  /**
   * A backend that predates node routing ignores `request.node` and would
   * run the action on itself, so the connected node must advertise it
   * before anything is sent with a node.
   */
  private ensureNodeRouting(): Promise<void> {
    this.routingChecked ??= (async () => {
      const response = await this.call("capabilities", {}, undefined, false, undefined, false);
      if (!response.ok) throw envelopeError(response);
      if (!isPublicCapabilities(response.result)) {
        throw new CliError("response-invalid", "The backend returned invalid capabilities");
      }
      if (response.result.features.nodeRouting !== true) {
        throw new CliError(
          "backend-incompatible",
          "The connected backend cannot run actions on other nodes; upgrade it to use --node",
        );
      }
    })().catch((error: unknown) => {
      this.routingChecked = null;
      throw error;
    });
    return this.routingChecked;
  }

  capabilities(): Promise<PublicCapabilities> {
    this.capabilitiesPromise ??= this.loadCapabilities().catch((error: unknown) => {
      this.capabilitiesPromise = null;
      throw error;
    });
    return this.capabilitiesPromise;
  }

  private async loadCapabilities(): Promise<PublicCapabilities> {
    const response = await this.call("capabilities", {}, undefined, false);
    if (!response.ok) throw envelopeError(response);
    if (!isPublicCapabilities(response.result)) {
      throw new CliError("response-invalid", "The backend returned invalid capabilities");
    }
    return response.result;
  }

  /** Read-only public action; returns its result or throws its structured error. */
  async read<T = unknown>(action: PublicActionName, input: Record<string, unknown>): Promise<T> {
    if (PUBLIC_ACTIONS[action].mutation) throw new Error(`${action} is a mutation`);
    const response = await this.call(action, input, undefined, false);
    if (!response.ok) throw envelopeError(response);
    return response.result as T;
  }

  /** Read that also returns the receipt a response may carry (`run.get`). */
  async readWithReceipt<T = unknown>(
    action: PublicActionName,
    input: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{ result: T; receipt?: PublicReceipt }> {
    const response = await this.call(action, input, undefined, false, timeoutMs);
    if (!response.ok) throw envelopeError(response);
    return { result: response.result as T, receipt: response.receipt };
  }

  /**
   * Submit a mutation under a request key. The key is either the caller's
   * `--request-id` or a generated one; either way it is persisted locally
   * first. A transport failure after sending is `transport-uncertain` and is
   * never retried under a new key.
   */
  async mutate<T = unknown>(
    action: PublicActionName,
    input: Record<string, unknown>,
    requestId: string | undefined,
  ): Promise<MutationResult<T>> {
    if (!PUBLIC_ACTIONS[action].mutation) throw new Error(`${action} is not a mutation`);
    if (this.options.node === PUBLIC_ALL_NODES) {
      throw new CliError(
        "invalid-input",
        "--node all is only for project list, environment list and attention; name one node",
      );
    }
    if (requestId !== undefined && !isPublicRequestId(requestId)) {
      throw new CliError(
        "invalid-input",
        "--request-id must be 1–200 characters of letters, digits and . _ : @ / + = -, starting with a letter or digit",
      );
    }
    const capabilities = await this.capabilities();
    if (!isPublicActionAvailable(capabilities, action)) {
      const entry = capabilities.actions[action];
      throw new CliError(
        entry ? "capability-unavailable" : "backend-incompatible",
        entry
          ? `The backend does not offer ${action}${entry.reason ? `: ${entry.reason}` : ""}`
          : `The backend is too old for ${action}; upgrade it`,
        { action },
      );
    }
    const installationId = capabilities.backend.installationId;
    const key = requestId ?? `cli-${randomUUID()}`;
    const intentDigest = createHash("sha256")
      .update(canonicalJson({ action, input }))
      .digest("hex");
    const existing = await this.receipts.find(installationId, action, key, this.options.node);
    if (existing && existing.intentDigest !== intentDigest) {
      throw new CliError(
        "request-conflict",
        "This saved request ID was used for a different intent",
        {
          action,
          details: { requestId: key, namespace: existing.namespace },
        },
      );
    }
    const namespace = existing?.namespace ?? capabilities.requestKeys.currentNamespace;
    const now = new Date().toISOString();
    const local: LocalReceipt = {
      version: 1,
      installationId,
      connection: this.target.identity.name,
      ...(this.options.node ? { node: this.options.node } : {}),
      action,
      requestId: key,
      namespace,
      intentDigest,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(existing?.operationId ? { operationId: existing.operationId } : {}),
    };
    await this.receipts.save(local);

    let response: PublicActionResponse;
    try {
      response = await this.call(action, input, { requestId: key, namespace }, true);
    } catch (error) {
      if (error instanceof CliError && error.code === "transport-uncertain") {
        throw new CliError(error.code, error.message, {
          action,
          node: this.nodeTag,
          details: {
            requestId: key,
            namespace,
            ...(this.nodeTag ? { node: this.nodeTag } : {}),
            recovery: `orkestrator run get --request-id ${key} --action ${action}${this.options.node ? ` --node ${quoteArgument(this.options.node)}` : ""}`,
          },
        });
      }
      throw error;
    }
    if (response.receipt)
      await this.receipts.update(local, response.receipt).catch(() => undefined);
    if (!response.ok) {
      if (response.error.code === "node-outcome-unknown") {
        throw new CliError(response.error.code, response.error.message, {
          action,
          node: this.nodeTag,
          retryable: response.error.retryable,
          details: {
            ...response.error.details,
            requestId: key,
            namespace,
            recovery: `orkestrator run get --request-id ${key} --action ${action}${this.options.node ? ` --node ${quoteArgument(this.options.node)}` : ""}`,
          },
        });
      }
      throw envelopeError(response);
    }
    return {
      result: response.result as T,
      ...(this.nodeTag ? { node: this.nodeTag } : {}),
      ...(response.receipt ? { receipt: response.receipt } : {}),
      ...(response.warnings ? { warnings: response.warnings } : {}),
    };
  }

  private async call(
    action: PublicActionName,
    input: Record<string, unknown>,
    request: { requestId: string; namespace: string } | undefined,
    mutation: boolean,
    timeoutMs?: number,
    routed = true,
  ): Promise<PublicActionResponse> {
    const node =
      routed && this.options.node && !PUBLIC_LOCAL_ONLY_ACTIONS.includes(action)
        ? this.options.node
        : undefined;
    if (node) await this.ensureNodeRouting();
    const body: PublicActionRequest = {
      schemaVersion: PUBLIC_API_SCHEMA_VERSION,
      action,
      actionVersion: PUBLIC_ACTIONS[action].version,
      input,
      ...(request ? { request } : {}),
      // `capabilities` with --node all is this node's own.
      ...(node && !(node === PUBLIC_ALL_NODES && action === "capabilities") ? { node } : {}),
    };
    const raw = await this.transport.invoke(
      PUBLIC_ACTION_COMMAND,
      body as unknown as Record<string, unknown>,
      { mutation, signal: this.options.signal, timeoutMs },
    );
    if (!isPublicActionResponse(raw)) {
      throw new CliError(
        mutation ? "transport-uncertain" : "response-invalid",
        "The backend returned a response that does not match the public contract",
      );
    }
    await this.verifyIdentity(raw);
    if (raw.node) this.responseNode = raw.node;
    if (!mutation && raw.ok) {
      for (const warning of raw.warnings ?? []) this.readWarnings.add(warning);
      const nodes = (
        raw.result as {
          nodes?: Array<{ ok: boolean; name: string; nodeId: string; error?: { message: string } }>;
        } | null
      )?.nodes;
      for (const failed of nodes?.filter((entry) => !entry.ok) ?? []) {
        this.readWarnings.add(
          `${failed.name} (${failed.nodeId}): ${failed.error?.message ?? "not checked"}`,
        );
      }
    }
    return raw;
  }

  private async verifyIdentity(response: PublicActionResponse): Promise<void> {
    const backend = response.backend;
    if (!backend) {
      throw new CliError("response-invalid", "The backend response did not identify the backend");
    }
    const expected = this.target.expectedInstallationId;
    if (expected && backend.installationId !== expected) {
      throw new CliError(
        "identity-mismatch",
        `The endpoint answered as a different Orkestrator installation than '${this.target.identity.name}'`,
        { details: { expected, actual: backend.installationId } },
      );
    }
    this.target.identity.installationId ??= backend.installationId;
    this.target.identity.generation = backend.generation;
  }
}

function envelopeError(response: Extract<PublicActionResponse, { ok: false }>): CliError {
  return new CliError(response.error.code, response.error.message, {
    action: response.action,
    ...(response.node ? { node: response.node } : {}),
    ...(response.error.details ? { details: response.error.details } : {}),
    ...(response.receipt ? { receipt: response.receipt } : {}),
    ...(response.error.retryable !== undefined ? { retryable: response.error.retryable } : {}),
  });
}

function quoteArgument(value: string): string {
  return /^[A-Za-z0-9_.:@/+=-]+$/.test(value)
    ? value
    : "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
