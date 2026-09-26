import { PUBLIC_API_LIMITS } from "@orkestrator/protocol/public-api";
import { CliError } from "./errors.js";
import { readStreamBounded } from "./io.js";
import type { ResolvedTarget } from "./targets.js";

export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const INVOKE_PATH = "/__orkestrator/invoke";

export interface InvokeOptions {
  /**
   * Whether the request may have side effects. A mutation whose bytes may have
   * reached the server is never reported as "not sent": a lost response is
   * `transport-uncertain` and the caller must reconcile by request key.
   */
  mutation: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

function connectionRefused(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  const values = [code, cause].filter((value): value is string => typeof value === "string");
  return values.some((value) =>
    ["ECONNREFUSED", "ConnectionRefused", "ENOTFOUND", "EAI_AGAIN", "FailedToOpenSocket"].includes(
      value,
    ),
  );
}

/**
 * Authenticated gateway transport. It sends the bearer token only to the
 * selected origin, never follows redirects, bounds the decoded response, and
 * maps transport failures without inspecting server error prose (except for
 * the one legacy signal that a backend predates `public_action`).
 */
export class GatewayTransport {
  constructor(
    private readonly target: ResolvedTarget,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly defaultTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {}

  async invoke(
    command: string,
    args: Record<string, unknown>,
    options: InvokeOptions,
  ): Promise<unknown> {
    const body = JSON.stringify({ command, args });
    if (Buffer.byteLength(body) > PUBLIC_API_LIMITS.requestMaxBytes) {
      throw new CliError(
        "input-too-large",
        "The request is larger than the client's request limit",
      );
    }
    let token = await this.target.readToken();
    let response = await this.send(body, token, options);
    if (response.status === 401 && !options.mutation) {
      // The token may have been rotated; a safe read gets one fresh attempt.
      await response.body?.cancel().catch(() => undefined);
      token = await this.target.readToken();
      response = await this.send(body, token, options);
    }
    return this.decode(response, options);
  }

  private async send(body: string, token: string, options: InvokeOptions): Promise<Response> {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    const onAbort = () => controller.abort(new Error("interrupted"));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await this.fetchImpl(`${this.target.baseUrl}${INVOKE_PATH}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      if (!options.mutation || connectionRefused(error)) {
        throw new CliError(
          "connection-failed",
          controller.signal.aborted
            ? `The backend did not respond within ${Math.round(timeoutMs / 1000)}s`
            : `Could not reach the backend at ${this.target.identity.endpoint}`,
          { retryable: true },
        );
      }
      throw new CliError(
        "transport-uncertain",
        "The connection failed after the request may have reached the backend; query the operation by its request key instead of resubmitting",
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  private async decode(response: Response, options: InvokeOptions): Promise<unknown> {
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new CliError(
        "connection-failed",
        "The backend answered with a redirect; redirects are never followed with credentials",
      );
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new CliError(
        "auth-failed",
        response.status === 401
          ? "The backend rejected the credential"
          : "The backend refused this client (origin or permission)",
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = response.body
        ? await readStreamBounded(
            response.body,
            PUBLIC_API_LIMITS.responseMaxBytes,
            () =>
              new CliError("response-invalid", "The backend response exceeded the client limit"),
          )
        : new Uint8Array();
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(
        options.mutation ? "transport-uncertain" : "connection-failed",
        "The backend response was interrupted",
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new CliError(
        options.mutation ? "transport-uncertain" : "response-invalid",
        `The backend returned a non-JSON response (HTTP ${response.status})`,
      );
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new CliError("response-invalid", "The backend response is not a JSON object");
    }
    const record = payload as { result?: unknown; error?: unknown };
    if (response.ok) return record.result;
    const message = typeof record.error === "string" ? record.error : "";
    // The one message the gateway itself defines for a missing command: an
    // older backend without the public contract. Nothing ran.
    if (message.startsWith("Unknown backend command: ")) {
      throw new CliError(
        "backend-incompatible",
        "The selected backend does not support the public command contract; upgrade it",
      );
    }
    if (response.status === 413) {
      throw new CliError("input-too-large", "The backend rejected the request as too large");
    }
    if (response.status === 400) {
      throw new CliError("invalid-input", "The backend rejected the request as malformed");
    }
    throw new CliError(
      options.mutation ? "transport-uncertain" : "connection-failed",
      `The backend failed the request (HTTP ${response.status})`,
    );
  }
}
