/** Authoritative runtime state for the remote web client gateway. */
export interface WebClientStatus {
  enabled: boolean;
  running: boolean;
  url: string | null;
  error: string | null;
  /** Whether the current Tailscale Serve conflict can be explicitly reset. */
  resetAvailable?: boolean;
}

/** Gateway credential settings exposed only to an authenticated client. */
export interface GatewayTokenSettings {
  token: string;
  editable: boolean;
  source: "file" | "environment";
}
