/** Authoritative runtime state for the remote web client gateway. */
export interface WebClientStatus {
  enabled: boolean;
  running: boolean;
  url: string | null;
  error: string | null;
}
