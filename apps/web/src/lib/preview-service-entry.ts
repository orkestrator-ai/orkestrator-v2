import type { BrowserPreviewServiceTarget } from "@orkestrator/protocol/browser-preview";
import {
  formatPreviewIntentUri,
  formatPreviewServiceUri,
  type PreviewUrlSource,
} from "@orkestrator/protocol/preview-services";

import { ensurePreviewServiceSync, usePreviewServiceStore } from "@/stores/previewServiceStore";
import type { Environment } from "@/types";

const LOOPBACK_URL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?([/?#]|$)/i;

/**
 * Target for the environment's browser button: the registered entry service
 * (resolved to a transport only when the tab attaches), falling back to the
 * legacy entry address when the backend predates preview services.
 */
export async function environmentBrowserTarget(
  environment: Pick<Environment, "id">,
  legacyUrl: string | null,
): Promise<string | undefined> {
  ensurePreviewServiceSync();
  const store = usePreviewServiceStore.getState();
  const capabilities = await store.loadCapabilities();
  if (!capabilities) return legacyUrl ?? undefined;
  const snapshot = await store.refreshEnvironment(environment.id);
  const services = snapshot?.services ?? [];
  const entry =
    services.find((service) => service.definition.entry && service.definition.enabled) ??
    (services.length === 1 ? services[0] : undefined);
  if (!entry) return legacyUrl ?? undefined;
  return formatPreviewServiceUri({
    backendInstanceId: capabilities.backendInstanceId,
    environmentId: environment.id,
    serviceId: entry.definition.serviceId,
    path: "/",
  });
}

/**
 * Target for a loopback link printed by a terminal or agent. It is kept as an
 * unresolved intent interpreted in its *source* environment, so a container's
 * `localhost:3000` means that container's port 3000 rather than whichever
 * backend process owns host port 3000. Non-loopback links and older backends
 * keep the previous behaviour.
 */
export function linkBrowserTarget(
  environment: Pick<Environment, "id" | "environmentType"> | null | undefined,
  url: string,
  origin: "terminal" | "agent" = "terminal",
): string {
  if (!environment || !LOOPBACK_URL.test(url.trim())) return url;
  ensurePreviewServiceSync();
  if (usePreviewServiceStore.getState().status === "unsupported") return url;
  const source: PreviewUrlSource =
    origin === "agent"
      ? "agent-link"
      : environment.environmentType === "local"
        ? "worktree-terminal"
        : "container-terminal";
  return formatPreviewIntentUri({ environmentId: environment.id, source, url: url.trim() });
}

/** A same-service link opened from inside a service preview. */
export function serviceLinkTarget(target: BrowserPreviewServiceTarget): string {
  return formatPreviewServiceUri(target);
}
