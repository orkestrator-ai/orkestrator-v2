import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadCatalog, summarizeEntries } from "./catalog.js";
import {
  CONTAINER_OWN_FILE_REASON,
  containerSources,
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

function hostContext() {
  return { context: backend, homes, exists: async (file: string) => existsSync(file) };
}

async function catalogFor(provider: "codex" | "grok" | "opencode") {
  const specs = await providerSources(provider, hostContext());
  const store = new McpSourceStore({ keyFile: path.join(root, "data", "revision.key") });
  const catalog = await loadCatalog(store, specs);
  return { specs, ...summarizeEntries(catalog, providerCapabilities(provider)) };
}

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

  test("Cursor's container home file is labelled as the container's own, not a copy", async () => {
    const specs = await containerSources("cursor", "c1", "Container reason.");
    const user = specs.find((spec) => spec.sourceId === "cursor:user")!;
    expect(user.label).toBe("Container home (container's own file)");
    expect(user.readOnlyReason).toContain(CONTAINER_OWN_FILE_REASON);
    const codex = (await containerSources("codex", "c1", "Container reason.")).find(
      (spec) => spec.sourceId === "codex:user",
    )!;
    expect(codex.label).toBe("Container home (copied from backend user)");
    expect(codex.readOnlyReason).toBe("Container reason.");
  });

  test("OpenCode's alternate file names are found inside the container", async () => {
    const specs = await containerSources(
      "opencode",
      "c1",
      "Container reason.",
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

  test("Grok's compat switches are read from the container's own config", async () => {
    const specs = await containerSources(
      "grok",
      "c1",
      "Container reason.",
      reader({ "/home/node/.grok/config.toml": `[compat.cursor]\nmcps = false\n` }),
    );
    const cursor = specs.find((spec) => spec.sourceId === "grok:compat-cursor-user")!;
    const claude = specs.find((spec) => spec.sourceId === "grok:compat-claude-user")!;
    expect(cursor.excludedReason).toContain("[compat.cursor]");
    expect(claude.excludedReason).toBeUndefined();
  });

  test("without a reader only the default files are listed", async () => {
    const specs = await containerSources("opencode", "c1", "Container reason.");
    expect(specs.map((spec) => spec.sourceId)).toEqual([
      "opencode:user-opencode.json",
      "opencode:project-opencode.json",
      "opencode:injected",
    ]);
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
