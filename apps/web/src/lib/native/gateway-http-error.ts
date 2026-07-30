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
 */
export class GatewayHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GatewayHttpError";
    this.status = status;
  }
}
