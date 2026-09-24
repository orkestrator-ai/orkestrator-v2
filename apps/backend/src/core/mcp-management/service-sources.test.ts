import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { McpManagementSnapshot } from "@orkestrator/protocol/mcp-management";

import { crud } from "./provider-test-support.js";
import {
  createFixture,
  entry,
  mutation,
  revision,
  targetIdFor,
  type Fixture,
} from "./test-support.js";

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture({ env: {} });
});

afterEach(() => {
  fixture.cleanup();
});

function source(snapshot: McpManagementSnapshot, sourceId: string) {
  const found = snapshot.sources.find((candidate) => candidate.sourceId === sourceId);
  if (!found) throw new Error(`no source ${sourceId}`);
  return found;
}

const PROJECT_FILES: Array<[AgentPlatform, string, string, "json" | "toml", string[]]> = [
  ["claude", "claude:project", "worktree/.mcp.json", "json", ["mcpServers"]],
  ["codex", "codex:project", "worktree/.codex/config.toml", "toml", ["mcp_servers"]],
  ["opencode", "opencode:project-opencode.json", "worktree/opencode.json", "json", ["mcp"]],
  ["cursor", "cursor:project", "worktree/.cursor/mcp.json", "json", ["mcpServers"]],
  ["grok", "grok:project", "worktree/.grok/config.toml", "toml", ["mcp_servers"]],
  ["pi", "pi:project", "worktree/.pi/mcp.json", "json", ["mcpServers"]],
];

function readMap(relative: string, format: "json" | "toml", subtree: string[]) {
  const text = fixture.read(relative);
  let node: any = format === "toml" ? Bun.TOML.parse(text) : JSON.parse(text);
  for (const key of subtree) node = node?.[key];
  return node ?? {};
}

describe("project-scope CRUD", () => {
  for (const [provider, sourceId, file, format, subtree] of PROJECT_FILES) {
    test(`${provider}: add, update, rename and remove in the worktree's project file`, async () => {
      const { remove } = await crud(fixture, provider, sourceId, {
        kind: "environment",
        envValue: "${API_KEY}",
      });
      const map = readMap(file, format, subtree);
      expect(Object.keys(map)).toEqual(["fixture-b"]);
      expect(JSON.stringify(map["fixture-b"])).toContain("second");
      await remove();
      expect(readMap(file, format, subtree)["fixture-b"]).toBeUndefined();
    });
  }

  test("claude: the private local map is edited inside ~/.claude.json only", async () => {
    fixture.write("home/.claude.json", JSON.stringify({ numStartups: 3, projects: {} }));
    const { remove } = await crud(fixture, "claude", "claude:local", { kind: "environment" });
    const parsed = JSON.parse(fixture.read("home/.claude.json"));
    expect(Object.keys(parsed.projects[fixture.worktree].mcpServers)).toEqual(["fixture-b"]);
    expect(parsed.numStartups).toBe(3);
    await remove();
    expect(
      JSON.parse(fixture.read("home/.claude.json")).projects[fixture.worktree].mcpServers?.[
        "fixture-b"
      ],
    ).toBeUndefined();
  });
});

describe("each environment resolves its own worktree", () => {
  test("two environments see and edit only their own project files", async () => {
    const second = path.join(fixture.root, "worktree-two");
    mkdirSync(second, { recursive: true });
    fixture.extraEnvironments.push({
      ...fixture.environment,
      id: "env-2",
      name: "env-two",
      createdAt: "2026-09-02T00:00:00Z",
      worktreePath: second,
    });
    fixture.write("worktree/.mcp.json", JSON.stringify({ mcpServers: { one: { command: "1" } } }));
    fixture.write(
      "worktree-two/.mcp.json",
      JSON.stringify({ mcpServers: { two: { command: "2" } } }),
    );
    const first = await fixture.service.snapshot({
      targetId: await targetIdFor(fixture, "claude", "environment"),
    });
    const list = await fixture.service.listTargets({ environmentId: "env-2" });
    const otherId = list.targets.find(
      (target) => target.provider === "claude" && target.context.kind === "environment",
    )!.targetId;
    const other = await fixture.service.snapshot({ targetId: otherId });
    expect(
      first.definitions.filter((row) => row.sourceId === "claude:project").map((row) => row.name),
    ).toEqual(["one"]);
    expect(
      other.definitions.filter((row) => row.sourceId === "claude:project").map((row) => row.name),
    ).toEqual(["two"]);
    await fixture.service.mutate(
      mutation(otherId, {
        kind: "add",
        sourceId: "claude:project",
        expectedRevision: revision(other, "claude:project"),
        definition: { name: "added", transport: "stdio", command: "x" },
      }),
    );
    expect(Object.keys(JSON.parse(fixture.read("worktree-two/.mcp.json")).mcpServers)).toEqual([
      "two",
      "added",
    ]);
    expect(Object.keys(JSON.parse(fixture.read("worktree/.mcp.json")).mcpServers)).toEqual(["one"]);
    // A revision from one environment's file is refused against the other's.
    await expect(
      fixture.service.mutate(
        mutation(await targetIdFor(fixture, "claude", "environment"), {
          kind: "add",
          sourceId: "claude:project",
          expectedRevision: revision(other, "claude:project"),
          definition: { name: "stale", transport: "stdio", command: "x" },
        }),
      ),
    ).rejects.toThrow("revision-conflict");
  });
});

