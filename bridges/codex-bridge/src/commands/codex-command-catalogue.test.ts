import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandBindingRevision,
  normalizeCommandCataloguePayload,
  type NativeAgentBridgeCommandInvocation,
} from "@orkestrator/protocol/agent-command-catalogue";
import { resolveCommandInvocation } from "@orkestrator/protocol/agent-slash-commands";
import { CodexCommandCatalogue } from "./codex-command-catalogue.js";
import { normalizeSkillsList, skillCommandId } from "./skill-inventory.js";
import { clearTemplateMetadataCacheForTesting } from "../prompts/template-discovery.js";

const directories: string[] = [];
const previousCodexHome = process.env.CODEX_HOME;
let cwd = "";
let codexHome = "";

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

beforeEach(async () => {
  clearTemplateMetadataCacheForTesting();
  cwd = await mkdtemp(join(tmpdir(), "ork-catalogue-cwd-"));
  codexHome = await mkdtemp(join(tmpdir(), "ork-catalogue-home-"));
  directories.push(cwd, codexHome);
  process.env.CODEX_HOME = codexHome;
});

afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
});

const DEPLOY_PATH = "/private/workspace/.codex/skills/deploy/SKILL.md";

function skill(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "deploy",
    description: "Deploy the app",
    path: DEPLOY_PATH,
    scope: "repo",
    enabled: true,
    pluginId: null,
    ...overrides,
  };
}

function fakeEngine(initial: unknown = { data: [{ cwd: "/w", skills: [skill()], errors: [] }] }) {
  const state = {
    generation: 1,
    response: initial as unknown,
    fail: false,
    calls: [] as Array<{ cwd: string; forceReload?: boolean }>,
  };
  const engine = {
    info: () => ({ generation: state.generation }),
    listSkills: async (options: { cwd: string; forceReload?: boolean }) => {
      state.calls.push(options);
      if (state.fail) throw new Error("rpc failed /private/path");
      return { result: state.response, generation: state.generation };
    },
  };
  return { state, engine };
}

function catalogue(engine: ReturnType<typeof fakeEngine>["engine"], now = () => 1_000) {
  return new CodexCommandCatalogue({ engine, cwd, now, skillRefreshDebounceMs: 1 });
}

