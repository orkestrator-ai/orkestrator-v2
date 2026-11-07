import {
  incompatibility,
  type IncompatibilityDetails,
} from "@orkestrator/protocol/contract/errors";

/** The code form the gateway answers (`gateway-handlers.ts`). */
const ERROR_CODE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * A gateway response that failed, carrying the HTTP status as a property.
 *
 * The status has to survive as structured data, not just as text inside the
 * message: `classifyNewEnvironmentConnectionStartupError` retries 425/429/502/
 * 503/504 by reading `error.status`, and the gateway is the transport where
 * those statuses actually occur (a tunnel or reverse proxy in front of the
 * backend). Interpolating the code into the message alone left that entire
 * branch unreachable, because the backend's own errors arrive as plain
 * `Error`s with no status at all.
 *
 * The JSON body's `code` (when it has the gateway's code form) and, for a
 * typed incompatibility, its bounded `details` (`{ domain?, range?, field?,
 * command? }`, plan item 1005) are kept too, so `incompatibility(error)`
 * reads the code rather than the message text.
 */
export class GatewayHttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: IncompatibilityDetails;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "GatewayHttpError";
    this.status = status;
    const code =
      typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
    if (typeof code !== "string" || !ERROR_CODE.test(code)) return;
    this.code = code;
    const found = incompatibility(body);
    if (!found) return;
    const { code: _code, ...details } = found;
    if (Object.keys(details).length > 0) this.details = details;
  }
}
