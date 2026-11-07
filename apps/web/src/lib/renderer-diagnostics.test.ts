import { describe, expect, mock, test } from "bun:test";
import type { DomainAdapterUsageEntry } from "@orkestrator/protocol/contract/client-usage";
import { startRendererDiagnostics } from "./renderer-diagnostics";
import { rendererErrorRoute } from "./renderer-error-ring";

describe("diagnostics surface gate", () => {
  for (const [name, gateway, route, starts] of [
    ["local desktop", undefined, "window", true],
    ["remote desktop", { enabled: true, desktop: true }, "window", true],
    ["browser", { enabled: true }, "browser", false],
  ] as const) {
    test(name, async () => {
      const report = mock(async () => true);
      const invoke = mock(async () => ({}));
      const scope = {
        location: { search: "" },
        orkestratorGateway: gateway,
        orkestratorDesktopHost: { api: { invoke, window: { setRendererDebugLogging: report } } },
      };
      const upload = mock(() => () => {});
      const adapterUpload = mock(
        (_options: { send: (entries: DomainAdapterUsageEntry[]) => Promise<unknown> }) => () => {},
      );
      const stop = startRendererDiagnostics(scope as never, upload, adapterUpload);
      expect(rendererErrorRoute(scope)).toBe(route);
      expect(upload).toHaveBeenCalledTimes(starts ? 1 : 0);
      expect(adapterUpload).toHaveBeenCalledTimes(starts ? 1 : 0);
      if (starts) {
        await adapterUpload.mock.calls[0]![0].send([{ domain: "node-mail", version: 0, count: 1 }]);
        expect(invoke).toHaveBeenCalledWith("record_domain_adapter_usage", {
          entries: [{ domain: "node-mail", version: 0, count: 1 }],
        });
      }
      stop?.();
      expect(report).toHaveBeenCalledTimes(1);
    });
  }
});
