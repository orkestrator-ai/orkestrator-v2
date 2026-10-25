import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { mcpManagementErrorFromUnknown } from "@orkestrator/protocol/mcp-management";

import { createCommandRegistry } from "./commands.js";
import type { CommandContext } from "./commands-context.js";
import {
  CONTAINER_WRITER_SCRIPT,
  createStagedDefaultsWriter,
  createMcpRuntimeProbe,
} from "./commands-registry-mcp.js";
import { SENTINEL, createFixture, type Fixture } from "./mcp-management/test-support.js";

describe("MCP management commands", () => {
  let fixture: Fixture;
  let context: CommandContext;
  const commands = createCommandRegistry();
  const invoke = (name: string, args: Record<string, unknown> = {}) =>
    Promise.resolve(commands.get(name)!(args, context));

  beforeEach(() => {
    fixture = createFixture();
    context = {
      mcpManagement: fixture.service,
      emit: () => undefined,
    } as unknown as CommandContext;
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test("registers every management command", () => {
    for (const name of [
      "list_mcp_management_targets",
      "get_mcp_management_snapshot",
      "get_mcp_definition",
      "validate_mcp_mutation",
      "mutate_mcp_definition",
      "apply_mcp_configuration",
      "get_mcp_operation",
      "cancel_mcp_apply",
      "resolve_mcp_environment_overlay",
      "preview_mcp_environment_defaults",
      "refresh_mcp_environment_defaults",
    ]) {
      expect(commands.has(name)).toBe(true);
    }
  });

  test("routes a save through the command map and refuses path-shaped target ids", async () => {
    const list = (await invoke("list_mcp_management_targets")) as {
      targets: Array<{ provider: string; targetId: string }>;
    };
    const targetId = list.targets.find((target) => target.provider === "pi")!.targetId;
    const saved = (await invoke("mutate_mcp_definition", {
      mutation: {
        requestId: "cmd-1",
        targetId,
        applyIntent: "save",
        operation: {
          kind: "add",
          sourceId: "pi:user",
          expectedRevision: null,
          definition: { name: "via-command", transport: "http", url: "https://a.example/mcp" },
        },
      },
    })) as { operation: { phase: string } };
    expect(saved.operation.phase).toBe("saved");
    expect(JSON.parse(fixture.read("home/.pi/agent/mcp.json")).mcpServers["via-command"]).toEqual({
      url: "https://a.example/mcp",
    });

    const error = await invoke("get_mcp_management_snapshot", { targetId: "../../etc" }).catch(
      (failure: unknown) => failure,
    );
    expect(mcpManagementErrorFromUnknown(error)?.code).toBe("unknown-target");
  });
});

describe("MCP management command failures carry a correlation id", () => {
  let fixture: Fixture;
  let context: CommandContext;
  const commands = createCommandRegistry();
  const invoke = (name: string, args: Record<string, unknown> = {}) =>
    Promise.resolve(commands.get(name)!(args, context));
  let warnings: string[];
  let warn: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fixture = createFixture();
    context = {
      mcpManagement: fixture.service,
      emit: () => undefined,
    } as unknown as CommandContext;
    warnings = [];
    warn = spyOn(console, "warn").mockImplementation((...parts: unknown[]) => {
      warnings.push(parts.map(String).join(" "));
    });
  });

  afterEach(() => {
    warn.mockRestore();
    fixture.cleanup();
  });

  test("a structured failure gets a reference that matches exactly one log line", async () => {
    const error = await invoke("get_mcp_management_snapshot", {
      targetId: "../../etc/SENTINEL-path",
    }).catch((failure: unknown) => failure);
    const detail = mcpManagementErrorFromUnknown(error);
    expect(detail?.code).toBe("unknown-target");
    expect(detail?.correlationId).toMatch(/^mcpe-[A-Za-z0-9_-]+$/);
    // The reference is stripped back out of the user-facing message.
    expect(detail?.message).not.toContain("[ref:");
    const lines = warnings.filter((line) => line.includes(detail!.correlationId!));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("code=unknown-target");
    expect(lines[0]).not.toContain("SENTINEL-path");
  });

  test("an unexpected error becomes `internal` without leaking its text", async () => {
    context = {
      mcpManagement: {
        snapshot: async () => {
          throw new Error(`EACCES /home/user/.claude.json ${SENTINEL}`);
        },
      },
      emit: () => undefined,
    } as unknown as CommandContext;
    const error = await invoke("get_mcp_management_snapshot", { targetId: "x" }).catch(
      (failure: unknown) => failure,
    );
    const detail = mcpManagementErrorFromUnknown(error);
    expect(detail?.code).toBe("internal");
    expect(detail?.correlationId).toBeDefined();
    expect(String((error as Error).message)).not.toContain(SENTINEL);
    expect(warnings.join("\n")).not.toContain(SENTINEL);
    expect(warnings.join("\n")).not.toContain(".claude.json");
  });
});

