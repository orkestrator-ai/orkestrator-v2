import { describe, expect, mock, test } from "bun:test";
import { startRendererDiagnostics } from "./renderer-diagnostics";
import { rendererErrorRoute } from "./renderer-error-ring";

describe("diagnostics surface gate", () => {
  for (const [name, gateway, search, route, starts] of [
    ["local desktop", undefined, "", "window", true],
    ["remote desktop", { enabled: true, desktop: true }, "", "window", true],
    ["workspace", { enabled: true, desktop: true }, "?realm=workspace", "realm", false],
    ["browser workspace", { enabled: true }, "?realm=workspace", "realm", false],
    ["browser", { enabled: true }, "", "browser", false],
  ] as const) {
    test(name, () => {
      const report = mock(async () => true);
      const invoke = mock(async () => ({}));
      const scope = {
        location: { search },
        orkestratorGateway: gateway,
        orkestratorDesktopHost: { api: { invoke, window: { setRendererDebugLogging: report } } },
      };
      const upload = mock(() => () => {});
      startRendererDiagnostics(scope as never, upload);
      expect(rendererErrorRoute(scope)).toBe(route);
      expect(upload).toHaveBeenCalledTimes(starts ? 1 : 0);
      expect(report).toHaveBeenCalledTimes(1);
    });
  }
});