async function writePrompt(origin: "project" | "user", name: string, content: string) {
  const dir = origin === "project" ? join(cwd, ".codex", "prompts") : join(codexHome, "prompts");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.md`), content);
}

function select(
  row: { id?: string; name: string; executionKind?: string; bindingRevision?: string },
  args = "",
): NativeAgentBridgeCommandInvocation {
  return {
    id: row.id!,
    name: row.name,
    executionKind: row.executionKind as NativeAgentBridgeCommandInvocation["executionKind"],
    ...(row.bindingRevision ? { bindingRevision: row.bindingRevision } : {}),
    arguments: args,
  };
}

describe("skill normalization", () => {
  test("keeps repo scope, plugin ownership and enabled state; never trusts a missing flag", () => {
    const snapshot = normalizeSkillsList(
      {
        data: [
          {
            cwd: "/w",
            skills: [
              skill(),
              skill({ name: "lint", path: "/p/lint", scope: "user", pluginId: "acme@1" }),
              skill({ name: "sys", path: "/p/sys", scope: "system" }),
              skill({ name: "adm", path: "/p/adm", scope: "admin", enabled: undefined }),
              skill({ name: "has space", path: "/p/space" }),
              skill({ name: "relative", path: "relative/SKILL.md" }),
            ],
            errors: [],
          },
        ],
      },
      { generation: 1, cwd: "/w", now: 0 },
    );
    expect(
      snapshot.bindings.map((binding) => [binding.name, binding.origin, binding.enabled]),
    ).toEqual([
      ["deploy", "project", true],
      ["lint", "plugin", true],
      ["sys", "system", true],
      ["adm", "admin", false],
    ]);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.partial).toBe(false);
  });

  test("duplicate names are ambiguous rather than resolved by array position", () => {
    const snapshot = normalizeSkillsList(
      {
        data: [
          {
            cwd: "/w",
            skills: [skill(), skill({ path: "/other/deploy/SKILL.md", scope: "user" }), skill()],
            errors: [{ path: "/bad", message: "parse error" }],
          },
        ],
      },
      { generation: 1, cwd: "/w", now: 0 },
    );
    expect(snapshot.bindings).toHaveLength(2);
    expect(snapshot.bindings.every((binding) => binding.ambiguous)).toBe(true);
    expect(snapshot.partial).toBe(true);
  });
});

describe("enhanced catalogue", () => {
  test("lists built-ins, templates and skills with opaque ids and no private paths", async () => {
    await writePrompt("project", "review", "---\nargument-hint: <target>\n---\nReview $ARGUMENTS");
    const { engine } = fakeEngine({
      data: [
        {
          cwd: "/w",
          skills: [skill(), skill({ name: "old", path: "/p/old/SKILL.md", enabled: false })],
          errors: [],
        },
      ],
    });
    const response = await catalogue(engine).list();

    expect(response).toMatchObject({
      catalogueVersion: 1,
      status: "ready",
      revision: 1,
      generation: "1",
      freshness: "ttl",
      truncated: false,
    });
    const byName = new Map(response.commands.map((row) => [row.name, row]));
    expect([...byName.keys()]).toEqual(["/help", "/models", "/review", "$deploy", "$old"]);
    expect(byName.get("/help")).toMatchObject({
      id: "codex-builtin:/help",
      executionKind: "bridge-local",
      source: "builtin",
    });
    expect(byName.get("/review")).toMatchObject({
      executionKind: "bridge-template",
      source: "project",
      origin: "project",
      argumentHint: "<target>",
      bindingRevision: commandBindingRevision(["template", "project", "review.md"]),
    });
    expect(byName.get("$deploy")).toEqual({
      name: "$deploy",
      insertText: "$deploy",
      aliases: ["/skill:deploy"],
      id: `codex-skill:${commandBindingRevision([DEPLOY_PATH])}`,
      executionKind: "structured-skill",
      source: "skill",
      origin: "project",
      scope: "session",
      description: "Deploy the app",
      bindingRevision: commandBindingRevision(["skill", "deploy", DEPLOY_PATH]),
      inputPolicy: { arguments: "optional", attachments: "images", busy: "queue" },
    });
    expect(byName.get("$old")!.availability).toMatchObject({
      state: "unavailable",
      reason: "disabled",
    });
    // Neither steer nor compact: the backend merges its own session actions.
    expect(byName.has("/steer")).toBe(false);
    const wire = JSON.stringify(response);
    expect(wire).not.toContain("/private/");
    expect(wire).not.toContain(cwd);
    // The shared normalizer accepts every row as an enhanced descriptor.
    const normalized = normalizeCommandCataloguePayload(response);
    expect(normalized.enhanced).toBe(true);
    expect(normalized.rejected).toBe(0);
    expect(normalized.commands).toHaveLength(5);
  });

  test("the revision advances only when the list changes", async () => {
    const { state, engine } = fakeEngine();
    let clock = 0;
    const commands = new CodexCommandCatalogue({ engine, cwd, now: () => clock, skillTtlMs: 10 });
    expect((await commands.list()).revision).toBe(1);
    clock += 100;
    expect((await commands.list()).revision).toBe(1);
    state.response = { data: [{ cwd: "/w", skills: [], errors: [] }] };
    clock += 100;
    expect((await commands.list()).revision).toBe(2);
  });

  test("discovery errors keep the list partial instead of claiming completeness", async () => {
    const partial = fakeEngine({
      data: [{ cwd: "/w", skills: [skill()], errors: [{ path: "/x", message: "bad" }] }],
    });
    expect((await catalogue(partial.engine).list()).status).toBe("stale");

    const failing = fakeEngine();
    failing.state.fail = true;
    const response = await catalogue(failing.engine).list();
    expect(response.status).toBe("stale");
    expect(response.commands.map((row) => row.name)).toEqual(["/help", "/models"]);
    expect(JSON.stringify(response)).not.toContain("/private/path");
  });

  test("explicit refresh force-reloads skills and reports the outcome honestly", async () => {
    const { state, engine } = fakeEngine();
    const commands = catalogue(engine);
    expect(await commands.refresh()).toEqual({ outcome: "reloaded" });
    expect(state.calls.at(-1)).toEqual({ cwd, forceReload: true });
    // The reloaded snapshot serves the next read without another request.
    await commands.list();
    expect(state.calls).toHaveLength(1);
    // Ordinary reads never force a disk rescan.
    const plain = fakeEngine();
    await catalogue(plain.engine).list();
    expect(plain.state.calls).toEqual([{ cwd }]);
    state.fail = true;
    expect(await commands.refresh()).toMatchObject({ outcome: "failed" });
  });
});

describe("reserved names agree across picker, help, typed and selected dispatch", () => {
  test("a /help template is listed unavailable and never runs; the built-in always does", async () => {
    await writePrompt("project", "help", "Project help");
    await writePrompt("user", "compact", "User compact");
    const { engine } = fakeEngine();
    const commands = catalogue(engine);
    const listed = await commands.list();

    const reservedHelp = listed.commands.find((row) => row.name === "/prompts:help")!;
    expect(reservedHelp.availability).toMatchObject({
      state: "unavailable",
      reason: "reserved-name",
    });
    expect(listed.commands.filter((row) => row.name === "/help")).toHaveLength(1);
    // No listed /compact row, so the backend's compact action is not deferred away.
    expect(listed.commands.some((row) => row.name === "/compact")).toBe(false);

    // The backend's shared resolver sees exactly one /help and no ambiguity.
    const typedHelp = resolveCommandInvocation({
      text: "/help",
      intent: { kind: "typed" },
      commands: listed.commands,
    });
    expect(typedHelp).toMatchObject({ kind: "command", command: { id: "codex-builtin:/help" } });
    expect(
      resolveCommandInvocation({
        text: "/prompts:help",
        intent: { kind: "typed" },
        commands: listed.commands,
      }).kind,
    ).toBe("unavailable");

    expect(await commands.resolveTyped("/help")).toEqual({ kind: "builtin", builtin: "help" });
    expect(await commands.resolveTyped("/HELP extra")).toEqual({
      kind: "builtin",
      builtin: "help",
    });
    expect(await commands.resolveTyped("/prompts:help")).toMatchObject({ kind: "refused" });
    expect(await commands.resolveTyped("/compact")).toEqual({ kind: "text" });
    expect(await commands.resolveSelected(select(reservedHelp))).toMatchObject({ kind: "refused" });

    const help = await commands.helpText();
    expect(help).toContain("/prompts:help (unavailable:");
    expect(help).toContain("$deploy");
    expect(help).toContain("/help");
  });

  test("a shadowed user template is private and a stale selection of it is refused", async () => {
    await writePrompt("user", "shared", "User shared");
    const { engine } = fakeEngine();
    const commands = catalogue(engine);
    const userRow = (await commands.list()).commands.find((row) => row.name === "/shared")!;
    expect(userRow.source).toBe("user");

    await writePrompt("project", "shared", "Project shared");
    const listed = await commands.list();
    expect(
      listed.commands.filter((row) => row.name === "/shared").map((row) => row.source),
    ).toEqual(["project"]);
    const refused = await commands.resolveSelected(select(userRow));
    expect(refused).toMatchObject({ kind: "refused" });
    expect((refused as { message: string }).message).toContain("takes precedence");
  });
});

describe("selected command validation", () => {
  test("a selected skill resolves to its private binding", async () => {
    const { engine } = fakeEngine();
    const commands = catalogue(engine);
    const row = (await commands.list()).commands.find((entry) => entry.name === "$deploy")!;
    const plan = await commands.resolveSelected(select(row, "to staging\nnow"));
    expect(plan).toMatchObject({
      kind: "skill",
      args: "to staging\nnow",
      binding: { name: "deploy", path: DEPLOY_PATH },
    });
    // The compatibility alias is the same binding.
    expect(await commands.resolveSelected({ ...select(row), name: "/skill:deploy" })).toMatchObject(
      {
        kind: "skill",
      },
    );
  });

  test("forged, mismatched and stale selections are refused", async () => {
    const { state, engine } = fakeEngine();
    const commands = catalogue(engine);
    const row = (await commands.list()).commands.find((entry) => entry.name === "$deploy")!;
    for (const forged of [
      { ...select(row), id: skillCommandId("/etc/passwd") },
      { ...select(row), id: "codex-skill:not-a-real-id" },
      { ...select(row), id: "claude:/review" },
      { ...select(row), executionKind: "bridge-template" as const },
      { ...select(row), name: "$other" },
      { ...select(row), bindingRevision: "0000000000000000" },
    ]) {
      expect(await commands.resolveSelected(forged)).toMatchObject({ kind: "refused" });
    }

    // Disabled after listing.
    state.response = { data: [{ cwd: "/w", skills: [skill({ enabled: false })], errors: [] }] };
    commands.markSkillsChanged();
    expect(await commands.resolveSelected(select(row))).toMatchObject({ kind: "refused" });

    // A new generation withdraws the bindings; the replacement no longer has it.
    state.response = { data: [{ cwd: "/w", skills: [], errors: [] }] };
    state.generation = 2;
    commands.withdrawGeneration(2);
    expect(commands.skills.current()).toBeNull();
    expect(await commands.resolveSelected(select(row))).toMatchObject({ kind: "refused" });
  });

  test("a template edited after listing is refused once, then selectable again", async () => {
    await writePrompt("project", "fix", "Fix $ARGUMENTS");
    const { engine } = fakeEngine();
    const commands = catalogue(engine);
    const row = (await commands.list()).commands.find((entry) => entry.name === "/fix")!;
    await writePrompt("project", "fix", "Fix it differently: $ARGUMENTS");
    const refused = await commands.resolveSelected(select(row, "x"));
    expect(refused).toMatchObject({ kind: "refused" });
    expect((refused as { message: string }).message).toContain("changed after it was listed");
    const again = await commands.resolveSelected(select(row, "x"));
    expect(again).toMatchObject({ kind: "template" });
    expect(await commands.expandTemplate((again as { entry: never }).entry, "x")).toEqual({
      ok: true,
      text: "Fix it differently: x",
    });
  });

  test("shell templates are refused on every path without running anything", async () => {
    const marker = join(cwd, "marker");
    await writePrompt("project", "branch", `Touch: !\`touch ${marker}\``);
    const { engine } = fakeEngine();
    const commands = catalogue(engine);
    const row = (await commands.list()).commands.find((entry) => entry.name === "/branch")!;
    expect(row.availability).toMatchObject({ reason: "requires-shell-execution" });
    expect(await commands.resolveSelected(select(row))).toMatchObject({ kind: "refused" });
    expect(await commands.resolveTyped("/branch")).toMatchObject({ kind: "refused" });
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});

