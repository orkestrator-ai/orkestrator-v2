import { RECORD_DOMAIN_ADAPTER_USAGE_COMMAND } from "@orkestrator/protocol/contract/client-usage";
import { RECORD_RENDERER_ERRORS_COMMAND } from "@orkestrator/protocol/renderer-errors";
import { reportRendererDebugLogging } from "./debug-log";
import { rendererErrorRing, rendererErrorRoute } from "./renderer-error-ring";
import { startRendererErrorUpload } from "./renderer-error-upload";
import { rendererErrorClientId, rendererErrorSender } from "./renderer-error-client";
import { startDomainAdapterUsageUpload } from "./domain-adapter-usage-ring";

type DiagnosticsScope = Pick<
  Window,
  "orkestrator" | "orkestratorDesktopHost" | "orkestratorGateway" | "location" | "navigator"
>;

/** Start after preload readiness, before importing App or composing gateway transports. */
export function startRendererDiagnostics(
  scope: Partial<DiagnosticsScope> = window,
  upload = startRendererErrorUpload,
  adapterUpload = startDomainAdapterUsageUpload,
  clientId: () => string = () => rendererErrorClientId(),
): (() => void) | undefined {
  const api = scope.orkestrator ?? scope.orkestratorDesktopHost?.api;
  reportRendererDebugLogging(api?.window);
  const route = rendererErrorRoute(scope);
  if (api && route === "window") {
    const stopErrors = upload({
      ring: rendererErrorRing,
      // Resolve the composed transport when available, with preload as the startup fallback.
      send: rendererErrorSender(
        (args) => (scope.orkestrator ?? api).invoke(RECORD_RENDERER_ERRORS_COMMAND, args),
        clientId(),
      ),
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
  if (route === "browser") {
    // A browser tab (the iOS app's web view included) sends its ring to the
    // backend it is signed in to, under its own share of that backend's
    // per-minute bound. Its gateway is installed when the application modules
    // load, after this runs: a send before then fails and is retried later,
    // and the session-storage journal keeps the counts across a reload.
    return upload({
      ring: rendererErrorRing,
      send: rendererErrorSender((args) => {
        const gateway = scope.orkestrator;
        if (!gateway) return Promise.reject(new Error("The gateway is not installed yet."));
        return gateway.invoke(RECORD_RENDERER_ERRORS_COMMAND, args);
      }, clientId()),
    });
  }
}
