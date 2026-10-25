import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { openCodeSdkFetch } from "./http-bridge-transport.js";

export type { OpencodeClient };

/**
 * The OpenCode SDK client the provider builds by default: every request it
 * makes is charged as a `provider-request` through {@link openCodeSdkFetch},
 * unless the caller passes its own `fetch`.
 */
export const createOpenCodeSdkClient: typeof createOpencodeClient = (config) =>
  createOpencodeClient({ fetch: openCodeSdkFetch, ...config });
