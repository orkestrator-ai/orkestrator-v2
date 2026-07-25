export const APP_SLUG = "orkestrator-v2";
export const PRODUCT_NAME = "Orkestrator AI";

export const DOCKER_IMAGE = "orkestrator-v2:latest";
export const DOCKER_LABEL_APP = "app";
export const DOCKER_LABEL_APP_VALUE = APP_SLUG;
export const DOCKER_LABEL_ENVIRONMENT_ID = "environment-id";
export const DOCKER_LABEL_PROJECT_ID = "project-id";

export const OPENCODE_SERVER_PORT = 4096;
export const CLAUDE_BRIDGE_PORT = 4097;
export const CODEX_BRIDGE_PORT = 4098;

export const ORKESTRATOR_PROJECT_CONFIG = "orkestrator-ai.json";

/**
 * Orkestrator version, forwarded to the Codex bridge and on to app-server as
 * `clientInfo.version` (app-server uses it for compliance logging).
 *
 * Sanitized to a conservative charset because it is interpolated into the
 * `docker exec` script that starts the container bridge. It comes from the
 * environment, so anything not matching gets replaced rather than trusted — an
 * unexpected value should degrade the reported version, never execute.
 */
export function sanitizeAppVersion(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? "";
  return /^[A-Za-z0-9._+-]{1,64}$/.test(trimmed) ? trimmed : "0.0.0";
}

export const APP_VERSION = process.env.ORKESTRATOR_VERSION?.trim() || "0.0.0";
