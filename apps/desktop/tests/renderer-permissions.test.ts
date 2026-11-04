import { describe, expect, mock, test } from "bun:test";
import { installRendererPermissionPolicy } from "../electron/renderer-permissions";

const RENDERER = "file:///app/web/index.html";

function install(trusted = RENDERER) {
  let check: ((...args: any[]) => boolean) | undefined;
  let request: ((...args: any[]) => void) | undefined;
  installRendererPermissionPolicy(
    {
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

const mainFrame = { isMainFrame: true, requestingUrl: `${RENDERER}?realm=workspace` };

describe("renderer permission policy", () => {
  test("grants the renderer's own document a clipboard write and fullscreen", () => {
    const policy = install();
    for (const permission of ["clipboard-sanitized-write", "fullscreen"]) {
      expect(policy.request(permission, mainFrame)).toBe(true);
      expect(policy.check(permission, mainFrame)).toBe(true);
    }
  });

  test("refuses everything else, including what a future Electron adds", () => {
    const policy = install();
    for (const permission of [
      "media",
      "geolocation",
      "notifications",
      "clipboard-read",
      "openExternal",
      "display-capture",
      "permission-added-next-year",
    ]) {
      expect(policy.request(permission, mainFrame)).toBe(false);
      expect(policy.check(permission, mainFrame)).toBe(false);
    }
  });

  test("refuses a subframe, another document, and an unknown requester", () => {
    const policy = install();
    const permission = "clipboard-sanitized-write";
    expect(policy.request(permission, { ...mainFrame, isMainFrame: false })).toBe(false);
    expect(
      policy.request(permission, { isMainFrame: true, requestingUrl: "file:///etc/other.html" }),
    ).toBe(false);
    expect(
      policy.request(permission, { isMainFrame: true, requestingUrl: "https://example.com/" }),
    ).toBe(false);
    expect(policy.request(permission, { isMainFrame: true })).toBe(false);
    expect(policy.check(permission, { isMainFrame: true })).toBe(false);
  });

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
