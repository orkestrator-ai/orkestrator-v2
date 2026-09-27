/**
 * The installed-instance descriptor a running backend publishes in its data
 * directory once it is ready, so an operator client can find that exact
 * instance without scanning ports or reading development manifests.
 *
 * It names the endpoint and the private credential file; it never contains
 * the credential itself. `installationId` is stable for one data directory
 * (a copied directory mints a new one); `generation` changes on every start,
 * which is how a client detects a restarted or replaced process.
 */

export const BACKEND_INSTANCE_DESCRIPTOR_FILE = "backend-instance.json";
export const BACKEND_INSTANCE_DESCRIPTOR_TYPE = "orkestrator-backend-instance";
export const BACKEND_INSTANCE_DESCRIPTOR_MAX_BYTES = 16 * 1024;

export interface BackendInstanceDescriptor {
  version: 1;
  type: typeof BACKEND_INSTANCE_DESCRIPTOR_TYPE;
  installationId: string;
  generation: string;
  pid: number;
  startedAt: string;
  /** Primary gateway URL (the loopback control listener when one exists). */
  url: string;
  /** Browser/remote listener URL, when one is serving. */
  browserUrl?: string;
  /** Absolute path of the mode-0600 gateway credential file. */
  authFile: string;
  /** Absolute data directory this backend owns. */
  dataDir: string;
  appVersion: string;
  publicApiSchemaVersion: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

/** Strict parse; throws a content-free message on any mismatch. */
export function parseBackendInstanceDescriptor(value: unknown): BackendInstanceDescriptor {
  if (!isRecord(value)) throw new Error("Backend instance descriptor must be an object");
  if (value.version !== 1 || value.type !== BACKEND_INSTANCE_DESCRIPTOR_TYPE) {
    throw new Error("Backend instance descriptor has an unsupported version");
  }
  const text = (key: string, max = 512): string => {
    const field = value[key];
    if (typeof field !== "string" || field.length === 0 || field.length > max) {
      throw new Error(`Backend instance descriptor field is invalid: ${key}`);
    }
    return field;
  };
  if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) {
    throw new Error("Backend instance descriptor field is invalid: pid");
  }
  if (!isHttpUrl(value.url)) throw new Error("Backend instance descriptor field is invalid: url");
  if (value.browserUrl !== undefined && !isHttpUrl(value.browserUrl)) {
    throw new Error("Backend instance descriptor field is invalid: browserUrl");
  }
  if (
    !Number.isSafeInteger(value.publicApiSchemaVersion) ||
    (value.publicApiSchemaVersion as number) < 1
  ) {
    throw new Error("Backend instance descriptor field is invalid: publicApiSchemaVersion");
  }
  const authFile = text("authFile", 4096);
  const dataDir = text("dataDir", 4096);
  if (!authFile.startsWith("/") || !dataDir.startsWith("/")) {
    throw new Error("Backend instance descriptor paths must be absolute");
  }
  return {
    version: 1,
    type: BACKEND_INSTANCE_DESCRIPTOR_TYPE,
    installationId: text("installationId", 200),
    generation: text("generation", 200),
    pid: value.pid as number,
    startedAt: text("startedAt", 64),
    url: value.url,
    ...(value.browserUrl !== undefined ? { browserUrl: value.browserUrl as string } : {}),
    authFile,
    dataDir,
    appVersion: text("appVersion", 64),
    publicApiSchemaVersion: value.publicApiSchemaVersion as number,
  };
}
