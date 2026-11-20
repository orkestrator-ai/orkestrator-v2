/**
 * Claude plugins from the approved artifact, over real directories, with a
 * fake Claude CLI that behaves like the pinned 2.1.326 binary
 * (`fake-claude-cli.test-support.ts`). The live run against the real binary
 * is `provider-conformance.live.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { testCapabilityHomes } from "../native-ownership.js";
import { readPackageTree, treeDigest, validatePackageFiles } from "../security.js";
import {
  claudeCarriedComponents,
  claudeMarketplaceDirectory,
  ClaudePluginAdapter,
  ORKESTRATOR_CLAUDE_MARKETPLACE,
  parseClaudePluginList,
} from "./claude-plugins.js";
import { FakeClaudeCli } from "./fake-claude-cli.test-support.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-plugins-"));
  roots.push(root);
  const homes = testCapabilityHomes(path.join(root, "home"));
  const claude = new FakeClaudeCli(homes.claudeConfigDir);
  const adapter = new ClaudePluginAdapter({
    homes: () => homes,
    cli: claude.cli,
    now: () => "2026-11-19T00:00:00.000Z",
  });
  return { root, homes, claude, adapter };
}

function plugin(name: string, skillBody: string, version = "1.0.0") {
  return validatePackageFiles([
    {
      path: ".claude-plugin/plugin.json",
      content: Buffer.from(JSON.stringify({ name, version, description: "Test plugin" })),
    },
    {
      path: "skills/hello/SKILL.md",
      content: Buffer.from(`---\nname: hello\ndescription: Greets\n---\n${skillBody}\n`),
    },
    { path: "scripts/run.sh", content: Buffer.from("#!/bin/sh\necho hi\n"), executable: true },
  ]);
}

async function digestOf(directory: string): Promise<string> {
  return treeDigest(await readPackageTree(directory));
}

/** Installs `name` from a marketplace Orkestrator does not own. */
async function installExternal(
  root: string,
  claude: FakeClaudeCli,
  name: string,
  files = plugin(name, "external"),
) {
  const marketplace = path.join(root, "external-marketplace");
  await fs.mkdir(path.join(marketplace, ".claude-plugin"), { recursive: true });
  await fs.writeFile(
    path.join(marketplace, ".claude-plugin", "marketplace.json"),
    JSON.stringify({ name: "ext", owner: { name: "x" }, plugins: [{ name, source: `./${name}` }] }),
  );
  for (const file of files) {
    const target = path.join(marketplace, name, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, { mode: file.executable ? 0o755 : 0o644 });
  }
  await claude.cli(["plugin", "marketplace", "add", marketplace, "--scope", "user", "--json"]);
  await claude.cli(["plugin", "install", `${name}@ext`, "--scope", "user", "--json"]);
  return path.join(marketplace, name);
}

const ids = {
  packageId: "git:example.com/acme/demo",
  componentId: "pkg#native-plugin:claude:demo",
};

