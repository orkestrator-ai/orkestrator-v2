import { createHash, randomUUID } from "node:crypto";
import {
  canonicalJson,
  isPublicActionAvailable,
  isPublicActionResponse,
  isPublicCapabilities,
  isPublicRequestId,
  PUBLIC_ACTION_COMMAND,
  PUBLIC_ACTIONS,
  PUBLIC_API_SCHEMA_VERSION,
  type PublicActionName,
  type PublicActionRequest,
  type PublicActionResponse,
  type PublicCapabilities,
  type PublicConnectionIdentity,
  type PublicReceipt,
} from "@orkestrator/protocol/public-api";
import { CliError } from "./errors.js";
import { LocalReceiptStore, type LocalReceipt } from "./receipts.js";
import type { ResolvedTarget } from "./targets.js";
import { GatewayTransport, type FetchLike } from "./transport.js";

export interface MutationResult<T = unknown> {
  result: T;
  receipt?: PublicReceipt;
  warnings?: string[];
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

  constructor(
    private target: ResolvedTarget,
    private readonly receipts: LocalReceiptStore,
    private readonly options: {
      fetchImpl?: FetchLike;
      requestTimeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ) {
    this.transport = new GatewayTransport(target, options.fetchImpl, options.requestTimeoutMs);
  }

  get identity(): PublicConnectionIdentity {
    return this.target.identity;
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
  ): Promise<{ result: T; receipt?: PublicReceipt }> {
    const response = await this.call(action, input, undefined, false);
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
    const existing = await this.receipts.find(installationId, action, key);
    const namespace = existing?.namespace ?? capabilities.requestKeys.currentNamespace;
    const now = new Date().toISOString();
    const local: LocalReceipt = {
      version: 1,
      installationId,
      connection: this.target.identity.name,
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
          details: {
            requestId: key,
            namespace,
            recovery: `orkestrator run get --request-id ${key} --action ${action}`,
          },
        });
      }
      throw error;
    }
    if (response.receipt)
      await this.receipts.update(local, response.receipt).catch(() => undefined);
    if (!response.ok) throw envelopeError(response);
    return {
      result: response.result as T,
      ...(response.receipt ? { receipt: response.receipt } : {}),
      ...(response.warnings ? { warnings: response.warnings } : {}),
    };
  }

  private async call(
    action: PublicActionName,
    input: Record<string, unknown>,
    request: { requestId: string; namespace: string } | undefined,
    mutation: boolean,
  ): Promise<PublicActionResponse> {
    const body: PublicActionRequest = {
      schemaVersion: PUBLIC_API_SCHEMA_VERSION,
      action,
      actionVersion: PUBLIC_ACTIONS[action].version,
      input,
      ...(request ? { request } : {}),
    };
    const raw = await this.transport.invoke(
      PUBLIC_ACTION_COMMAND,
      body as unknown as Record<string, unknown>,
      { mutation, signal: this.options.signal },
    );
    if (!isPublicActionResponse(raw)) {
      throw new CliError(
        mutation ? "transport-uncertain" : "response-invalid",
        "The backend returned a response that does not match the public contract",
      );
    }
    await this.verifyIdentity(raw);
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
    ...(response.error.details ? { details: response.error.details } : {}),
    ...(response.receipt ? { receipt: response.receipt } : {}),
    ...(response.error.retryable !== undefined ? { retryable: response.error.retryable } : {}),
  });
}
