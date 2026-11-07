import { afterEach, describe, expect, test } from "bun:test";
import { provisionalBackendId } from "@orkestrator/protocol/federation";
import {
  backendOnThisDevice,
  getGatewayBaseUrl,
  isBackendOnAnotherDevice,
  isGatewayBrowserPreviewSupported,
  isRemoteGatewayConnection,
  resolveGatewayApiUrl,
  resolveGatewayBrowserPreviewUrl,
  localInstallationId,
  resolveGatewayLoopbackBaseUrl,
} from "./gateway-url";

afterEach(() => {
  delete window.orkestratorGateway;
  delete window.orkestratorDesktopIdentity;
});

describe("isRemoteGatewayConnection", () => {
  test("identifies an Electron desktop connected to a remote backend", () => {
    expect(isRemoteGatewayConnection()).toBe(false);

    window.orkestratorGateway = {
      enabled: true,
      desktop: true,
      baseUrl: "https://workstation.tailnet.ts.net/",
    };
    expect(isRemoteGatewayConnection()).toBe(true);
  });

  test("identifies browser clients using a non-loopback gateway", () => {
    window.orkestratorGateway = {
      enabled: true,
      baseUrl: "https://workstation.tailnet.ts.net/",
    };
    expect(isRemoteGatewayConnection()).toBe(true);
  });

  test("keeps loopback browser gateways local", () => {
    window.orkestratorGateway = {
      enabled: true,
      baseUrl: "http://127.0.0.1:5173/",
    };
    expect(isRemoteGatewayConnection()).toBe(false);

    window.orkestratorGateway = { enabled: true };
    expect(isRemoteGatewayConnection()).toBe(false);
  });

  test("ignores disabled gateway metadata", () => {
    window.orkestratorGateway = {
      enabled: false,
      desktop: true,
      baseUrl: "https://workstation.tailnet.ts.net/",
    };
    expect(isRemoteGatewayConnection()).toBe(false);
  });
});

describe("isBackendOnAnotherDevice", () => {
  test("is false without a gateway and for loopback browser gateways", () => {
    expect(isBackendOnAnotherDevice()).toBe(false);

    window.orkestratorGateway = { enabled: true, baseUrl: "http://127.0.0.1:5173/" };
    expect(isBackendOnAnotherDevice()).toBe(false);
  });

  test("is true for a desktop gateway to another machine", () => {
    window.orkestratorGateway = {
      enabled: true,
      desktop: true,
      baseUrl: "https://workstation.tailnet.ts.net/",
    };
    expect(isBackendOnAnotherDevice()).toBe(true);
  });

  test("is false for a desktop gateway that leads back to this computer", () => {
    window.orkestratorGateway = {
      enabled: true,
      desktop: true,
      backendOnThisDevice: true,
      baseUrl: "https://laptop.tailnet.ts.net/",
    };
    expect(isBackendOnAnotherDevice()).toBe(false);
    // The commands still travel through a gateway, so proxy decisions keep it.
    expect(isRemoteGatewayConnection()).toBe(true);
  });
});