describe("typed resolution", () => {
  test("/skill:name resolves to the same binding; unknown names are explained, not sent", async () => {
    const { engine } = fakeEngine();
    const commands = catalogue(engine);
    expect(await commands.resolveTyped("/skill:deploy\tnow\nplease")).toMatchObject({
      kind: "skill",
      args: "now\nplease",
      binding: { path: DEPLOY_PATH },
    });
    expect(await commands.resolveTyped("/skill:missing")).toMatchObject({ kind: "refused" });
    expect(await commands.resolveTyped("$deploy now")).toEqual({ kind: "text" });
    expect(await commands.resolveTyped("/usr/bin/env is a path")).toEqual({ kind: "text" });
    expect(await commands.resolveTyped("plain text")).toEqual({ kind: "text" });
  });

  test("templates take multiline and tab-separated arguments", async () => {
    await writePrompt("project", "review", "Review: $ARGUMENTS");
    const { engine } = fakeEngine();
    const commands = catalogue(engine);
    const plan = await commands.resolveTyped('/Review\tsrc/a.ts\n\n  and "b"');
    expect(plan).toMatchObject({ kind: "template", args: 'src/a.ts\n\n  and "b"' });
    expect(
      await commands.expandTemplate(
        (plan as { entry: never }).entry,
        (plan as { args: string }).args,
      ),
    ).toEqual({ ok: true, text: 'Review: src/a.ts\n\n  and "b"' });
    expect(await commands.resolveTyped("/review\nline two")).toMatchObject({
      kind: "template",
      args: "line two",
    });
  });
});

