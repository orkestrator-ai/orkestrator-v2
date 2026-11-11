import { describe, expect, mock, test } from "bun:test";
import type { DomainAdapterUsageEntry } from "@orkestrator/protocol/contract/client-usage";
import type { RendererErrorEntry } from "@orkestrator/protocol/renderer-errors";
import { startRendererDiagnostics } from "./renderer-diagnostics";
import { rendererErrorRoute } from "./renderer-error-ring";

type UploadOptions = { send: (entries: RendererErrorEntry[]) => Promise<unknown> };

const entry: RendererErrorEntry = {
  errorClass: "TypeError",
  boundary: "root",
  route: "browser",
  fingerprint: "0a1b2c3d",
  count: 1,
};

describe("diagnostics surface gate", () => {
  for (const [name, gateway, route, adapters] of [
    ["local desktop", undefined, "window", true],
    ["remote desktop", { enabled: true, desktop: true }, "window", true],
    ["browser", { enabled: true }, "browser", false],
  ] as const) {
    test(name, async () => {
      const report = mock(async () => true);
      const invoke = mock(async () => ({}));
      const scope = {
        location: { protocol: "http:", search: "" },
        orkestratorGateway: gateway,
        orkestratorDesktopHost: { api: { invoke, window: { setRendererDebugLogging: report } } },
      };
      const upload = mock((_options: UploadOptions) => () => {});
      const adapterUpload = mock(
        (_options: { send: (entries: DomainAdapterUsageEntry[]) => Promise<unknown> }) => () => {},
      );
      const stop = startRendererDiagnostics(
        scope as never,
        upload as never,
        adapterUpload,
        () => "client-0001",
      );
      expect(rendererErrorRoute(scope)).toBe(route);
      // Every surface sends its error ring; only a desktop window counts adapters.
      expect(upload).toHaveBeenCalledTimes(1);
      expect(adapterUpload).toHaveBeenCalledTimes(adapters ? 1 : 0);
      if (adapters) {
        await adapterUpload.mock.calls[0]![0].send([{ domain: "node-mail", version: 0, count: 1 }]);
        expect(invoke).toHaveBeenCalledWith("record_domain_adapter_usage", {
          entries: [{ domain: "node-mail", version: 0, count: 1 }],
        });
        await upload.mock.calls[0]![0].send([entry]);
        expect(invoke).toHaveBeenCalledWith("record_renderer_errors", {
          entries: [entry],
          client: "client-0001",
        });
      }
      stop?.();
      expect(report).toHaveBeenCalledTimes(1);
    });
  }
});

describe("a browser tab's upload", () => {
  const browserPage = {
    location: { protocol: "https:", search: "" },
    navigator: { userAgent: "Mozilla/5.0 (iPhone) AppleWebKit Safari" },
  };

  test("starts before the gateway exists and sends through it once it does", async () => {
    const scope: Record<string, unknown> = { ...browserPage };
    expect(rendererErrorRoute(scope)).toBe("browser");
    const upload = mock((_options: UploadOptions) => () => {});
    const adapterUpload = mock(() => () => {});
    startRendererDiagnostics(scope as never, upload as never, adapterUpload, () => "tab-000001");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(adapterUpload).not.toHaveBeenCalled();
    const { send } = upload.mock.calls[0]![0];

    // Before the application modules install the gateway the send fails, so
    // the uploader keeps the counts and retries.
    await expect(send([entry])).rejects.toThrow("not installed");

    const invoke = mock(async () => ({ accepted: 1, dropped: 0 }));
    scope.orkestratorGateway = { enabled: true };
    scope.orkestrator = { invoke };
    expect(await send([entry])).toEqual({ accepted: 1, dropped: 0 });
    expect(invoke).toHaveBeenCalledWith("record_renderer_errors", {
      entries: [entry],
      client: "tab-000001",
    });
  });

  test("a desktop page without its preload does not start a browser upload", () => {
    const upload = mock(() => () => {});
    for (const scope of [
      { location: { protocol: "file:" } },
      { location: { protocol: "http:" }, navigator: { userAgent: "Chrome Electron/41.0.0" } },
    ]) {
      expect(rendererErrorRoute(scope)).toBe("window");
      startRendererDiagnostics(
        scope as never,
        upload as never,
        mock(() => () => {}),
      );
    }
    expect(upload).not.toHaveBeenCalled();
  });
});