describe("backendOnThisDevice(nodeId)", () => {
  const desktop = (backendId: string | null, local: string | null) => {
    window.orkestratorDesktopIdentity = {
      connectionId: backendId === local ? "local" : "remote-1",
      backendId,
      legacyOrigin: null,
      localInstallationId: local,
    };
  };
  const scope = (nodeId: string, role: "command" | "leaf") => ({ nodeId, role });

  test("is true only for this computer's installation id", () => {
    desktop("bk_cmd", "bk_desk");
    window.orkestratorGateway = { enabled: true, desktop: true, baseUrl: "https://cmd.test" };
    expect(localInstallationId()).toBe("bk_desk");
    expect(backendOnThisDevice("bk_desk")).toBe(true);
    expect(backendOnThisDevice(scope("bk_desk", "leaf"))).toBe(true);
    expect(backendOnThisDevice("bk_leaf")).toBe(false);
    expect(backendOnThisDevice(scope("bk_leaf", "leaf"))).toBe(false);
    // The command node (another computer here) by id, by scope or by default.
    expect(backendOnThisDevice("bk_cmd")).toBe(false);
    expect(backendOnThisDevice(scope(provisionalBackendId("command-node"), "command"))).toBe(false);
    expect(backendOnThisDevice()).toBe(false);
    expect(isBackendOnAnotherDevice("bk_leaf")).toBe(true);
    expect(isBackendOnAnotherDevice("bk_desk")).toBe(false);
  });

  test("a command node that is this computer is on this device, gateway or not", () => {
    desktop("bk_desk", "bk_desk");
    expect(backendOnThisDevice()).toBe(true);
    expect(backendOnThisDevice(provisionalBackendId("command-node"))).toBe(true);
    // Even when its route is a gateway (this computer shown through a tunnel).
    window.orkestratorGateway = { enabled: true, desktop: true, baseUrl: "https://desk.test" };
    expect(isBackendOnAnotherDevice()).toBe(false);
    expect(backendOnThisDevice("bk_other")).toBe(false);
  });

  test("without a local installation id, only the command node can be on this device", () => {
    // A browser client: no desktop identity at all.
    expect(localInstallationId()).toBeNull();
    expect(backendOnThisDevice()).toBe(true);
    expect(backendOnThisDevice("bk_leaf")).toBe(false);
    window.orkestratorGateway = { enabled: true, baseUrl: "https://cmd.example/" };
    expect(backendOnThisDevice()).toBe(false);
    // Desktop before the local backend answered: the gateway's flag decides.
    desktop("bk_cmd", null);
    window.orkestratorGateway = {
      enabled: true,
      desktop: true,
      backendOnThisDevice: true,
      baseUrl: "https://cmd.test",
    };
    expect(backendOnThisDevice()).toBe(true);
    expect(backendOnThisDevice("bk_cmd")).toBe(true);
    expect(backendOnThisDevice("bk_leaf")).toBe(false);
  });

  test("a leaf is always reached through a gateway", () => {
    desktop("bk_desk", "bk_desk");
    expect(isRemoteGatewayConnection()).toBe(false);
    expect(isRemoteGatewayConnection(scope("bk_desk", "command"))).toBe(false);
    expect(isRemoteGatewayConnection("bk_leaf")).toBe(true);
    expect(isRemoteGatewayConnection(scope("bk_leaf", "leaf"))).toBe(true);
  });
});

describe("isGatewayBrowserPreviewSupported", () => {
  test("supports previews with no gateway and with the desktop gateway", () => {
    expect(isGatewayBrowserPreviewSupported()).toBe(true);

    window.orkestratorGateway = {
      enabled: true,
      desktop: true,
      baseUrl: "https://workstation.tailnet.ts.net/",
    };
    expect(isGatewayBrowserPreviewSupported()).toBe(true);
  });

  test("rejects previews in the non-desktop web client", () => {
    window.orkestratorGateway = { enabled: true };
    expect(isGatewayBrowserPreviewSupported()).toBe(false);

    window.orkestratorGateway = { enabled: false };
    expect(isGatewayBrowserPreviewSupported()).toBe(true);
  });
});