describe("skills/changed invalidation", () => {
  test("a burst of invalidations is O(1) each and coalesces into one re-read", async () => {
    const { state, engine } = fakeEngine();
    const commands = catalogue(engine);
    await commands.list();
    expect(state.calls).toHaveLength(1);
    for (let index = 0; index < 1_000; index += 1) commands.markSkillsChanged();
    expect(commands.skills.stats.scheduledRefreshes).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.calls).toHaveLength(2);
    // The coalesced read made the snapshot fresh again.
    await commands.list();
    expect(state.calls).toHaveLength(2);
    commands.dispose();
  });

  test("a coalesced re-read that changes the inventory advances the revision by itself", async () => {
    const { state, engine } = fakeEngine();
    const commands = catalogue(engine);
    expect(commands.revision).toBe(0);
    await commands.list();
    expect(commands.revision).toBe(1);

    // Same inventory: an invalidation alone does not move the revision.
    commands.markSkillsChanged();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.calls).toHaveLength(2);
    expect(commands.revision).toBe(1);

    state.response = { data: [{ cwd: "/w", skills: [skill({ enabled: false })], errors: [] }] };
    commands.markSkillsChanged();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.calls).toHaveLength(3);
    expect(commands.revision).toBe(2);
    // The catalogue reports the same number.
    expect((await commands.list()).revision).toBe(2);

    // A template rescan from any path that changes the inventory counts too.
    await writePrompt("project", "new", "New prompt");
    expect(await commands.resolveTyped("/new")).toMatchObject({ kind: "template" });
    expect(commands.revision).toBe(3);
    commands.dispose();
  });

  test("a cold inventory is not read just because skills changed", async () => {
    const { state, engine } = fakeEngine();
    const commands = catalogue(engine);
    commands.markSkillsChanged();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.calls).toHaveLength(0);
  });
});
