/**
 * The one `ModelRuntime` this process owns.
 *
 * Pi's runtime holds the credential store, the provider list and the model
 * catalogue, and it serializes credential writes internally. Creating a second
 * one would give this bridge two views of the same `auth.json` with no lock
 * between them, so every caller shares this instance.
 *
 * Creation is deferred and memoized rather than done at import: it reads the
 * user's config directory and may refresh a catalogue over the network, and a
 * bridge that cannot reach a provider must still start and serve its
 * transcript.
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { agentDirectory, CATALOG_TIMEOUT_MS } from "./config.js";
import { withTimeout } from "./timeout.js";

let runtime: ModelRuntime | null = null;
let creation: Promise<ModelRuntime> | null = null;

export async function modelRuntime(): Promise<ModelRuntime> {
  if (runtime) return runtime;
  // Shared, so concurrent first requests do not each build a runtime and race
  // to publish it. Cleared on failure so a transient config or network error
  // is retried rather than latched for the life of the process.
  creation ??= create().finally(() => {
    creation = null;
  });
  return creation;
}

async function create(): Promise<ModelRuntime> {
  const directory = agentDirectory();
  const created = await ModelRuntime.create({
    ...(directory
      ? { authPath: `${directory}/auth.json`, modelsPath: `${directory}/models.json` }
      : {}),
    // Dynamic providers publish their catalogues over HTTP. Allowed, because a
    // model list that is a week stale is a picker showing models the account no
    // longer has — but bounded, because it happens on the first request a tab
    // makes and a hung refresh would look like a bridge that never came up.
    allowModelNetwork: true,
    modelRefreshTimeoutMs: CATALOG_TIMEOUT_MS,
  });
  runtime = created;
  return created;
}

/**
 * Re-read every dynamic provider's catalogue.
 *
 * Bounded and best-effort: this is what `/global/refresh-catalog` calls, and a
 * provider that is down must not fail the request that asked for a refresh.
 */
export async function refreshRuntimeCatalog(): Promise<void> {
  const created = await modelRuntime();
  await withTimeout(created.refresh(), CATALOG_TIMEOUT_MS, "Pi catalogue refresh timed out").catch(
    () => undefined,
  );
}

/** Drop the memo so the next read rebuilds from disk. Tests only. */
export function resetModelRuntime(): void {
  runtime = null;
  creation = null;
}