describe("MCP management rollout commands", () => {
  let fixture: Fixture;
  let context: CommandContext;
  const commands = createCommandRegistry();
  const invoke = (name: string, args: Record<string, unknown> = {}) =>
    Promise.resolve(commands.get(name)!(args, context));

  beforeEach(() => {
    fixture = createFixture();
    context = {
      mcpManagement: fixture.service,
      emit: () => undefined,
      storage: {
        loadConfig: async () => ({ global: { mcpManagement: fixture.rollout.value } }),
        updateMcpManagementRollout: async (settings: unknown) => {
          fixture.rollout.value = settings;
        },
      },
    } as unknown as CommandContext;
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test("defaults to everything enabled and narrows per provider", async () => {
    expect(await invoke("get_mcp_management_rollout")).toMatchObject({ enabled: true });
    const next = (await invoke("set_mcp_management_rollout", {
      writeProviders: ["claude"],
    })) as { writeProviders: string[]; applyProviders: string[] };
    expect(next.writeProviders).toEqual(["claude"]);
    expect(next.applyProviders.length).toBeGreaterThan(1);
    const list = (await invoke("list_mcp_management_targets")) as {
      targets: Array<{
        provider: string;
        capabilities: { operations: { add: { supported: boolean; reason?: string } } };
      }>;
    };
    const pi = list.targets.find((target) => target.provider === "pi")!;
    expect(pi.capabilities.operations.add).toMatchObject({ supported: false });
    expect(pi.capabilities.operations.add.reason).toContain("not enabled");
    const claude = list.targets.find((target) => target.provider === "claude")!;
    expect(claude.capabilities.operations.add.supported).toBe(true);
  });

  test("rejects unknown providers", async () => {
    const error = await invoke("set_mcp_management_rollout", { applyProviders: ["nope"] }).catch(
      (failure: unknown) => failure,
    );
    expect(mcpManagementErrorFromUnknown(error)?.code).toBe("invalid-request");
  });
});

describe("Codex reload probe", () => {
  test("reloads at the environment level and never resolves a session", async () => {
    const calls: unknown[][] = [];
    const probe = createMcpRuntimeProbe({
      nativeAgents: {
        reloadMcpConfigurationIfRunning: async (...args: unknown[]) => {
          calls.push(args);
          return "reloaded";
        },
        performProjectionMcpAction: async () => {
          throw new Error("Native agent session was not found");
        },
      },
    } as unknown as CommandContext);
    await expect(probe.reloadCodex("env-1")).resolves.toBe("reloaded");
    expect(calls).toEqual([["env-1", "codex"]]);
  });

  test("with no native agent service nothing is running", async () => {
    const probe = createMcpRuntimeProbe({} as unknown as CommandContext);
    await expect(probe.reloadCodex("env-1")).resolves.toBe("not-running");
  });
});

describe("OpenCode reload probe", () => {
  function openCodeContext(outcome: string, names?: string[]) {
    const calls: unknown[][] = [];
    const forgotten: string[] = [];
    const statusReads: string[] = [];
    const context = {
      nativeAgents: {
        reloadMcpConfigurationIfRunning: async (...args: unknown[]) => {
          calls.push(args);
          return outcome;
        },
        openCodeMcpServerNamesIfRunning: async (...args: unknown[]) => {
          calls.push(["names", ...args]);
          return names;
        },
      },
      runtime: {
        localServers: {
          openCodeAgentTools: { forget: (key: string) => forgotten.push(key) },
          enqueueEnvironmentOperation: (environmentId: string) => {
            statusReads.push(environmentId);
            return Promise.resolve({ running: false, port: null, pid: null });
          },
        },
      },
    } as unknown as CommandContext;
    return { probe: createMcpRuntimeProbe(context), calls, forgotten, statusReads };
  }

  test("a rebuilt instance gets Orkestrator's entry back and reports its listing", async () => {
    const { probe, calls, forgotten, statusReads } = openCodeContext("reloaded", ["fixture"]);
    await expect(probe.reloadOpenCode!("env-1")).resolves.toEqual({
      outcome: "reloaded",
      names: ["fixture"],
    });
    expect(calls).toEqual([
      ["env-1", "opencode"],
      ["names", "env-1"],
    ]);
    // Disposal dropped the runtime-only entry; it is posted again at once.
    expect(forgotten).toEqual(["local:env-1"]);
    expect(statusReads).toEqual(["env-1"]);
  });

  test("anything but a reload touches nothing else", async () => {
    const { probe, calls, forgotten } = openCodeContext("busy");
    await expect(probe.reloadOpenCode!("env-1")).resolves.toEqual({ outcome: "busy" });
    expect(calls).toEqual([["env-1", "opencode"]]);
    expect(forgotten).toEqual([]);
    const none = createMcpRuntimeProbe({} as unknown as CommandContext);
    await expect(none.reloadOpenCode!("env-1")).resolves.toEqual({ outcome: "not-running" });
  });
});

describe("MCP configuration evidence probe", () => {
  test("reads through the observation-only service path and copies only the evidence fields", async () => {
    const calls: unknown[][] = [];
    const probe = createMcpRuntimeProbe({
      nativeAgents: {
        mcpConfigEvidenceIfRunning: async (...args: unknown[]) => {
          calls.push(args);
          return {
            state: "evidence",
            evidence: {
              sources: { user: "absent" },
              observedAt: "2026-09-24T10:00:00.000Z",
              scope: "session",
              staleServers: ["removed"],
              extra: "dropped",
            },
          };
        },
      },
    } as unknown as CommandContext);
    expect(await probe.mcpConfigEvidence("env-1", "claude", "env-env-1:tab-1")).toEqual({
      state: "evidence",
      evidence: {
        sources: { user: "absent" },
        observedAt: "2026-09-24T10:00:00.000Z",
        scope: "session",
        staleServers: ["removed"],
      },
    });
    expect(calls).toEqual([["env-1", "claude", "env-env-1:tab-1"]]);
  });

  test("with no native agent service nothing is running", async () => {
    const probe = createMcpRuntimeProbe({} as unknown as CommandContext);
    expect(await probe.mcpConfigEvidence("env-1", "pi", "k")).toEqual({ state: "not-running" });
  });

  test("reports a local bridge's recorded process id, and none for containers", async () => {
    const probe = createMcpRuntimeProbe({
      storage: {
        loadEnvironments: async () => [
          { id: "local", environmentType: "local", status: "running", grokBridgePid: 4242 },
          { id: "stopped", environmentType: "local", status: "stopped", grokBridgePid: null },
          { id: "box", environmentType: "containerized", status: "running", grokBridgePid: 7 },
        ],
      },
    } as unknown as CommandContext);
    const environments = await probe.environments();
    expect(environments.map((environment) => environment.bridgePid?.("grok"))).toEqual([
      4242,
      undefined,
      undefined,
    ]);
  });
});

describe("container MCP writer program without Docker", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-writer-"));
    fs.mkdirSync(path.join(root, "home/node"), { recursive: true });
    fs.mkdirSync(path.join(root, "workspace"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  // Run the exact production program with real file I/O, remapping its two
  // container roots into scratch space. Only stdin and process.exit are virtual.
  function run(file: string, expected: string, input: string, max = 1024, mode = "private") {
    const bytes = Buffer.from(input);
    let offset = 0;
    const remap = (value: string) => path.join(root, value);
    const handles = new Set<number>();
    const virtualFs = {
      ...fs,
      lstatSync: (file: string) => fs.lstatSync(remap(file)),
      mkdirSync: (file: string, options: fs.MakeDirectoryOptions) =>
        fs.mkdirSync(remap(file), options),
      openSync: (file: string, flags: number, mode?: number) => {
        const fd = fs.openSync(remap(file), flags, mode);
        handles.add(fd);
        return fd;
      },
      closeSync: (fd: number) => {
        handles.delete(fd);
        fs.closeSync(fd);
      },
      renameSync: (from: string, to: string) => fs.renameSync(remap(from), remap(to)),
      unlinkSync: (file: string) => fs.unlinkSync(remap(file)),
      readSync: (
        fd: number,
        buffer: Buffer,
        start: number,
        length: number,
        position: number | null,
      ) => {
        if (fd !== 0) return fs.readSync(fd, buffer, start, length, position);
        const read = bytes.copy(buffer, start, offset, offset + length);
        offset += read;
        return read;
      },
    };
    const exited = Symbol("exit");
    let code = 0;
    try {
      runInNewContext(CONTAINER_WRITER_SCRIPT, {
        require: (name: string) =>
          name === "fs" ? virtualFs : name === "path" ? path : { createHash },
        Buffer,
        process: {
          argv: ["node", file, expected, mode, String(max)],
          pid: process.pid,
          exit: (value: number) => {
            code = value;
            throw exited;
          },
        },
      });
    } catch (error) {
      if (error !== exited) throw error;
    } finally {
      for (const fd of handles) fs.closeSync(fd);
    }
    return code;
  }

  test("creates private parents and atomically replaces the intended file", () => {
    expect(run("/home/node/.codex/config.toml", "absent", "first")).toBe(0);
    const file = path.join(root, "home/node/.codex/config.toml");
    expect(fs.readFileSync(file, "utf8")).toBe("first");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    const digest = "sha256:" + createHash("sha256").update("first").digest("base64url");
    expect(run("/home/node/.codex/config.toml", digest, "second")).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe("second");
    expect(fs.readdirSync(path.dirname(file))).toEqual(["config.toml"]);
  });

  test("refuses paths outside the exact roots and traversal or noncanonical paths", () => {
    for (const file of [
      "/tmp/x",
      "/etc/passwd",
      "/home/nodes/x",
      "/workspace-other/x",
      "/home/node/../root/x",
      "/workspace//x",
      "relative",
    ]) {
      expect(run(file, "absent", "payload")).toBe(4);
    }
  });

  test("refuses symlink files, symlink parents and nonregular destinations", () => {
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "original"), "safe");
    fs.symlinkSync(path.join(outside, "original"), path.join(root, "home/node/link"));
    fs.symlinkSync(outside, path.join(root, "home/node/linked-parent"));
    fs.mkdirSync(path.join(root, "workspace/directory"));
    for (const file of [
      "/home/node/link",
      "/home/node/linked-parent/new",
      "/workspace/directory",
    ]) {
      expect(run(file, "absent", "payload")).toBe(4);
    }
    expect(fs.readdirSync(outside)).toEqual(["original"]);
    expect(fs.readFileSync(path.join(outside, "original"), "utf8")).toBe("safe");
  });

  test("a digest mismatch or oversized stdin leaves the existing bytes alone", () => {
    const file = path.join(root, "workspace/config.json");
    fs.writeFileSync(file, "safe");
    expect(run("/workspace/config.json", "sha256:wrong", "payload")).toBe(3);
    const digest = "sha256:" + createHash("sha256").update("safe").digest("base64url");
    expect(run("/workspace/config.json", digest, "oversized", 3)).toBe(5);
    expect(fs.readFileSync(file, "utf8")).toBe("safe");
    expect(fs.readdirSync(path.dirname(file))).toEqual(["config.json"]);
  });
});

test("Claude staging is refreshed on start so defaults refresh needs no staged writer", async () => {
  const writer = createStagedDefaultsWriter({
    storage: {
      getDataDir: () => {
        throw new Error("should not read staging");
      },
    },
  } as never);
  expect(
    await writer.update("env", "container", "claude:user", () => {
      throw new Error("should not rewrite");
    }),
  ).toBe("not-needed");
});
