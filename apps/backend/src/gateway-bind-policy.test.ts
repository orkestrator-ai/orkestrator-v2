import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  assertGatewayBindAllowed,
  assertProxiedModeHost,
  gatewayAllowsNonTailscaleBind,
  gatewayBindAddress,
} from "./gateway-bind-policy.js";
import { parseOptions } from "./options.js";

const REFUSED = "Refusing to bind gateway to non-Tailscale address";

/**
 * Runs the same checks `main.ts` and `GatewayLifecycle.start` run, in order.
 * `bindOverride` replaces the host after the startup host check, standing in
 * for a bind that reaches the gateway some other way.
 */
function startGuard(args: string[], bindOverride?: string): string | undefined {
  const options = parseOptions(args, {});
  assertProxiedModeHost(options);
  const effective = { ...options, host: bindOverride ?? options.host };
  const bindAddress = gatewayBindAddress(effective);
  const allowNonTailscaleBind = gatewayAllowsNonTailscaleBind(effective);
  if (bindAddress) {
    assertGatewayBindAllowed(bindAddress, { allowNonTailscaleBind, safeLoopbackFallback: false });
  }
  return bindAddress;
}

/** The guard alone, for a bind address the mode would hand the gateway. */
function guard(options: Parameters<typeof gatewayAllowsNonTailscaleBind>[0], address: string) {
  assertGatewayBindAllowed(address, {
    allowNonTailscaleBind: gatewayAllowsNonTailscaleBind({ ...options, host: address }),
    safeLoopbackFallback: false,
  });
}

const base = {
  host: undefined,
  tailscaleServe: false,
  desktopWebClient: false,
  allowNonTailscaleBind: false,
};

describe.each([
  ["--tailscale-serve", { ...base, tailscaleServe: true }],
  ["--desktop-web-client", { ...base, desktopWebClient: true }],
])("%s without --allow-non-tailscale-bind", (_flag, options) => {
  test.each(["127.0.0.1", "::1"])("accepts loopback %s", (address) => {
    expect(() => guard(options, address)).not.toThrow();
  });

  test.each(["100.101.102.103", "fd7a:115c:a1e0::1"])("accepts Tailscale %s", (address) => {
    expect(() => guard(options, address)).not.toThrow();
  });

  test.each(["0.0.0.0", "::", "192.168.1.20", "10.0.0.5"])("refuses %s", (address) => {
    expect(() => guard(options, address)).toThrow(`${REFUSED}: ${address}`);
  });

  test("defaults to 127.0.0.1 and starts", () => {
    expect(gatewayBindAddress(options)).toBe("127.0.0.1");
    expect(gatewayAllowsNonTailscaleBind(options)).toBe(true);
  });
});

describe("--allow-non-tailscale-bind", () => {
  test("still allows any address, with or without a proxy-fronted mode", () => {
    for (const mode of [{}, { tailscaleServe: true }, { desktopWebClient: true }]) {
      const options = { ...base, ...mode, allowNonTailscaleBind: true };
      expect(() => guard(options, "0.0.0.0")).not.toThrow();
      expect(() => guard(options, "192.168.1.20")).not.toThrow();
    }
  });

  test("parsed from the command line, allows 0.0.0.0", () => {
    expect(startGuard(["--host", "0.0.0.0", "--allow-non-tailscale-bind"])).toBe("0.0.0.0");
  });
});

describe("without a proxy-fronted mode or the allow flag", () => {
  test("refuses loopback and LAN addresses", () => {
    expect(() => guard(base, "127.0.0.1")).toThrow(`${REFUSED}: 127.0.0.1`);
    expect(() => guard(base, "0.0.0.0")).toThrow(`${REFUSED}: 0.0.0.0`);
  });

  test("accepts a Tailscale address and leaves an unset host to the gateway", () => {
    expect(() => guard(base, "100.64.0.1")).not.toThrow();
    expect(gatewayBindAddress(base)).toBeUndefined();
  });

  test("the gateway's own loopback fallback is still accepted", () => {
    expect(() =>
      assertGatewayBindAllowed("127.0.0.1", {
        allowNonTailscaleBind: false,
        safeLoopbackFallback: true,
      }),
    ).not.toThrow();
  });
});

describe("proxy-fronted modes on the command line", () => {
  test("--tailscale-serve --host 0.0.0.0 does not start", () => {
    expect(() => startGuard(["--tailscale-serve", "--host", "0.0.0.0"])).toThrow(
      "--tailscale-serve requires --host 127.0.0.1",
    );
  });

  test("a LAN bind reaching the guard is refused even without the host check", () => {
    expect(() => startGuard(["--tailscale-serve"], "0.0.0.0")).toThrow(`${REFUSED}: 0.0.0.0`);
    expect(() => startGuard(["--desktop-web-client"], "192.168.1.20")).toThrow(
      `${REFUSED}: 192.168.1.20`,
    );
  });

  test("--tailscale-serve with no host binds 127.0.0.1", () => {
    expect(startGuard(["--tailscale-serve"])).toBe("127.0.0.1");
  });
});

describe("the desktop's backend arguments", () => {
  // The web-client branch of `BackendProcess.launch` in
  // apps/desktop/electron/backend-process.ts, verbatim apart from the values
  // it fills in at runtime.
  const desktopArgs = [
    "/app/apps/backend/src/main.ts",
    "--port",
    "0",
    "--control-host",
    "127.0.0.1",
    "--control-port",
    "0",
    "--data-dir",
    "/var/tmp/ork-desktop-bind-policy",
    "--app-root",
    "/app",
    "--resource-root",
    "/app/resources",
    "--renderer-root",
    "/app/apps/web/dist",
    "--command-node",
    "--desktop-web-client",
    "--host",
    "127.0.0.1",
    "--allow-non-tailscale-bind",
    "--allowed-origins",
    "https://app.example.test",
  ];

  test("still start", () => {
    expect(startGuard(desktopArgs)).toBe("127.0.0.1");
    expect(gatewayAllowsNonTailscaleBind(parseOptions(desktopArgs, {}))).toBe(true);
  });

  test("still start without the allow flag", () => {
    const withoutAllow = desktopArgs.filter((arg) => arg !== "--allow-non-tailscale-bind");
    expect(startGuard(withoutAllow)).toBe("127.0.0.1");
  });

  test("match what backend-process.ts passes", () => {
    const source = readFileSync(
      path.resolve(import.meta.dir, "../../desktop/electron/backend-process.ts"),
      "utf8",
    );
    expect(source).toMatch(
      /"--desktop-web-client",\s*"--host",\s*"127\.0\.0\.1",\s*"--allow-non-tailscale-bind",/,
    );
  });
});
