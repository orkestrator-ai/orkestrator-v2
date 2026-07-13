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
      "--unsafe-allow-non-tailscale-bind",
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
      unsafeAllowNonTailscaleBind: true,
    });
  });

  test("rejects malformed, out-of-range, and missing option values", () => {
    expect(() => parseOptions(["--port", "3oops"], {})).toThrow("Invalid --port value");
    expect(() => parseOptions(["--port", "65536"], {})).toThrow("Invalid --port value");
    expect(() => parseOptions(["--host", "--port", "1"], {})).toThrow("Missing value for --host");
    expect(() => parseOptions(["--fallback-host", "--port", "1"], {})).toThrow("Missing value for --fallback-host");
    expect(() => parseOptions(["--control-port", "65536"], {})).toThrow("Invalid --control-port value");
    expect(() => parseOptions(["--control-host", "--port", "1"], {})).toThrow("Missing value for --control-host");
  });

  test("explicitly supports macOS and Linux only", () => {
    expect(() => assertSupportedPlatform("darwin")).not.toThrow();
    expect(() => assertSupportedPlatform("linux")).not.toThrow();
    expect(() => assertSupportedPlatform("win32")).toThrow("does not support Windows");
  });
});
