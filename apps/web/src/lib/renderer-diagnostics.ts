import { RECORD_RENDERER_ERRORS_COMMAND } from "@orkestrator/protocol/renderer-errors";
import { reportRendererDebugLogging } from "./debug-log";
import { rendererErrorRing, rendererErrorRoute } from "./renderer-error-ring";
import { startRendererErrorUpload } from "./renderer-error-upload";

/** Start after preload readiness, before importing App or composing gateway transports. */
export function startRendererDiagnostics(
  scope: Pick<
    Window,
    "orkestrator" | "orkestratorDesktopHost" | "orkestratorGateway" | "location"
  > = window,
  upload = startRendererErrorUpload,
): (() => void) | undefined {
  const api = scope.orkestrator ?? scope.orkestratorDesktopHost?.api;
  reportRendererDebugLogging(api?.window);
  if (api && rendererErrorRoute(scope) === "window") {
    return upload({
      ring: rendererErrorRing,
      // Resolve the composed transport when available, with preload as the startup fallback.
      send: (entries) =>
        (scope.orkestrator ?? api).invoke(RECORD_RENDERER_ERRORS_COMMAND, { entries }),
    });
  }
}