describe("resolveGatewayBrowserPreviewUrl", () => {
  test("uses the dedicated backend browser namespace", () => {
    window.orkestratorGateway = {
      enabled: true,
      baseUrl: "https://workstation.tailnet.ts.net/",
    };

    expect(resolveGatewayBrowserPreviewUrl("http://localhost:3000/app?mode=dark#main")).toBe(
      "https://workstation.tailnet.ts.net/__orkestrator/browser/loopback/3000/app?mode=dark#main",
    );
  });

  test("leaves addresses direct when no remote gateway is active", () => {
    expect(resolveGatewayBrowserPreviewUrl("http://localhost:3000/")).toBe(
      "http://localhost:3000/",
    );
  });

  test("uses the current origin when the gateway has no explicit base URL", () => {
    window.orkestratorGateway = { enabled: true };
    expect(resolveGatewayBrowserPreviewUrl("http://localhost:3000/")).toBe(
      `${window.location.origin}/__orkestrator/browser/loopback/3000/`,
    );
  });

  test("supports IPv6 and the default HTTP port", () => {
    window.orkestratorGateway = { enabled: true };
    expect(resolveGatewayBrowserPreviewUrl("http://[::1]:6000/api/")).toBe(
      `${window.location.origin}/__orkestrator/browser/loopback/6000/api/`,
    );
    expect(resolveGatewayBrowserPreviewUrl("http://127.0.0.1/")).toBe(
      `${window.location.origin}/__orkestrator/browser/loopback/80/`,
    );
  });

  test("leaves invalid, non-loopback, and non-HTTP addresses unchanged", () => {
    window.orkestratorGateway = { enabled: true };
    for (const address of ["not a url", "http://example.com:3000/", "https://localhost:3000/"]) {
      expect(resolveGatewayBrowserPreviewUrl(address)).toBe(address);
    }
  });
});

describe("resolveGatewayLoopbackBaseUrl", () => {
  test("uses and normalizes a configured direct gateway base URL", () => {
    window.orkestratorGateway = {
      enabled: true,
      baseUrl: "https://workstation.tailnet.ts.net/",
    };

    expect(getGatewayBaseUrl()).toBe("https://workstation.tailnet.ts.net");
    expect(resolveGatewayApiUrl("__orkestrator/status")).toBe(
      "https://workstation.tailnet.ts.net/__orkestrator/status",
    );
    expect(resolveGatewayApiUrl("/__orkestrator/status")).toBe(
      "https://workstation.tailnet.ts.net/__orkestrator/status",
    );
    expect(resolveGatewayLoopbackBaseUrl("http://127.0.0.1:4000/api/")).toBe(
      "https://workstation.tailnet.ts.net/__orkestrator/proxy/loopback/4000/api",
    );
  });

  test("uses same-origin URLs when no direct base URL is configured", () => {
    expect(getGatewayBaseUrl()).toBe(window.location.origin);
    expect(resolveGatewayApiUrl("__orkestrator/status")).toBe("/__orkestrator/status");
  });

  test("leaves loopback URLs unchanged outside the remote gateway", () => {
    expect(resolveGatewayLoopbackBaseUrl("http://127.0.0.1:4000")).toBe("http://127.0.0.1:4000");
  });

  test("rewrites loopback URLs to the authenticated gateway proxy", () => {
    window.orkestratorGateway = { enabled: true };

    expect(resolveGatewayLoopbackBaseUrl("http://127.0.0.1:4000")).toBe(
      `${window.location.origin}/__orkestrator/proxy/loopback/4000`,
    );
    expect(resolveGatewayLoopbackBaseUrl("http://localhost:5000/api")).toBe(
      `${window.location.origin}/__orkestrator/proxy/loopback/5000/api`,
    );
    expect(resolveGatewayLoopbackBaseUrl("http://[::1]:6000/api/")).toBe(
      `${window.location.origin}/__orkestrator/proxy/loopback/6000/api`,
    );
  });

  test("does not rewrite non-loopback URLs", () => {
    window.orkestratorGateway = { enabled: true };

    expect(resolveGatewayLoopbackBaseUrl("http://example.com:4000")).toBe(
      "http://example.com:4000",
    );
  });

  test("leaves invalid URLs unchanged and routes the default HTTP port", () => {
    window.orkestratorGateway = { enabled: true };

    expect(resolveGatewayLoopbackBaseUrl("not a url")).toBe("not a url");
    expect(resolveGatewayLoopbackBaseUrl("http://127.0.0.1")).toBe(
      `${window.location.origin}/__orkestrator/proxy/loopback/80`,
    );
  });

  test("preserves query strings and fragments", () => {
    window.orkestratorGateway = { enabled: true };

    expect(resolveGatewayLoopbackBaseUrl("http://localhost:4000/app?mode=dark#main")).toBe(
      `${window.location.origin}/__orkestrator/proxy/loopback/4000/app?mode=dark#main`,
    );
  });
});