describe("Codex project trust comes from Codex's own settings", () => {
  const codexProject = async () => {
    const snapshot = await fixture.service.snapshot({
      targetId: await targetIdFor(fixture, "codex", "environment"),
    });
    return { snapshot, project: source(snapshot, "codex:project") };
  };

  test("no decision is unknown; trusted is allowed; untrusted is excluded", async () => {
    fixture.write("worktree/.codex/config.toml", `[mcp_servers.p]\ncommand = "x"\n`);
    let { project, snapshot } = await codexProject();
    expect(project.trust).toBe("unknown");
    expect(entry(snapshot, "codex:project", "p").status).toBe("effective");

    fixture.write(
      "home/.codex/config.toml",
      `[projects."${fixture.worktree}"]\ntrust_level = "trusted"\n`,
    );
    ({ project, snapshot } = await codexProject());
    expect(project.trust).toBe("allowed");

    fixture.write(
      "home/.codex/config.toml",
      `[projects."${fixture.worktree}"]\ntrust_level = "untrusted"\n`,
    );
    ({ project, snapshot } = await codexProject());
    expect(project.trust).toBe("excluded");
    expect(entry(snapshot, "codex:project", "p").status).toBe("policy-excluded");
    // Saving is not execution: the file stays editable.
    expect(project.writable).toBe(true);
  });

  test("a linked worktree falls back to its main checkout's decision", async () => {
    const main = path.join(fixture.root, "main");
    mkdirSync(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
    fixture.write("main/.git/worktrees/wt/commondir", "../..\n");
    fixture.write("worktree/.git", `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`);
    fixture.write("home/.codex/config.toml", `[projects."${main}"]\ntrust_level = "trusted"\n`);
    let { project } = await codexProject();
    expect(project.trust).toBe("allowed");
    expect(project.trustReason).toContain("main checkout");
    // The worktree's own entry wins over the main checkout's.
    fixture.write(
      "home/.codex/config.toml",
      `[projects."${main}"]\ntrust_level = "trusted"\n\n[projects."${fixture.worktree}"]\ntrust_level = "untrusted"\n`,
    );
    ({ project } = await codexProject());
    expect(project.trust).toBe("excluded");
  });

  test("trust keys are compared after resolving symlinks", async () => {
    const link = path.join(fixture.root, "link");
    symlinkSync(fixture.worktree, link);
    fixture.environment.worktreePath = link;
    fixture.write(
      "home/.codex/config.toml",
      `[projects."${fixture.worktree}"]\ntrust_level = "trusted"\n`,
    );
    const { project } = await codexProject();
    expect(project.trust).toBe("allowed");
  });
});

describe("OpenCode layers match the pinned binary's load order", () => {
  test(".opencode, ~/.opencode, OPENCODE_CONFIG_DIR and inline content stack above project files", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "mcp-oc-dir-"));
    fixture.cleanup();
    fixture = createFixture({
      env: {
        OPENCODE_CONFIG_DIR: configDir,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          mcp: {
            inline: {
              type: "remote",
              url: "https://inline.example/mcp",
              headers: { A: "SECRETVALUE" },
            },
          },
        }),
      },
    });
    const oc = (servers: Record<string, unknown>) => JSON.stringify({ mcp: servers });
    fixture.write(
      "home/.config/opencode/opencode.json",
      oc({ s: { type: "local", command: ["global"] } }),
    );
    fixture.write("worktree/opencode.json", oc({ s: { type: "local", command: ["project"] } }));
    fixture.write(
      "worktree/.opencode/opencode.jsonc",
      `{ // dir\n "mcp": { "s": { "type": "local", "command": ["project-dir"] } } }`,
    );
    fixture.write(
      "home/.opencode/opencode.json",
      oc({ t: { type: "local", command: ["home-dir"] } }),
    );
    writeFileSync(
      path.join(configDir, "opencode.json"),
      oc({ t: { type: "local", command: ["config-dir"] } }),
    );
    const snapshot = await fixture.service.snapshot({
      targetId: await targetIdFor(fixture, "opencode", "environment"),
    });
    const ids = snapshot.sources.map((row) => row.sourceId);
    expect(ids).toContain("opencode:project-dir-opencode.jsonc");
    expect(ids).toContain("opencode:home-dir-opencode.json");
    expect(ids).toContain("opencode:config-dir-opencode.json");
    // Project `.opencode` beats project files; OPENCODE_CONFIG_DIR beats ~/.opencode.
    expect(snapshot.effective.s).toBe(
      entry(snapshot, "opencode:project-dir-opencode.jsonc", "s").entryId,
    );
    expect(entry(snapshot, "opencode:project-opencode.json", "s").status).toBe("shadowed");
    expect(snapshot.effective.t).toBe(
      entry(snapshot, "opencode:config-dir-opencode.json", "t").entryId,
    );
    expect(entry(snapshot, "opencode:home-dir-opencode.json", "t").status).toBe("shadowed");
    const inline = source(snapshot, "opencode:inline");
    expect(inline.writable).toBe(false);
    expect(inline.displayPath).toBe("OPENCODE_CONFIG_CONTENT environment variable");
    expect(entry(snapshot, "opencode:inline", "inline").status).toBe("effective");
    expect(entry(snapshot, "opencode:inline", "inline").actions.edit.supported).toBe(false);
    expect(entry(snapshot, "opencode:inline", "inline").actions.remove.supported).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain("SECRETVALUE");
    // The project `.opencode` file is writable and stays inside the worktree.
    await fixture.service.mutate(
      mutation(snapshot.target.targetId, {
        kind: "add",
        sourceId: "opencode:project-dir-opencode.jsonc",
        expectedRevision: revision(snapshot, "opencode:project-dir-opencode.jsonc"),
        definition: { name: "added", transport: "stdio", command: "x" },
      }),
    );
    expect(fixture.read("worktree/.opencode/opencode.jsonc")).toContain("// dir");
    await expect(
      fixture.service.mutate(
        mutation(snapshot.target.targetId, {
          kind: "add",
          sourceId: "opencode:inline",
          expectedRevision: revision(snapshot, "opencode:inline"),
          definition: { name: "nope", transport: "stdio", command: "x" },
        }),
      ),
    ).rejects.toThrow("read-only-source");
    rmSync(configDir, { recursive: true, force: true });
  });

  test("OPENCODE_DISABLE_PROJECT_CONFIG excludes project files but keeps them editable", async () => {
    fixture.cleanup();
    fixture = createFixture({ env: { OPENCODE_DISABLE_PROJECT_CONFIG: "TRUE" } });
    fixture.write(
      "worktree/opencode.json",
      JSON.stringify({ mcp: { p: { type: "local", command: ["x"] } } }),
    );
    fixture.write(
      "worktree/.opencode/opencode.json",
      JSON.stringify({ mcp: { q: { type: "local", command: ["x"] } } }),
    );
    const snapshot = await fixture.service.snapshot({
      targetId: await targetIdFor(fixture, "opencode", "environment"),
    });
    expect(entry(snapshot, "opencode:project-opencode.json", "p").status).toBe("policy-excluded");
    expect(entry(snapshot, "opencode:project-dir-opencode.json", "q").status).toBe(
      "policy-excluded",
    );
    expect(source(snapshot, "opencode:project-opencode.json").trust).toBe("excluded");
    expect(entry(snapshot, "opencode:project-opencode.json", "p").actions.edit.supported).toBe(
      true,
    );
  });
});
