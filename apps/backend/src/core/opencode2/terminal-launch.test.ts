import { afterEach, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OPENCODE2_FLAGS, openCode2HostPaths } from "./server.js";
import {
  buildOpenCode2TerminalCommand,
  resolveOpenCode2TerminalCommand,
  type OpenCode2TerminalContext,
} from "./terminal-launch.js";

// Shell tests run the generated line and its inline-config helper for real.
setDefaultTimeout(30_000);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  // A space, as in macOS's "Application Support", must survive the shell.
  const root = await mkdtemp(path.join(tmpdir(), "ork oc2 terminal-"));
  roots.push(root);
  return root;
}

describe("buildOpenCode2TerminalCommand", () => {
  test.each([undefined, "default", "custom/model'with\"$HOME`literal`"])(
    "preserves the shell's inline JSONC and ignores project Bun configuration: %s",
    async (model) => {
      const root = await tempRoot();
      const cliPath = path.join(root, "fake-opencode2");
      const report = path.join(root, "inline.json");
      const marker = path.join(root, "preloaded");
      await Bun.write(
        cliPath,
        `#!/bin/sh\nprintf '%s' "$OPENCODE_CONFIG_CONTENT" > ${JSON.stringify(report)}\n`,
      );
      await chmod(cliPath, 0o755);
      await Bun.write(path.join(root, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
      await Bun.write(
        path.join(root, "preload.ts"),
        `await Bun.write(${JSON.stringify(marker)}, "unexpected");`,
      );
      await Bun.write(path.join(root, ".env"), "OPENCODE_CONFIG_CONTENT=invalid\n");
      const config = {
        model: "old/model",
        provider: { custom: { options: { baseURL: "http://127.0.0.1:1234" } } },
        permission: { bash: "deny" },
        instructions: ["Keep Bob's $HOME and `text` literal"],
      };
      const inherited = `// shell-only settings\n${JSON.stringify(config)}`;
      const command = buildOpenCode2TerminalCommand({
        cliPath,
        bunPath: process.execPath,
        dataDir: root,
        configDir: root,
        mirroredUserConfig: false,
        model,
      });
      const result = spawnSync(
        "/bin/sh",
        ["-c", `${command}; printf '%s' "$OPENCODE_CONFIG_CONTENT"`],
        {
          cwd: root,
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin", OPENCODE_CONFIG_CONTENT: inherited },
        },
      );
      expect(result.status).toBe(0);
      expect(Bun.JSONC.parse(await Bun.file(report).text())).toEqual(
        model && model !== "default" ? { ...config, model } : config,
      );
      expect(result.stdout).toBe(inherited);
      expect(await Bun.file(marker).exists()).toBe(false);
    },
  );

  test.each(["broken-json", "null", "[]", '"scalar"'])(
    "refuses malformed inline configuration without launching or echoing it: %s",
    async (inline) => {
      const root = await tempRoot();
      const marker = path.join(root, "launched");
      const cliPath = path.join(root, "fake-opencode2");
      await Bun.write(cliPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
      await chmod(cliPath, 0o755);
      const command = buildOpenCode2TerminalCommand({
        cliPath,
        bunPath: process.execPath,
        dataDir: root,
        configDir: root,
        mirroredUserConfig: false,
        model: "provider/model",
      });
      const result = spawnSync("/bin/sh", ["-c", command], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", OPENCODE_CONFIG_CONTENT: inline },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toBe("OpenCode inline configuration must be a JSONC object.\n");
      expect(await Bun.file(marker).exists()).toBe(false);
    },
  );

  test("runs the managed binary standalone on the host 2.x storage, with the model as config", async () => {
    const root = await tempRoot();
    const cliPath = path.join(root, "bin dir", "opencode2");
    const report = path.join(root, "report.txt");
    await Bun.write(
      cliPath,
      `#!/bin/sh\n{ printf 'arg=%s\\n' "$@"; env | grep '^OPENCODE_' | sort; } > ${JSON.stringify(report)}\n`,
    );
    await chmod(cliPath, 0o755);
    const dataDir = path.join(root, "data");
    const configDir = path.join(root, "config dir");
    const prompt = `Review Bob's "change"; $(touch ${root}/pwned) \`id\` \\ done`;
    const command = buildOpenCode2TerminalCommand({
      cliPath,
      bunPath: process.execPath,
      dataDir,
      configDir,
      mirroredUserConfig: false,
      model: "opencode-go/claude-haiku-5-5",
      initialPrompt: prompt,
    });

    const result = spawnSync("/bin/sh", ["-c", command], {
      env: {
        PATH: "/usr/bin:/bin",
        OPENCODE_CONFIG: "/user/opencode.json",
        OPENCODE_PASSWORD: "inherited",
        OPENCODE_SERVER_PASSWORD: "inherited",
        OPENCODE_SERVER_USERNAME: "inherited",
      },
    });
    expect(result.status).toBe(0);
    const lines = (await Bun.file(report).text()).trimEnd().split("\n");
    expect(lines.filter((line) => line.startsWith("arg="))).toEqual([
      "arg=--standalone",
      "arg=--prompt",
      `arg=${prompt}`,
    ]);
    expect(lines.filter((line) => !line.startsWith("arg="))).toEqual([
      `OPENCODE_CONFIG_CONTENT=${JSON.stringify({ model: "opencode-go/claude-haiku-5-5" })}`,
      `OPENCODE_CONFIG_DIR=${configDir}`,
      `OPENCODE_DB=${openCode2HostPaths(dataDir).database}`,
      "OPENCODE_DISABLE_AUTOUPDATE=1",
      "OPENCODE_DISABLE_FILEWATCHER=1",
      `OPENCODE_FLAGS=${OPENCODE2_FLAGS}`,
    ]);
    expect(await Bun.file(path.join(root, "pwned")).exists()).toBe(false);
  });

  test("passes a user OPENCODE_CONFIG only as its mirror, and no model when none was chosen", () => {
    const command = buildOpenCode2TerminalCommand({
      cliPath: "/managed/opencode2",
      bunPath: process.execPath,
      dataDir: "/data",
      configDir: "/data/opencode2/config",
      mirroredUserConfig: true,
      model: "default",
    });
    expect(command).toContain(
      `OPENCODE_CONFIG=${JSON.stringify(openCode2HostPaths("/data").customConfig).replaceAll('"', "'")}`,
    );
    expect(command).not.toContain("OPENCODE_CONFIG_CONTENT");
    expect(command).not.toContain("--prompt");
    expect(command).toEndWith("'/managed/opencode2' --standalone");
  });
});

describe("resolveOpenCode2TerminalCommand", () => {
  function context(
    overrides: {
      setting?: unknown;
      environmentType?: string;
      cliPath?: string | undefined;
      fail?: boolean;
    } = {},
  ) {
    const writeConfig = mock(async (dataDir: string) => path.join(dataDir, "opencode2", "config"));
    const value: OpenCode2TerminalContext = {
      storage: {
        getDataDir: () => "/data",
        getEnvironment: async () => {
          if (overrides.fail) throw new Error("unreadable");
          return { environmentType: overrides.environmentType ?? "local" };
        },
        loadConfig: async () => ({
          global: { openCodeProtocol: "setting" in overrides ? overrides.setting : "v2" },
        }),
      },
      resolveBunPath: () => process.execPath,
      resolveCliPath: () =>
        "cliPath" in overrides ? overrides.cliPath : "/toolchains/bin/current/opencode2",
      writeConfig,
      env: {},
    };
    return { value, writeConfig };
  }

  test("launches 2.x in a local environment while the setting asks for it", async () => {
    const { value, writeConfig } = context();
    const command = await resolveOpenCode2TerminalCommand(value, "env-1", {
      model: "anthropic/claude-sonnet",
      initialPrompt: "Hi",
    });
    expect(command).toContain("'/toolchains/bin/current/opencode2' --standalone --prompt 'Hi'");
    expect(command).toContain('model: "anthropic/claude-sonnet"');
    expect(writeConfig).toHaveBeenCalledTimes(1);
  });

  test.each([
    { setting: "legacy" },
    { setting: undefined },
    { environmentType: "containerized" },
    { fail: true },
  ])("keeps the 1.x launch for %p", async (overrides) => {
    const { value, writeConfig } = context(overrides);
    expect(await resolveOpenCode2TerminalCommand(value, "env-1", {})).toBeUndefined();
    expect(writeConfig).not.toHaveBeenCalled();
  });

  test("says 2.x is missing rather than running 1.x when the toolchain has none", async () => {
    const { value, writeConfig } = context({ cliPath: undefined });
    const command = await resolveOpenCode2TerminalCommand(value, "env-1", { initialPrompt: "Hi" });
    expect(command).toStartWith("printf '%s\\n' 'OpenCode 2 is not installed yet.");
    expect(writeConfig).not.toHaveBeenCalled();
  });
});