describe("Claude plugins from the approved artifact", () => {
  test("materializes the exact bytes in a digest directory, registers the marketplace and verifies the read-back", async () => {
    const { homes, claude, adapter } = await setup();
    const files = plugin("demo", "Say hello.");
    const digest = treeDigest(files);

    const result = await adapter.install({ ...ids, files });
    expect(result).toMatchObject({
      status: "installed-next-session",
      verification: "enabled",
      digest,
    });

    const marketplace = claudeMarketplaceDirectory(homes);
    const folder = path.join(marketplace, "plugins", "demo", digest.slice("sha256:".length));
    expect(await digestOf(folder)).toBe(digest);
    // The executable bit is part of the approved bytes.
    expect((await fs.stat(path.join(folder, "scripts", "run.sh"))).mode & 0o111).not.toBe(0);
    const listing = JSON.parse(
      await fs.readFile(path.join(marketplace, ".claude-plugin", "marketplace.json"), "utf8"),
    );
    expect(listing).toEqual({
      name: ORKESTRATOR_CLAUDE_MARKETPLACE,
      owner: { name: "Orkestrator" },
      plugins: [{ name: "demo", source: `./plugins/demo/${digest.slice("sha256:".length)}` }],
    });
    expect(claude.marketplaces.get(ORKESTRATOR_CLAUDE_MARKETPLACE)).toBe(marketplace);
    const installed = claude.installed.get("demo@orkestrator-managed")!;
    expect(await digestOf(installed.installPath)).toBe(digest);
    // Every write used the user scope explicitly.
    for (const call of claude.calls.filter((args) => args[1] === "install")) {
      expect(call).toContain("user");
    }

    const observed = await adapter.observe();
    expect(observed).toEqual([
      expect.objectContaining({
        qualifiedId: "demo@orkestrator-managed",
        packageId: ids.packageId,
        componentId: ids.componentId,
        expectedDigest: digest,
        digest,
        installed: true,
        drifted: false,
      }),
    ]);
  });

  test("a replayed install is answered from observation and writes nothing", async () => {
    const { claude, adapter } = await setup();
    const files = plugin("demo", "Say hello.");
    await adapter.install({ ...ids, files });
    const installs = claude.count("install");
    const replay = await adapter.install({ ...ids, files });
    expect(replay).toMatchObject({ status: "installed-next-session", replayed: true });
    expect(claude.count("install")).toBe(installs);
    expect(claude.count("uninstall")).toBe(0);
  });

  test("an update with an unchanged manifest version writes a new digest directory and refreshes Claude's copy", async () => {
    const { homes, claude, adapter } = await setup();
    const first = plugin("demo", "Say hello.");
    const second = plugin("demo", "Say goodbye.");
    await adapter.install({ ...ids, files: first });
    const result = await adapter.install({ ...ids, files: second });
    expect(result).toMatchObject({ status: "installed-next-session", digest: treeDigest(second) });
    // Claude's cached copy was replaced (uninstall keeping data, then install).
    const installed = claude.installed.get("demo@orkestrator-managed")!;
    expect(await digestOf(installed.installPath)).toBe(treeDigest(second));
    expect(claude.calls.find((args) => args[1] === "uninstall")).toContain("--keep-data");
    // The previous revision's directory is gone; only the approved one remains.
    const revisions = await fs.readdir(
      path.join(claudeMarketplaceDirectory(homes), "plugins", "demo"),
    );
    expect(revisions).toEqual([treeDigest(second).slice("sha256:".length)]);
  });

  test("an externally installed plugin of the same name is never touched; adoption needs identical bytes", async () => {
    const { root, claude, adapter } = await setup();
    const files = plugin("demo", "Say hello.");
    await installExternal(root, claude, "demo");

    const refused = await adapter.install({ ...ids, files });
    expect(refused.status).toBe("drifted");
    expect(refused.reason).toContain("demo@ext");
    // Choosing Adopt does not help when the bytes differ.
    expect((await adapter.install({ ...ids, files, force: true })).status).toBe("drifted");
    expect(claude.installed.has("demo@ext")).toBe(true);
    expect(claude.installed.has("demo@orkestrator-managed")).toBe(false);
    expect(claude.calls.some((args) => args.includes("demo@ext") && args[1] !== "install")).toBe(
      false,
    );
  });

  test("adopting an identical external plugin satisfies the package and removal leaves it installed", async () => {
    const { root, claude, adapter } = await setup();
    const files = plugin("demo", "Say hello.");
    await installExternal(root, claude, "demo", files);
    const adopted = await adapter.install({ ...ids, files, force: true });
    expect(adopted).toMatchObject({
      status: "installed-next-session",
      adopted: "demo@ext",
      digest: treeDigest(files),
    });
    expect(claude.installed.has("demo@orkestrator-managed")).toBe(false);
    const removed = await adapter.remove(ids);
    expect(removed.status).toBe("ready");
    expect(claude.installed.has("demo@ext")).toBe(true);
    expect(claude.count("uninstall")).toBe(0);
  });

  test("removal uninstalls only Orkestrator's copy and retires the empty marketplace", async () => {
    const { root, homes, claude, adapter } = await setup();
    await adapter.install({ ...ids, files: plugin("demo", "Say hello.") });
    // An unrelated external plugin from another marketplace.
    await installExternal(root, claude, "other");

    const removed = await adapter.remove(ids);
    expect(removed.status).toBe("ready");
    expect(claude.installed.has("demo@orkestrator-managed")).toBe(false);
    expect(claude.installed.has("other@ext")).toBe(true);
    expect(claude.calls.filter((args) => args[1] === "uninstall")).toEqual([
      [
        "plugin",
        "uninstall",
        "demo@orkestrator-managed",
        "--scope",
        "user",
        "--keep-data",
        "--json",
      ],
    ]);
    expect(claude.marketplaces.has(ORKESTRATOR_CLAUDE_MARKETPLACE)).toBe(false);
    expect(claude.marketplaces.has("ext")).toBe(true);
    expect(await fs.stat(claudeMarketplaceDirectory(homes)).catch(() => null)).toBeNull();
    // Removing again is a no-op.
    expect((await adapter.remove(ids)).status).toBe("ready");
  });

  test("an install whose answer is lost is settled by reading Claude's list back, never by running it again", async () => {
    const { claude, adapter } = await setup();
    const files = plugin("demo", "Say hello.");
    claude.fail("install", "timeout-after");
    const result = await adapter.install({ ...ids, files });
    expect(result).toMatchObject({ status: "installed-next-session", digest: treeDigest(files) });
    expect(claude.count("install")).toBe(1);
  });

  test("an install that did not happen fails after one attempt with Claude's answer", async () => {
    const { claude, adapter } = await setup();
    claude.fail("install", "timeout-before");
    const result = await adapter.install({ ...ids, files: plugin("demo", "Say hello.") });
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("does not list");
    expect(result.reason).toContain("timed out");
    expect(claude.count("install")).toBe(1);
    // The next pass observes and installs; the bytes are already materialized.
    const next = await adapter.install({ ...ids, files: plugin("demo", "Say hello.") });
    expect(next.status).toBe("installed-next-session");
  });

  test("a removal whose answer is lost is settled by observation", async () => {
    const { claude, adapter } = await setup();
    await adapter.install({ ...ids, files: plugin("demo", "Say hello.") });
    claude.fail("uninstall", "exit-after");
    expect((await adapter.remove(ids)).status).toBe("ready");
    expect(claude.count("uninstall")).toBe(1);
  });

  test("local edits to the managed copy are kept until the user chooses Replace", async () => {
    const { homes, claude, adapter } = await setup();
    const files = plugin("demo", "Say hello.");
    const digest = treeDigest(files);
    await adapter.install({ ...ids, files });
    const folder = path.join(
      claudeMarketplaceDirectory(homes),
      "plugins",
      "demo",
      digest.slice("sha256:".length),
    );
    await fs.writeFile(path.join(folder, "skills", "hello", "SKILL.md"), "edited locally\n");
    const [observed] = await adapter.observe();
    expect(observed).toMatchObject({ drifted: true, installed: true });
    expect(observed!.digest).not.toBe(digest);

    const kept = await adapter.install({ ...ids, files });
    expect(kept.status).toBe("drifted");
    expect((await adapter.remove(ids)).status).toBe("drifted");
    expect(claude.installed.has("demo@orkestrator-managed")).toBe(true);

    const replaced = await adapter.install({ ...ids, files, force: true });
    expect(replaced).toMatchObject({ status: "installed-next-session", digest });
    expect(await digestOf(folder)).toBe(digest);
  });

  test("a disabled managed plugin is drift; Replace switches it back on", async () => {
    const { claude, adapter } = await setup();
    const files = plugin("demo", "Say hello.");
    await adapter.install({ ...ids, files });
    await claude.cli(["plugin", "disable", "demo@orkestrator-managed", "--scope", "user"]);
    expect((await adapter.observe())[0]).toMatchObject({ drifted: true, enabled: false });
    expect((await adapter.install({ ...ids, files })).status).toBe("drifted");
    const replaced = await adapter.install({ ...ids, files, force: true });
    expect(replaced.status).toBe("installed-next-session");
    expect(claude.installed.get("demo@orkestrator-managed")?.enabled).toBe(true);
  });

  test("a marketplace of the same name that Orkestrator did not register is left untouched", async () => {
    const { root, claude, adapter } = await setup();
    const foreign = path.join(root, "foreign");
    await fs.mkdir(path.join(foreign, ".claude-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(foreign, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: ORKESTRATOR_CLAUDE_MARKETPLACE, owner: { name: "x" }, plugins: [] }),
    );
    await claude.cli(["plugin", "marketplace", "add", foreign, "--scope", "user", "--json"]);
    const result = await adapter.install({ ...ids, files: plugin("demo", "Say hello.") });
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("did not register");
    expect(claude.marketplaces.get(ORKESTRATOR_CLAUDE_MARKETPLACE)).toBe(foreign);
    expect(claude.count("install")).toBe(0);
  });

  test("two packages cannot claim the same plugin name", async () => {
    const { adapter } = await setup();
    await adapter.install({ ...ids, files: plugin("demo", "Say hello.") });
    const other = await adapter.install({
      packageId: "git:example.com/someone/else",
      componentId: "other#native-plugin:claude:demo",
      files: plugin("demo", "Different."),
    });
    expect(other.status).toBe("failed");
    expect(other.reason).toContain("another package");
  });

  test("an unsafe plugin name is refused before anything is written", async () => {
    const { homes, claude, adapter } = await setup();
    await expect(adapter.install({ ...ids, files: plugin("../escape", "x") })).rejects.toThrow(
      "cannot be used",
    );
    expect(claude.calls).toEqual([]);
    expect(await fs.stat(claudeMarketplaceDirectory(homes)).catch(() => null)).toBeNull();
  });
});

describe("helpers", () => {
  test("Claude's plugin list is parsed defensively", () => {
    expect(parseClaudePluginList("not json")).toBeNull();
    expect(
      parseClaudePluginList(
        JSON.stringify([
          { id: "a@m", enabled: true, installPath: "/x", readFromFolder: "/y" },
          { id: "no-marketplace" },
          null,
        ]),
      ),
    ).toEqual([
      {
        id: "a@m",
        name: "a",
        marketplace: "m",
        enabled: true,
        installPath: "/x",
        readFromFolder: "/y",
      },
    ]);
  });

  test("a delivered Claude plugin carries its parts for Claude only", () => {
    const components = [
      {
        id: "p#plugin",
        kind: "native-plugin" as const,
        pathOrKey: ".claude-plugin/plugin.json",
        providerHints: ["claude" as const],
        dependencies: [],
      },
      {
        id: "p#skill",
        kind: "skill" as const,
        pathOrKey: "skills/a",
        providerHints: [],
        dependencies: ["p#plugin"],
      },
      {
        id: "p#hook",
        kind: "hook" as const,
        pathOrKey: "hooks/hooks.json#X",
        providerHints: ["claude" as const],
        dependencies: ["p#plugin"],
      },
    ];
    const resolved = [
      { id: "p", artifactDigest: "sha256:x", components: components.map((c) => c.id) },
    ];
    const lookup = () => components as never;
    expect([...claudeCarriedComponents("claude", resolved, lookup, () => "git")].sort()).toEqual([
      "p#hook",
      "p#skill",
    ]);
    expect(claudeCarriedComponents("codex", resolved, lookup, () => "git").size).toBe(0);
    // A marketplace-sourced plugin has no reviewed bytes, so it carries nothing.
    expect(
      claudeCarriedComponents("claude", resolved, lookup, () => "provider-marketplace").size,
    ).toBe(0);
    // Without the plugin selected, its parts are delivered on their own.
    expect(
      claudeCarriedComponents(
        "claude",
        [{ ...resolved[0]!, components: ["p#skill"] }],
        lookup,
        () => "git",
      ).size,
    ).toBe(0);
  });
});
