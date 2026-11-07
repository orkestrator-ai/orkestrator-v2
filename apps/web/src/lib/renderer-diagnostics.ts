import { RECORD_DOMAIN_ADAPTER_USAGE_COMMAND } from "@orkestrator/protocol/contract/client-usage";
import { RECORD_RENDERER_ERRORS_COMMAND } from "@orkestrator/protocol/renderer-errors";
import { reportRendererDebugLogging } from "./debug-log";
import { rendererErrorRing, rendererErrorRoute } from "./renderer-error-ring";
import { startRendererErrorUpload } from "./renderer-error-upload";
import { startDomainAdapterUsageUpload } from "./domain-adapter-usage-ring";

/** Start after preload readiness, before importing App or composing gateway transports. */
export function startRendererDiagnostics(
  scope: Pick<Window, "orkestrator" | "orkestratorDesktopHost" | "orkestratorGateway"> = window,
  upload = startRendererErrorUpload,
  adapterUpload = startDomainAdapterUsageUpload,
): (() => void) | undefined {
  const api = scope.orkestrator ?? scope.orkestratorDesktopHost?.api;
  reportRendererDebugLogging(api?.window);
  if (api && rendererErrorRoute(scope) === "window") {
    const stopErrors = upload({
      ring: rendererErrorRing,
      // Resolve the composed transport when available, with preload as the startup fallback.
      send: (entries) =>
        (scope.orkestrator ?? api).invoke(RECORD_RENDERER_ERRORS_COMMAND, { entries }),
    });
    // Domain client adapter counts (plan item 1009) go the same way, to this
    // window's own backend; idle until a domain client takes an older adapter.
    const stopAdapters = adapterUpload({
      send: (entries) =>
        (scope.orkestrator ?? api).invoke(RECORD_DOMAIN_ADAPTER_USAGE_COMMAND, { entries }),
    });
    return () => {
      stopErrors();
      stopAdapters();
    };
  }
}
