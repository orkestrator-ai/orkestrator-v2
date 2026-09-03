export type DockerUnavailableReason =
  | "not-installed"
  | "permission-denied"
  | "daemon-unavailable"
  | "timed-out"
  | "unknown";

export type DockerAvailability =
  | { available: true; reason: null }
  | { available: false; reason: DockerUnavailableReason };
