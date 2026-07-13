import { describe, expect, test } from "bun:test";
import path from "node:path";
import { defaultDataDir, parseOptions } from "./options.js";

describe("standalone backend options", () => {
  test("uses platform-specific default data directories", () => {
    expect(defaultDataDir("darwin", {}, "/home/test")).toBe(
      path.join("/home/test", "Library", "Application Support", "orkestrator-v2"),
    );
    expect(defaultDataDir("win32", { APPDATA: "C:\\AppData" }, "C:\\Users\\test")).toBe(
      path.join("C:\\AppData", "orkestrator-v2"),
    );
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
      unsafeAllowNonTailscaleBind: true,
    });
  });

  test("rejects malformed, out-of-range, and missing option values", () => {
    expect(() => parseOptions(["--port", "3oops"], {})).toThrow("Invalid --port value");
    expect(() => parseOptions(["--port", "65536"], {})).toThrow("Invalid --port value");
    expect(() => parseOptions(["--host", "--port", "1"], {})).toThrow("Missing value for --host");
    expect(() => parseOptions(["--fallback-host", "--port", "1"], {})).toThrow("Missing value for --fallback-host");
  });
});
