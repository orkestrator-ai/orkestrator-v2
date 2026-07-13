import { describe, expect, test } from "bun:test";
import path from "node:path";
import { assertSupportedPlatform, defaultDataDir, parseOptions } from "./options.js";

describe("standalone backend options", () => {
  test("uses platform-specific default data directories", () => {
    expect(defaultDataDir("darwin", {}, "/home/test")).toBe(
      path.join("/home/test", "Library", "Application Support", "orkestrator-v2"),
    );
    expect(() => defaultDataDir("win32", {}, "C:\\Users\\test")).toThrow("does not support Windows");
    expect(defaultDataDir("linux", { XDG_CONFIG_HOME: "/config" }, "/home/test")).toBe(
      "/config/orkestrator-v2",
    );
  });

  test("parses explicit paths, ephemeral ports, and development options", () => {
    const options = parseOptions([
      "--data-dir", "/tmp/data",
      "--app-root", "/tmp/app",
      "--resource-root", "/tmp/resources",
      "--renderer-root", "/tmp/web",
      "--renderer-dev-server-url", "http://127.0.0.1:1420",
      "--host", "127.0.0.1",
      "--fallback-host", "127.0.0.2",
      "--port", "0",
      "--control-host", "127.0.0.1",
      "--control-port", "0",
      "--allow-non-tailscale-bind",
      "--allowed-origins", "https://orkestrator.example,https://*.vercel.app",
      "--tailscale-serve",
      "--tailscale-serve-port", "8443",
      "--tailscale-bin", "/opt/tailscale",
    ], {});

    expect(options).toMatchObject({
      dataDir: "/tmp/data",
      appRoot: "/tmp/app",
      resourceRoot: "/tmp/resources",
      rendererRoot: "/tmp/web",
      rendererDevServerUrl: "http://127.0.0.1:1420",
      host: "127.0.0.1",
      fallbackHost: "127.0.0.2",
      port: 0,
      controlHost: "127.0.0.1",
      controlPort: 0,
      allowNonTailscaleBind: true,
      allowedOrigins: ["https://orkestrator.example", "https://*.vercel.app"],
      tailscaleServe: true,
      tailscaleServePort: 8443,
      tailscaleExecutable: "/opt/tailscale",
    });
  });

  test("rejects malformed, out-of-range, and missing option values", () => {
    expect(() => parseOptions(["--port", "3oops"], {})).toThrow("Invalid --port value");
    expect(() => parseOptions(["--port", "65536"], {})).toThrow("Invalid --port value");
    expect(() => parseOptions(["--host", "--port", "1"], {})).toThrow("Missing value for --host");
    expect(() => parseOptions(["--fallback-host", "--port", "1"], {})).toThrow("Missing value for --fallback-host");
    expect(() => parseOptions(["--control-port", "65536"], {})).toThrow("Invalid --control-port value");
    expect(() => parseOptions(["--control-host", "--port", "1"], {})).toThrow("Missing value for --control-host");
    expect(() => parseOptions(["--allowed-origins", "--port", "1"], {})).toThrow("Missing value for --allowed-origins");
    expect(() => parseOptions(["--tailscale-serve-port", "65536"], {})).toThrow("Invalid --tailscale-serve-port value");
    expect(() => parseOptions(["--tailscale-serve-port", "0"], {})).toThrow("Invalid --tailscale-serve-port value");
    expect(() => parseOptions(["--tailscale-bin", "--port", "1"], {})).toThrow("Missing value for --tailscale-bin");
  });

  test("supports environment-managed Tailscale Serve configuration", () => {
    const options = parseOptions([], {
      ORKESTRATOR_TAILSCALE_SERVE: "1",
      ORKESTRATOR_TAILSCALE_SERVE_PORT: "9443",
      ORKESTRATOR_TAILSCALE_BIN: "/usr/local/bin/tailscale",
    });

    expect(options).toMatchObject({
      tailscaleServe: true,
      tailscaleServePort: 9443,
      tailscaleExecutable: "/usr/local/bin/tailscale",
    });
  });

  test("reads allowed origins from the environment and lets CLI values take precedence", () => {
    expect(parseOptions([], {
      ORKESTRATOR_GATEWAY_ALLOWED_ORIGINS: " https://one.example, ,https://*.example.net ",
    }).allowedOrigins).toEqual(["https://one.example", "https://*.example.net"]);

    expect(parseOptions([
      "--allowed-origins", "https://cli.example",
      "--tailscale-serve-port", "9443",
      "--tailscale-bin", "/cli/tailscale",
    ], {
      ORKESTRATOR_GATEWAY_ALLOWED_ORIGINS: "https://env.example",
      ORKESTRATOR_TAILSCALE_SERVE_PORT: "8443",
      ORKESTRATOR_TAILSCALE_BIN: "/env/tailscale",
    })).toMatchObject({
      allowedOrigins: ["https://cli.example"],
      tailscaleServePort: 9443,
      tailscaleExecutable: "/cli/tailscale",
    });
  });

  test("only enables environment-managed Tailscale Serve for the explicit value 1", () => {
    expect(parseOptions([], { ORKESTRATOR_TAILSCALE_SERVE: "0" }).tailscaleServe).toBe(false);
    expect(parseOptions([], { ORKESTRATOR_TAILSCALE_SERVE: "true" }).tailscaleServe).toBe(false);
    expect(parseOptions([], { ORKESTRATOR_TAILSCALE_SERVE: "1" }).tailscaleServe).toBe(true);
    expect(parseOptions(["--tailscale-serve"], {}).tailscaleServe).toBe(true);
  });

  test("explicitly supports macOS and Linux only", () => {
    expect(() => assertSupportedPlatform("darwin")).not.toThrow();
    expect(() => assertSupportedPlatform("linux")).not.toThrow();
    expect(() => assertSupportedPlatform("win32")).toThrow("does not support Windows");
  });
});
