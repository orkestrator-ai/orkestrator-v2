import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  parseArguments,
  stackBackendArguments,
  stackEnvironment,
  stackLayout,
  UsageError,
} from "../../scripts/older-release-stack";

// Pure parts of the older-release launcher (to-do 7120 (retired) task 5). The
// launcher itself archives a tag, installs it and starts a backend; that is
// exercised by hand (docs/todo/transcripts-and-observation/0048, "Multi-client,
// restarts and an older backend"), never here.

describe("parseArguments", () => {
  test("an older backend needs a tag and exactly one renderer source", () => {
    const options = parseArguments([
      "backend",
      "--tag",
      "v2.21.0",
      "--renderer-url",
      "http://127.0.0.1:5173",
    ]);
    expect(options).toMatchObject({
      mode: "backend",
      tag: "v2.21.0",
      rendererUrl: "http://127.0.0.1:5173",
      json: false,
    });
    expect(options.root.endsWith(path.join("output", "older-release", "v2.21.0"))).toBe(true);
    expect(
      parseArguments(["backend", "--tag", "v2.21.0", "--renderer-profile", "qa", "--json"]),
    ).toMatchObject({ rendererProfile: "qa", json: true });
    expect(() => parseArguments(["backend", "--tag", "v2.21.0"])).toThrow(UsageError);
    expect(() =>
      parseArguments([
        "backend",
        "--tag",
        "v2.21.0",
        "--renderer-url",
        "http://127.0.0.1:1",
        "--renderer-profile",
        "qa",
      ]),
    ).toThrow("exactly one");
  });

  test("an older renderer takes no renderer source", () => {
    expect(parseArguments(["renderer", "--tag", "v2.36.1"])).toMatchObject({
      mode: "renderer",
      tag: "v2.36.1",
    });
    expect(() =>
      parseArguments(["renderer", "--tag", "v2.36.1", "--renderer-url", "http://127.0.0.1:1"]),
    ).toThrow("takes no renderer option");
  });

  test("refuses what is not a release tag, a loopback renderer or a free port", () => {
    expect(() => parseArguments(["backend"])).toThrow("--tag");
    expect(() => parseArguments(["renderer", "--tag", "main"])).toThrow("release tag");
    expect(() => parseArguments(["renderer", "--tag", "v2.21.0;rm"])).toThrow("release tag");
    expect(parseArguments(["prepare", "--tag", "v2.36.4-beta"]).tag).toBe("v2.36.4-beta");
    expect(() =>
      parseArguments(["backend", "--tag", "v2.21.0", "--renderer-url", "https://example.com"]),
    ).toThrow("127.0.0.1");
    for (const port of ["34121", "34122", "45507"]) {
      expect(() => parseArguments(["renderer", "--tag", "v2.36.1", "--port", port])).toThrow(
        "production",
      );
    }
    expect(() => parseArguments(["start", "--tag", "v2.21.0"])).toThrow(UsageError);
    expect(() => parseArguments(["renderer", "--tag", "v2.36.1", "--bogus", "1"])).toThrow(
      "Unknown option",
    );
    expect(() => parseArguments(["renderer", "--tag"])).toThrow("needs a value");
  });
});

describe("stackEnvironment", () => {
  const layout = stackLayout("/stack/v2.21.0", "backend");
  const env = stackEnvironment(
    {
      PATH: "/host/bin",
      HOME: "/home/user",
      LANG: "C.UTF-8",
      ORKESTRATOR_AGENT_MCP_TOKEN: "host-session-secret",
      ORKESTRATOR_DATA_DIR: "/home/user/.config/orkestrator-v2",
      ANTHROPIC_API_KEY: "sk-test",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      NODE_ENV: "production",
    },
    layout,
    ["/opt/bun/bin"],
  );

  test("keeps the backend off the host's data, credentials and Docker", () => {
    expect(env.HOME).toBe(layout.home);
    expect(env.TMPDIR).toBe(layout.tmp);
    expect(env.LANG).toBe("C.UTF-8");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.DOCKER_HOST).toBe(`unix://${layout.absentDockerSocket}`);
    expect(env.PATH?.split(":")[0]).toBe("/opt/bun/bin");
    expect(env.PATH).not.toContain("/host/bin");
    expect(
      Object.keys(env)
        .filter((key) => key.startsWith("ORKESTRATOR_"))
        .sort(),
    ).toEqual(["ORKESTRATOR_CONTROL_MCP_PORT", "ORKESTRATOR_HOST_REACHABILITY_CHECK"]);
    // Releases before 2026-11 bind the production Control MCP port without it.
    expect(env.ORKESTRATOR_CONTROL_MCP_PORT).toBe("0");
    expect(env.ORKESTRATOR_HOST_REACHABILITY_CHECK).toBe("off");
  });

  test("leaves the gateway token to the owner-only file the launcher writes", () => {
    expect(env.ORKESTRATOR_GATEWAY_TOKEN).toBeUndefined();
    expect(layout.authFile).toBe(path.join(layout.data, "gateway-auth.json"));
  });
});

describe("stackBackendArguments", () => {
  const layout = stackLayout("/stack/v2.36.1", "renderer");

  test("binds loopback on the chosen ports as an agent-test runtime", () => {
    const args = stackBackendArguments({
      layout,
      port: 40001,
      controlPort: 40002,
      rendererRoot: "/stack/v2.36.1/source/apps/web/dist",
    });
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(value("--data-dir")).toBe(layout.data);
    expect(value("--host")).toBe("127.0.0.1");
    expect(value("--port")).toBe("40001");
    expect(value("--control-host")).toBe("127.0.0.1");
    expect(value("--control-port")).toBe("40002");
    expect(value("--runtime-flavor")).toBe("agent-test");
    expect(value("--worktree-dir")).toBe(layout.worktrees);
    expect(value("--renderer-root")).toBe("/stack/v2.36.1/source/apps/web/dist");
    expect(args).toContain("--strict-gateway-port");
    expect(args).not.toContain("--renderer-dev-server-url");
    expect(args).not.toContain("--toolchain-bin-dir");
  });

  test("an older backend serves the given renderer URL and toolchain", () => {
    const args = stackBackendArguments({
      layout,
      port: 40001,
      controlPort: 40002,
      rendererUrl: "http://127.0.0.1:5173",
      toolchainBinDir: "/profile/toolchains/bin/current",
    });
    expect(args[args.indexOf("--renderer-dev-server-url") + 1]).toBe("http://127.0.0.1:5173");
    expect(args[args.indexOf("--toolchain-bin-dir") + 1]).toBe("/profile/toolchains/bin/current");
    expect(args).not.toContain("--renderer-root");
  });

  test("refuses a production port even when one is passed in", () => {
    expect(() => stackBackendArguments({ layout, port: 34121, controlPort: 40002 })).toThrow(
      "34121",
    );
    expect(() => stackBackendArguments({ layout, port: 40001, controlPort: 34122 })).toThrow(
      "34122",
    );
  });
});
