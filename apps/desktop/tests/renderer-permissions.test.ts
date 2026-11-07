import { describe, expect, mock, test } from "bun:test";
import { installRendererPermissionPolicy } from "../electron/renderer-permissions";

import { configureLogger, resetLogger } from "@orkestrator/protocol/logger";

const RENDERER = "file:///app/web/index.html";

function install(trusted = RENDERER) {
  let check: ((...args: any[]) => boolean) | undefined;
  let request: ((...args: any[]) => void) | undefined;
  installRendererPermissionPolicy(
    {
      webRequest: { onBeforeRequest: mock(() => undefined) } as never,
      setPermissionCheckHandler: (handler: any) => {
        check = handler;
      },
      setPermissionRequestHandler: (handler: any) => {
        request = handler;
      },
    },
    trusted,
  );
  return {
    check: (permission: string, details: { isMainFrame: boolean; requestingUrl?: string }) =>
      check!(null, permission, "file:///", details),
    request: (permission: string, details: { isMainFrame: boolean; requestingUrl?: string }) => {
      const callback = mock((_granted: boolean) => undefined);
      request!({}, permission, callback, details);
      expect(callback).toHaveBeenCalledTimes(1);
      return callback.mock.calls[0]![0];
    },
  };
}

const mainFrame = { isMainFrame: true, requestingUrl: `${RENDERER}?project=p` };

describe("renderer permission policy", () => {
  test("grants the renderer's own document a clipboard write, fullscreen and notifications", () => {
    const policy = install();
    for (const permission of ["clipboard-sanitized-write", "fullscreen", "notifications"]) {
      expect(policy.request(permission, mainFrame)).toBe(true);
      expect(policy.check(permission, mainFrame)).toBe(true);
    }
  });

  test("refuses everything else, including what a future Electron adds", () => {
    const policy = install();
    for (const permission of [
      "media",
      "geolocation",
      "clipboard-read",
      "openExternal",
      "display-capture",
      "permission-added-next-year",
    ]) {
      expect(policy.request(permission, mainFrame)).toBe(false);
      expect(policy.check(permission, mainFrame)).toBe(false);
    }
  });

  test.each(["clipboard-sanitized-write", "notifications"])(
    "refuses %s to a subframe, another document, and an unknown requester",
    (permission) => {
      const policy = install();
      expect(policy.request(permission, { ...mainFrame, isMainFrame: false })).toBe(false);
      expect(
        policy.request(permission, { isMainFrame: true, requestingUrl: "file:///etc/other.html" }),
      ).toBe(false);
      expect(
        policy.request(permission, { isMainFrame: true, requestingUrl: "https://example.com/" }),
      ).toBe(false);
      expect(policy.request(permission, { isMainFrame: true })).toBe(false);
      expect(policy.check(permission, { isMainFrame: true })).toBe(false);
    },
  );

  test("trusts the dev server's origin in development", () => {
    const policy = install("http://127.0.0.1:1420");
    expect(
      policy.request("fullscreen", { isMainFrame: true, requestingUrl: "http://127.0.0.1:1420/x" }),
    ).toBe(true);
    expect(
      policy.request("fullscreen", { isMainFrame: true, requestingUrl: "http://127.0.0.1:3000/" }),
    ).toBe(false);
  });
});

test("checks and requests share one denial diagnostic per permission", () => {
  const lines: string[] = [];
  configureLogger({ sink: ({ line }) => lines.push(line) });
  try {
    const policy = install();
    policy.check("media", mainFrame);
    policy.check("media", mainFrame);
    policy.request("media", mainFrame);
    policy.request("geolocation", mainFrame);
    policy.check("geolocation", mainFrame);
    policy.check("fullscreen", mainFrame);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("media");
    expect(lines[1]).toContain("geolocation");
  } finally {
    resetLogger();
  }
});
