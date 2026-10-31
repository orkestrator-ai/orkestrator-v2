import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { editableDefinition, loadCatalog, summarizeEntries } from "./catalog.js";
import {
  CONTAINER_CLAUDE_LOCAL_REASON,
  CONTAINER_HOMES,
  CONTAINER_PROJECT_EPHEMERAL_REASON,
  containerSources,
  opencodeManagedDir,
  providerCapabilities,
  providerSources,
  resolveProviderHomes,
  type ProviderHomes,
} from "./providers.js";
import { McpSourceStore } from "./source-store.js";
import type { ContainerFileReader } from "./types.js";

let root: string;
let homes: ProviderHomes;

function write(relative: string, content: string): string {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "mcp-providers-"));
  homes = {
    ...resolveProviderHomes({}, path.join(root, "home")),
    codexSystemDir: path.join(root, "etc", "codex"),
    grokSystemDir: path.join(root, "etc", "grok"),
    opencodeManagedDir: path.join(root, "etc", "opencode"),
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const backend = { kind: "backend" as const, location: "backend-host" as const };

test("OpenCode config directory matching XDG lists each file once", async () => {
  const configDir = path.join(homes.xdgConfigHome, "opencode");
  write("home/.config/opencode/opencode.json", '{"mcp":{}}');
  const specs = await providerSources("opencode", {
    context: backend,
    homes: {
      ...homes,
      opencodeConfigDir: configDir,
      opencodeCustomConfig: path.join(configDir, "opencode.json"),
    },
    exists: async (file: string) => existsSync(file),
  });
  expect(specs.filter((spec) => spec.path === path.join(configDir, "opencode.json"))).toHaveLength(
    1,
  );
});

function hostContext() {
  return { context: backend, homes, exists: async (file: string) => existsSync(file) };
}

async function catalogFor(provider: "codex" | "grok" | "opencode") {
  const specs = await providerSources(provider, hostContext());
  const store = new McpSourceStore({ keyFile: path.join(root, "data", "revision.key") });
  const catalog = await loadCatalog(store, specs);
  return { specs, catalog, ...summarizeEntries(catalog, providerCapabilities(provider)) };
}

const WRITABLE = { writable: true, persistentWorkspace: false, unavailableReason: "Unavailable." };
const READ_ONLY = {
  writable: false,
  persistentWorkspace: false,
  unavailableReason: "Unavailable.",
};

describe("read-only system and managed layers", () => {
  test("Codex shows /etc/codex config.toml below the user file and managed_config.toml above it", async () => {
    write(
      "etc/codex/config.toml",
      `[mcp_servers.sys]\ncommand = "s"\n[mcp_servers.both]\ncommand = "sys"\n`,
    );
    write("etc/codex/managed_config.toml", `[mcp_servers.pinned]\ncommand = "m"\n`);
    write("home/.codex/config.toml", `[mcp_servers.both]\ncommand = "user"\n`);
    const { specs, definitions, effective } = await catalogFor("codex");
    const system = specs.find((spec) => spec.sourceId === "codex:system")!;
    const managed = specs.find((spec) => spec.sourceId === "codex:managed")!;
    expect(system).toMatchObject({ scope: "managed", owner: "managed-policy", writable: false });
    expect(system.precedence).toBeLessThan(10);
    expect(managed.precedence).toBeGreaterThan(20);
    const both = definitions.find((row) => row.sourceId === "codex:system" && row.name === "both")!;
    expect(both.status).toBe("shadowed");
    expect(both.actions.edit.supported).toBe(false);
    expect(both.actions.remove.supported).toBe(false);
    expect(effective.sys).toBeDefined();
    expect(effective.pinned).toBeDefined();
  });

  test("Codex merges a name's layers field by field", async () => {
    write(
      "etc/codex/config.toml",
      [
        `[mcp_servers.partial]\ncommand = "sys"\n`,
        `[mcp_servers.inherits_off]\ncommand = "sys"\nenabled = false\n`,
        `[mcp_servers.back_on]\ncommand = "sys"\nenabled = false\n`,
      ].join("\n"),
    );
    write(
      "home/.codex/config.toml",
      [
        `[mcp_servers.partial]\nargs = ["x"]\n`,
        `[mcp_servers.inherits_off]\ncommand = "mine"\n`,
        `[mcp_servers.back_on]\nenabled = true\n`,
        `[mcp_servers.alone]\nargs = ["x"]\n`,
      ].join("\n"),
    );
    const { definitions, effective, catalog } = await catalogFor("codex");
    const winner = (name: string) => definitions.find((row) => row.entryId === effective[name])!;
    expect(winner("partial")).toMatchObject({ sourceId: "codex:user", status: "effective" });
    expect(winner("partial").statusReason).toContain("System configuration");
    expect(winner("inherits_off")).toMatchObject({ status: "disabled", enabled: false });
    expect(winner("inherits_off").statusReason).toContain("System configuration");
    expect(winner("back_on")).toMatchObject({ status: "effective", enabled: true });
    for (const name of ["partial", "inherits_off", "back_on"]) {
      expect(winner(name).actions.edit.supported).toBe(true);
      expect(winner(name).actions.setEnabled.supported).toBe(true);
      expect(winner(name).readOnlyReason).toBeUndefined();
      const editable = editableDefinition(
        catalog.entries.find((entry) => entry.entryId === winner(name).entryId)!,
        providerCapabilities("codex"),
      );
      expect(editable.transport).toBe("stdio");
      expect(editable.enabled).toBe(winner(name).enabled);
      expect(editable.readOnlyReason).toBeUndefined();
    }
    // With nothing to inherit from, a missing command is still invalid.
    expect(winner("alone").status).toBe("invalid");
  });

  test("Codex validates partial fields after merging inherited transport and tables", async () => {
    const cases = {
      args: "args = 42",
      env: "env = { BAD = 42 }",
      headers: "http_headers = { BAD = 42 }",
      inherited_bad: 'env = { GOOD = "ok" }',
      repaired: 'args = ["fixed"]',
    };
    write(
      "etc/codex/config.toml",
      Object.keys(cases)
        .map(
          (name) =>
            `[mcp_servers.${name}]\ncommand = "sys"\n` +
            (name === "inherited_bad" ? "env = { BAD = 42 }\n" : "") +
            (name === "repaired" ? "args = 42\n" : ""),
        )
        .join("\n"),
    );
    write(
      "home/.codex/config.toml",
      Object.entries(cases)
        .map(([name, fields]) => `[mcp_servers.${name}]\n${fields}\n`)
        .join("\n"),
    );
    const { definitions, effective } = await catalogFor("codex");
    for (const name of Object.keys(cases)) {
      const row = definitions.find((entry) => entry.entryId === effective[name])!;
      expect(row.status).toBe(name === "repaired" ? "effective" : "invalid");
      expect(row.actions.edit.supported).toBe(name === "repaired");
      expect(row.actions.setEnabled.supported).toBe(name === "repaired");
      if (name !== "repaired") expect(row.statusReason).toBe("Some values are not text.");
    }
  });

  test("Grok disable-only requirements express administrator policy", async () => {
    write("home/.grok/config.toml", '[mcp_servers.off]\ncommand = "user"\n');
    write("home/.grok/requirements.toml", "[mcp_servers.off]\nenabled = false\n");
    const { definitions, effective } = await catalogFor("grok");
    const row = definitions.find((entry) => entry.entryId === effective.off)!;
    expect(row).toMatchObject({
      sourceId: "grok:requirements-user",
      status: "disabled",
      enabled: false,
    });
    expect(row.statusReason).toContain("administrator policy");
    expect(row.readOnlyReason).toContain("organisation");
    expect(definitions.find((entry) => entry.sourceId === "grok:user")?.status).toBe("shadowed");
  });

  test("absent system files add no rows", async () => {
    const specs = await providerSources("codex", hostContext());
    expect(specs.map((spec) => spec.sourceId)).toEqual(["codex:user", "codex:injected"]);
  });

  test("Grok managed_config.toml files sit below the user's config.toml", async () => {
    write("etc/grok/managed_config.toml", `[mcp_servers.org]\ncommand = "o"\n`);
    write("home/.grok/managed_config.toml", `[mcp_servers.org]\ncommand = "o2"\n`);
    write("home/.grok/config.toml", `[mcp_servers.mine]\ncommand = "m"\n`);
    const { specs, effective, definitions } = await catalogFor("grok");
    const ids = specs.map((spec) => spec.sourceId);
    expect(ids.slice(0, 3)).toEqual(["grok:managed-system", "grok:managed-user", "grok:user"]);
    expect(effective.org).toBe(
      definitions.find((row) => row.sourceId === "grok:managed-user" && row.name === "org")!
        .entryId,
    );
  });

  test("Grok requirements.toml servers win over config.toml", async () => {
    write("home/.grok/requirements.toml", `[mcp_servers.pinned]\ncommand = "user-req"\n`);
    write("etc/grok/requirements.toml", `[mcp_servers.pinned]\ncommand = "system-req"\n`);
    write("home/.grok/config.toml", `[mcp_servers.pinned]\ncommand = "mine"\n`);
    const { specs, effective, definitions } = await catalogFor("grok");
    const requirements = specs.filter((spec) => spec.sourceId.startsWith("grok:requirements-"));
    expect(requirements.map((spec) => spec.sourceId)).toEqual([
      "grok:requirements-user",
      "grok:requirements-system",
    ]);
    for (const spec of requirements) {
      expect(spec).toMatchObject({ scope: "managed", writable: false });
      expect(spec.precedence).toBeGreaterThan(20);
    }
    const row = (sourceId: string) =>
      definitions.find((item) => item.sourceId === sourceId && item.name === "pinned")!;
    expect(effective.pinned).toBe(row("grok:requirements-system").entryId);
    expect(row("grok:requirements-user").status).toBe("shadowed");
    expect(row("grok:user").status).toBe("shadowed");
  });

  test("Grok's compat switch in requirements.toml wins over config.toml", async () => {
    write("home/.claude.json", JSON.stringify({ mcpServers: { a: { command: "x" } } }));
    write("home/.grok/config.toml", `[compat.claude]\nmcps = true\n`);
    write("etc/grok/requirements.toml", `[compat.claude]\nmcps = false\n`);
    const { definitions } = await catalogFor("grok");
    const row = definitions.find((item) => item.sourceId === "grok:compat-claude-user")!;
    expect(row.status).toBe("policy-excluded");
    expect(row.statusReason).toContain("requirements.toml");
  });

  test("OpenCode managed files in /etc/opencode win over everything else", async () => {
    write(
      "etc/opencode/opencode.json",
      JSON.stringify({ mcp: { s: { type: "local", command: ["m"] } } }),
    );
    write(
      "home/.config/opencode/opencode.json",
      JSON.stringify({ mcp: { s: { type: "local", command: ["u"] } } }),
    );
    const { effective, definitions } = await catalogFor("opencode");
    expect(effective.s).toBe(
      definitions.find((row) => row.sourceId === "opencode:managed-opencode.json")!.entryId,
    );
  });
});

describe("container sources", () => {
  function reader(files: Record<string, string>): ContainerFileReader {
    return async (_id, filePath, maxBytes) => {
      const text = files[filePath];
      if (text === undefined) return { state: "absent" };
      const bytes = new TextEncoder().encode(text);
      return bytes.byteLength > maxBytes ? { state: "oversized" } : { state: "ok", bytes };
    };
  }

  test("copied homes are environment-private overlay sources; other files stay read-only", async () => {
    for (const provider of ["claude", "codex", "cursor", "grok", "pi"] as const) {
      const user = (await containerSources(provider, "c1", WRITABLE)).find(
        (spec) => spec.sourceId === `${provider}:user`,
      )!;
      expect(user).toMatchObject({
        scope: "environment-private",
        owner: "environment-overlay",
        writable: true,
        label: "This environment (container home)",
        createMode: 0o600,
      });
      expect(user.readOnlyReason).toBeUndefined();
    }
    const claude = await containerSources("claude", "c1", WRITABLE);
    const local = claude.find((spec) => spec.scope === "claude-local")!;
    expect(local.writable).toBe(false);
    expect(local.readOnlyReason).toBe(CONTAINER_CLAUDE_LOCAL_REASON);
  });

  test("project files are writable only on a persistent workspace", async () => {
    const ephemeral = (await containerSources("codex", "c1", WRITABLE)).find(
      (spec) => spec.scope === "project",
    )!;
    expect(ephemeral.writable).toBe(false);
    expect(ephemeral.readOnlyReason).toBe(CONTAINER_PROJECT_EPHEMERAL_REASON);
    const persistent = (
      await containerSources("codex", "c1", { ...WRITABLE, persistentWorkspace: true })
    ).find((spec) => spec.scope === "project")!;
    expect(persistent.writable).toBe(true);
    expect(persistent.trust).toBe("allowed");
  });

  test("without a writer nothing in the container is writable", async () => {
    const specs = await containerSources("codex", "c1", {
      writable: false,
      persistentWorkspace: true,
      unavailableReason: "No writer.",
    });
    expect(specs.filter((spec) => spec.format !== "runtime").every((spec) => !spec.writable)).toBe(
      true,
    );
    expect(specs.find((spec) => spec.sourceId === "codex:user")!.readOnlyReason).toBe("No writer.");
  });

  test("OpenCode's alternate file names are found inside the container", async () => {
    const specs = await containerSources(
      "opencode",
      "c1",
      READ_ONLY,
      reader({
        "/home/node/.config/opencode/opencode.jsonc": "{}",
        "/workspace/opencode.jsonc": "{}",
        "/workspace/.opencode/opencode.json": "{}",
      }),
    );
    const ids = specs.map((spec) => spec.sourceId);
    expect(ids).toContain("opencode:user-opencode.jsonc");
    expect(ids).not.toContain("opencode:user-opencode.json");
    expect(ids).toContain("opencode:project-opencode.jsonc");
    expect(ids).toContain("opencode:project-dir-opencode.json");
    expect(specs.every((spec) => spec.format === "runtime" || spec.writable === false)).toBe(true);
  });

  test("persisted OpenCode source ids retain only fixed supported user filenames", async () => {
    const specs = await containerSources(
      "opencode",
      "c1",
      {
        ...WRITABLE,
        overlaySourceIds: [
          "opencode:user-config.json",
          "opencode:user-../../escape.json",
          "opencode:user-arbitrary.json",
          "opencode:project-config.json",
        ],
      },
      reader({ "/home/node/.config/opencode/opencode.jsonc": "{}" }),
    );
    const own = specs.filter((spec) => spec.scope === "environment-private");
    expect(own.map((spec) => spec.sourceId)).toEqual([
      "opencode:user-config.json",
      "opencode:user-opencode.jsonc",
    ]);
    expect(own.map((spec) => spec.path)).toEqual([
      "/home/node/.config/opencode/config.json",
      "/home/node/.config/opencode/opencode.jsonc",
    ]);
  });

  test("Grok's compat switches are read from the container's own config", async () => {
    const specs = await containerSources(
      "grok",
      "c1",
      READ_ONLY,
      reader({ "/home/node/.grok/config.toml": `[compat.cursor]\nmcps = false\n` }),
    );
    const cursor = specs.find((spec) => spec.sourceId === "grok:compat-cursor-user")!;
    const claude = specs.find((spec) => spec.sourceId === "grok:compat-claude-user")!;
    expect(cursor.excludedReason).toContain("[compat.cursor]");
    expect(claude.excludedReason).toBeUndefined();
  });

  test("without a reader only the default files are listed", async () => {
    const specs = await containerSources("opencode", "c1", READ_ONLY);
    expect(specs.map((spec) => spec.sourceId)).toEqual([
      "opencode:user-opencode.json",
      "opencode:project-opencode.json",
      "opencode:injected",
    ]);
  });
});

describe("OpenCode managed folder", () => {
  test("follows the platform the pinned OpenCode resolves it on", () => {
    expect(opencodeManagedDir("darwin")).toBe("/Library/Application Support/opencode");
    expect(opencodeManagedDir("linux")).toBe("/etc/opencode");
    expect(opencodeManagedDir("win32", { ProgramData: "D:\\Data" })).toBe(
      path.join("D:\\Data", "opencode"),
    );
    // A container is Linux whatever the backend runs on.
    expect(CONTAINER_HOMES.opencodeManagedDir).toBe("/etc/opencode");
  });
});

describe("resolveProviderHomes", () => {
  test("honours GROK_HOME, OPENCODE_CONFIG_DIR and the project-config switch", () => {
    const resolved = resolveProviderHomes(
      {
        GROK_HOME: "~/g",
        OPENCODE_CONFIG_DIR: "~/oc",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_CONFIG_CONTENT: "{}",
      },
      "/h",
    );
    expect(resolved.grokHome).toBe("/h/g");
    expect(resolved.opencodeConfigDir).toBe("/h/oc");
    expect(resolved.opencodeDisableProjectConfig).toBe(true);
    expect(resolved.opencodeConfigContent).toBe("{}");
    expect(
      resolveProviderHomes({ OPENCODE_DISABLE_PROJECT_CONFIG: "yes" }, "/h")
        .opencodeDisableProjectConfig,
    ).toBe(false);
  });
});
