/**
 * Live provider conformance for capability delivery
 * (docs/architecture/agent-capabilities-management.md, "Provider support";
 * docs/todo/cross-cutting/8314-agent-capabilities-follow-ups.md, task 1).
 *
 * Runs the REAL pinned provider binaries against temporary, isolated homes
 * and asks each provider's own credential-free listing whether it sees what
 * Orkestrator delivered:
 *
 * - Claude: `claude -p` prints its `init` event (skills, plugins) before it
 *   reports "Not logged in", so no credential is used; `claude plugin list
 *   --json` and `claude plugin validate` need none either.
 * - Codex: `codex debug prompt-input` renders the model-visible skill list
 *   offline; `codex plugin list --json` reads the local registry.
 * - OpenCode 2: `opencode debug agents --standalone` lists the agents the
 *   binary loads, from a private server (never the background service).
 *
 * Opt-in (`RUN_LIVE_CAPABILITY_CONFORMANCE=1`); slow tier (`*.live.test.ts`).
 * Binaries: `ORKESTRATOR_CONFORMANCE_<CLAUDE|CODEX|OPENCODE2>` or the mise
 * install of exactly the pinned version. A binary whose `--version` is not
 * the pinned one is not used. Every run gets a fresh HOME, CLAUDE_CONFIG_DIR,
 * CODEX_HOME and XDG directories and a minimal environment: nothing reads or
 * writes the user's own provider homes or Orkestrator's data directory.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { PINNED_TOOLCHAIN_VERSIONS } from "@orkestrator/toolchain/manifest";

import { StorageService } from "../storage.js";
import { CapabilityArtifactStore } from "./artifact-store.js";
import { CapabilityExecutor, type NodePlanTarget } from "./executor.js";
import { testCapabilityHomes, type CapabilityHomes } from "./native-ownership.js";
import {
  claudeMarketplaceDirectory,
  ClaudePluginAdapter,
  parseClaudePluginList,
} from "./provider-adapters/claude-plugins.js";
import {
  parseCodexInstalledPlugins,
  toggleCodexPlugin,
} from "./provider-adapters/codex-plugins.js";
import { providerCli } from "./provider-adapters/provider-cli.js";
import { treeDigest, validatePackageFiles } from "./security.js";
import { gradeGrokDiscovery, grokDiscoveredSkills, loadedPrivatePlugin } from "./runtime-proof.js";
import { sessionPluginsRoot, stageSessionPlugin } from "./session-delivery.js";

const LIVE = process.env.RUN_LIVE_CAPABILITY_CONFORMANCE === "1";
const TIMEOUT_MS = 180_000;

type Tool = "claude" | "codex" | "opencode2" | "grok";

const MISE_LAYOUT: Record<Tool, { tool: string; relative: string }> = {
  claude: { tool: "claude", relative: "claude" },
  grok: { tool: "grok", relative: "grok" },
  codex: { tool: "codex", relative: path.join("bin", "codex") },
  opencode2: { tool: "opencode", relative: path.join("node_modules", ".bin", "opencode2") },
};

function pinnedBinary(tool: Tool): string | undefined {
  const explicit = process.env[`ORKESTRATOR_CONFORMANCE_${tool.toUpperCase()}`];
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  const miseData = process.env.MISE_DATA_DIR ?? path.join(os.homedir(), ".local", "share", "mise");
  const layout = MISE_LAYOUT[tool];
  const candidate = path.join(
    miseData,
    "installs",
    layout.tool,
    PINNED_TOOLCHAIN_VERSIONS[tool],
    layout.relative,
  );
  return existsSync(candidate) ? candidate : undefined;
}

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

interface Sandbox {
  root: string;
  homes: CapabilityHomes;
  cwd: string;
  env: Record<string, string>;
}

/** A fresh home per test; the environment carries nothing from this process but PATH basics. */
async function sandbox(): Promise<Sandbox> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "capability-conformance-"));
  roots.push(root);
  const homes = testCapabilityHomes(path.join(root, "home"));
  const cwd = path.join(root, "project");
  await Promise.all([
    fs.mkdir(cwd, { recursive: true }),
    fs.mkdir(homes.claudeConfigDir, { recursive: true }),
    fs.mkdir(homes.codexHome, { recursive: true }),
  ]);
  return {
    root,
    homes,
    cwd,
    env: {
      HOME: homes.home,
      PATH: "/usr/local/bin:/usr/bin:/bin",
      CLAUDE_CONFIG_DIR: homes.claudeConfigDir,
      CODEX_HOME: homes.codexHome,
      XDG_CONFIG_HOME: homes.xdgConfigHome,
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      DISABLE_AUTOUPDATER: "1",
    },
  };
}

function cliFor(binary: string, box: Sandbox, label: string) {
  return providerCli({
    label,
    binary: () => binary,
    cwd: () => box.cwd,
    env: () => box.env,
    timeoutMs: 90_000,
  });
}

async function versionOf(binary: string, box: Sandbox): Promise<string> {
  const result = await cliFor(binary, box, "provider")(["--version"]);
  return result.stdout.trim().split(/\r?\n/).pop() ?? "";
}

/** The executor writing into the sandbox's homes, as the backend's own does. */
async function executorFor(box: Sandbox) {
  const storage = new StorageService(path.join(box.root, "orkestrator-data"));
  await storage.init();
  const artifacts = new CapabilityArtifactStore(path.join(box.root, "orkestrator-data"));
  const executor = new CapabilityExecutor({
    storage: { capabilities: storage.capabilities },
    artifacts,
    homes: () => box.homes,
  });
  return { storage, artifacts, executor };
}

async function deliverFile(
  box: Sandbox,
  kind: NodePlanTarget["kind"],
  locationId: string,
  name: string,
  files: Array<{ path: string; content: string }>,
  pathOrKey = "",
) {
  const { artifacts, executor, storage } = await executorFor(box);
  const validated = validatePackageFiles(
    files.map((file) => ({ path: file.path, content: Buffer.from(file.content) })),
  );
  const digest = await artifacts.put(validated);
  const target: NodePlanTarget = {
    key: `conformance|${locationId}|${name}`,
    action: "install",
    kind,
    packageId: `managed:${name}`,
    componentId: `managed:${name}#${kind}:${name}`,
    componentName: name,
    pathOrKey,
    locationId,
    artifactDigest: digest,
  };
  const [installed] = await executor.apply([target]);
  return {
    installed,
    remove: async () => {
      const [removed] = await executor.apply([{ ...target, action: "remove" }]);
      storage.close?.();
      return removed;
    },
  };
}

/** Claude's `init` event, which it prints before refusing to run without a login. */
async function claudeInit(
  binary: string,
  box: Sandbox,
  extraArgs: string[] = [],
): Promise<{
  skills: string[];
  plugins: string[];
  loaded: Array<{ name: string; path?: string }>;
  version: string;
}> {
  const result = await cliFor(
    binary,
    box,
    "Claude Code",
  )([
    "-p",
    "conformance",
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    "1",
    ...extraArgs,
  ]);
  for (const line of result.stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "system" && event.subtype === "init") {
        // No credential exists in the sandbox; the run must not have found one.
        expect(event.apiKeySource).toBe("none");
        return {
          skills: (event.skills as string[]) ?? [],
          plugins: ((event.plugins as Array<{ source: string }>) ?? []).map(
            (entry) => entry.source,
          ),
          // The rows the Claude bridge records as runtime evidence (`capability-evidence.ts`).
          loaded: ((event.plugins as Array<{ name: string; path?: string }>) ?? []).map(
            (entry) => ({ name: entry.name, ...(entry.path ? { path: entry.path } : {}) }),
          ),
          version: String(event.claude_code_version ?? ""),
        };
      }
    } catch {
      // not an event line
    }
  }
  throw new Error("Claude printed no init event.");
}

async function codexPromptInput(binary: string, box: Sandbox): Promise<string> {
  const result = await cliFor(binary, box, "Codex")(["debug", "prompt-input", "conformance"]);
  expect(result.exitCode).toBe(0);
  return result.stdout;
}

const SKILL = (name: string) => [
  {
    path: "SKILL.md",
    content: `---\nname: ${name}\ndescription: Orkestrator conformance skill ${name}\n---\nReply with ${name}.\n`,
  },
];

const claude = LIVE ? pinnedBinary("claude") : undefined;
const codex = LIVE ? pinnedBinary("codex") : undefined;
const opencode2 = LIVE ? pinnedBinary("opencode2") : undefined;
const grok = LIVE ? pinnedBinary("grok") : undefined;

describe.skipIf(!claude)(`Claude Code ${PINNED_TOOLCHAIN_VERSIONS.claude}`, () => {
  test(
    "the pinned binary is the one under test",
    async () => {
      const box = await sandbox();
      expect(await versionOf(claude!, box)).toContain(PINNED_TOOLCHAIN_VERSIONS.claude);
    },
    TIMEOUT_MS,
  );

  test(
    "a skill the executor writes to ~/.claude/skills is in Claude's own session catalogue, and gone after removal",
    async () => {
      const box = await sandbox();
      const delivery = await deliverFile(
        box,
        "skill",
        "claude-user-skills",
        "ork-conformance-skill",
        SKILL("ork-conformance-skill"),
      );
      expect(delivery.installed?.status).toBe("installed-next-session");
      expect((await claudeInit(claude!, box)).skills).toContain("ork-conformance-skill");
      expect((await delivery.remove())?.status).toBe("ready");
      expect((await claudeInit(claude!, box)).skills).not.toContain("ork-conformance-skill");
    },
    TIMEOUT_MS,
  );

  test(
    "a session plugin reaches only the session that passes it, namespaced, and nothing lands in the shared home",
    async () => {
      const box = await sandbox();
      const { artifacts, storage } = await executorFor(box);
      const digest = await artifacts.put(
        validatePackageFiles(
          SKILL("ork-session-skill").map((file) => ({
            path: `ork-session-skill/${file.path}`,
            content: Buffer.from(file.content),
          })),
        ),
      );
      const root = sessionPluginsRoot(path.join(box.root, "orkestrator-data"));
      const staged = await stageSessionPlugin({
        root,
        artifacts,
        items: [
          {
            packageId: "managed:ork-session-skill",
            packageDigest: digest,
            componentId: "managed:ork-session-skill#skill:ork-session-skill",
            kind: "skill",
            name: "ork-session-skill",
            pathOrKey: "ork-session-skill",
          },
        ],
      });
      storage.close?.();
      // The SDK hands an inline plugin to the CLI as --plugin-dir.
      const withPlugin = await claudeInit(claude!, box, ["--plugin-dir", staged.directory]);
      expect(withPlugin.skills).toContain("orkestrator-session:ork-session-skill");
      // Runtime proof: the CLI reports the content-addressed directory it loaded,
      // which is what grades the session's copy load-confirmed.
      const evidence = {
        state: "evidence" as const,
        generation: 1,
        loadedAt: new Date().toISOString(),
        plugins: withPlugin.loaded,
        skills: withPlugin.skills,
        usedSkills: [],
      };
      expect(loadedPrivatePlugin(evidence, staged.record.digest)).toBe(true);
      const without = await claudeInit(claude!, box);
      expect(
        loadedPrivatePlugin({ ...evidence, plugins: without.loaded }, staged.record.digest),
      ).toBe(false);
      expect(without.skills.some((name) => name.includes("ork-session-skill"))).toBe(false);
      expect(await fs.readdir(path.join(box.homes.claudeConfigDir)).catch(() => [])).not.toContain(
        "skills",
      );
    },
    TIMEOUT_MS,
  );

  test(
    "a plugin installs from the approved bytes through Orkestrator's marketplace, updates, and uninstalls only its own copy",
    async () => {
      const box = await sandbox();
      const cli = cliFor(claude!, box, "Claude Code");
      const adapter = new ClaudePluginAdapter({ homes: () => box.homes, cli });
      const files = (body: string) =>
        validatePackageFiles([
          {
            path: ".claude-plugin/plugin.json",
            content: Buffer.from(
              JSON.stringify({
                name: "ork-conformance",
                version: "1.0.0",
                description: "Conformance",
              }),
            ),
          },
          {
            path: "skills/greet/SKILL.md",
            content: Buffer.from(`---\nname: greet\ndescription: Greets\n---\n${body}\n`),
          },
          {
            path: "hooks/hooks.json",
            content: Buffer.from(
              JSON.stringify({
                hooks: {
                  PreToolUse: [{ matcher: "Never", hooks: [{ type: "command", command: "true" }] }],
                },
              }),
            ),
          },
          {
            path: "scripts/check.sh",
            content: Buffer.from("#!/bin/sh\nexit 0\n"),
            executable: true,
          },
        ]);

      // An external plugin of another name from another marketplace must survive everything.
      const external = path.join(box.root, "external-marketplace");
      await fs.mkdir(path.join(external, ".claude-plugin"), { recursive: true });
      await fs.mkdir(path.join(external, "keep", ".claude-plugin"), { recursive: true });
      await fs.writeFile(
        path.join(external, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
          name: "ext",
          owner: { name: "x" },
          plugins: [{ name: "keep", source: "./keep" }],
        }),
      );
      await fs.writeFile(
        path.join(external, "keep", ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "keep", version: "1.0.0" }),
      );
      await cli(["plugin", "marketplace", "add", external, "--scope", "user", "--json"]);
      await cli(["plugin", "install", "keep@ext", "--scope", "user", "--json"]);

      const first = files("Say hello.");
      const installed = await adapter.install({
        packageId: "conformance",
        componentId: "conformance#native-plugin:claude:ork-conformance",
        files: first,
      });
      expect(installed).toMatchObject({
        status: "installed-next-session",
        verification: "enabled",
        digest: treeDigest(first),
      });
      const listed = parseClaudePluginList((await cli(["plugin", "list", "--json"])).stdout)!;
      expect(
        listed.find((entry) => entry.id === "ork-conformance@orkestrator-managed"),
      ).toMatchObject({
        enabled: true,
        scope: "user",
      });
      // Claude accepts the marketplace Orkestrator wrote.
      const validated = await cli([
        "plugin",
        "validate",
        claudeMarketplaceDirectory(box.homes),
        "--json",
      ]);
      expect(JSON.parse(validated.stdout).success).toBe(true);
      // The session loads the plugin and its skill.
      const init = await claudeInit(claude!, box);
      expect(init.plugins).toContain("ork-conformance@orkestrator-managed");
      expect(init.skills).toContain("ork-conformance:greet");

      // Replay: observation answers, nothing is reinstalled.
      const replay = await adapter.install({
        packageId: "conformance",
        componentId: "conformance#native-plugin:claude:ork-conformance",
        files: first,
      });
      expect(replay.replayed).toBe(true);

      // Update with an unchanged manifest version: Claude's copy follows the new bytes.
      const second = files("Say goodbye.");
      const updated = await adapter.install({
        packageId: "conformance",
        componentId: "conformance#native-plugin:claude:ork-conformance",
        files: second,
      });
      expect(updated).toMatchObject({
        status: "installed-next-session",
        digest: treeDigest(second),
      });
      expect((await adapter.observe())[0]).toMatchObject({
        digest: treeDigest(second),
        drifted: false,
      });

      const removed = await adapter.remove({
        packageId: "conformance",
        componentId: "conformance#native-plugin:claude:ork-conformance",
      });
      expect(removed.status).toBe("ready");
      const after = parseClaudePluginList((await cli(["plugin", "list", "--json"])).stdout)!;
      expect(after.map((entry) => entry.id)).toEqual(["keep@ext"]);
      expect(await fs.stat(claudeMarketplaceDirectory(box.homes)).catch(() => null)).toBeNull();
    },
    TIMEOUT_MS,
  );
});

describe.skipIf(!codex)(`Codex ${PINNED_TOOLCHAIN_VERSIONS.codex}`, () => {
  test(
    "the pinned binary is the one under test",
    async () => {
      const box = await sandbox();
      expect(await versionOf(codex!, box)).toContain(PINNED_TOOLCHAIN_VERSIONS.codex);
    },
    TIMEOUT_MS,
  );

  test(
    "a skill the executor writes to ~/.agents/skills is in Codex's model-visible skill list, and gone after removal",
    async () => {
      const box = await sandbox();
      const delivery = await deliverFile(
        box,
        "skill",
        "agents-shared-skills",
        "ork-conformance-skill",
        SKILL("ork-conformance-skill"),
      );
      expect(delivery.installed?.status).toBe("installed-next-session");
      expect(await codexPromptInput(codex!, box)).toContain("ork-conformance-skill:");
      expect((await delivery.remove())?.status).toBe("ready");
      expect(await codexPromptInput(codex!, box)).not.toContain("ork-conformance-skill:");
    },
    TIMEOUT_MS,
  );

  test(
    "a discovered plugin is switched off and on through config.toml, as Codex itself reports",
    async () => {
      const box = await sandbox();
      const cli = cliFor(codex!, box, "Codex");
      const marketplace = path.join(box.root, "codex-marketplace");
      const plugin = path.join(marketplace, "plugins", "demo");
      await fs.mkdir(path.join(marketplace, ".agents", "plugins"), { recursive: true });
      await fs.mkdir(path.join(plugin, ".codex-plugin"), { recursive: true });
      await fs.mkdir(path.join(plugin, "skills", "hello"), { recursive: true });
      await fs.writeFile(
        path.join(marketplace, ".agents", "plugins", "marketplace.json"),
        JSON.stringify({
          name: "local-test",
          plugins: [{ name: "demo", source: { source: "local", path: "./plugins/demo" } }],
        }),
      );
      await fs.writeFile(
        path.join(plugin, ".codex-plugin", "plugin.json"),
        JSON.stringify({ name: "demo", version: "1.0.0", description: "Demo" }),
      );
      await fs.writeFile(
        path.join(plugin, "skills", "hello", "SKILL.md"),
        "---\nname: hello\ndescription: Says hello\n---\nSay hello.\n",
      );
      expect((await cli(["plugin", "marketplace", "add", marketplace, "--json"])).exitCode).toBe(0);
      expect((await cli(["plugin", "add", "demo@local-test", "--json"])).exitCode).toBe(0);
      const config = path.join(box.homes.codexHome, "config.toml");
      await fs.appendFile(config, "\n# a comment the edit must keep\n");
      expect(await codexPromptInput(codex!, box)).toContain("demo:hello");

      const off = await toggleCodexPlugin(
        { codexHome: box.homes.codexHome, cli },
        "demo@local-test",
        false,
      );
      expect(off).toMatchObject({ enabled: false, changed: true });
      expect(parseCodexInstalledPlugins((await cli(["plugin", "list", "--json"])).stdout)).toEqual([
        { pluginId: "demo@local-test", enabled: false },
      ]);
      expect(await codexPromptInput(codex!, box)).not.toContain("demo:hello");
      expect(await fs.readFile(config, "utf8")).toContain("# a comment the edit must keep");

      const on = await toggleCodexPlugin(
        { codexHome: box.homes.codexHome, cli },
        "demo@local-test",
        true,
      );
      expect(on).toMatchObject({ enabled: true, changed: true });
      expect(await codexPromptInput(codex!, box)).toContain("demo:hello");
    },
    TIMEOUT_MS,
  );
});

describe.skipIf(!opencode2)(`OpenCode ${PINNED_TOOLCHAIN_VERSIONS.opencode2}`, () => {
  test(
    "a subagent the executor writes to ~/.config/opencode/agent is listed by the binary",
    async () => {
      const box = await sandbox();
      expect(await versionOf(opencode2!, box)).toContain(PINNED_TOOLCHAIN_VERSIONS.opencode2);
      const delivery = await deliverFile(
        box,
        "subagent",
        "opencode-user-agents",
        "ork-conformance-agent",
        [
          {
            path: "agents/ork-conformance-agent.md",
            content: "---\ndescription: Conformance\n---\nReview.\n",
          },
        ],
        "agents/ork-conformance-agent.md",
      );
      expect(delivery.installed?.status).toBe("installed-next-session");
      // A private server for this run: never the shared background service and its fixed port.
      const listed = await cliFor(opencode2!, box, "OpenCode")(["debug", "agents", "--standalone"]);
      const ids = (JSON.parse(listed.stdout) as Array<{ id: string }>).map((agent) => agent.id);
      expect(ids).toContain("ork-conformance-agent");
      expect((await delivery.remove())?.status).toBe("ready");
    },
    TIMEOUT_MS,
  );
});

describe.skipIf(!grok)(`Grok Build ${PINNED_TOOLCHAIN_VERSIONS.grok}`, () => {
  test(
    "the pinned binary is the one under test",
    async () => {
      const box = await sandbox();
      expect(await versionOf(grok!, box)).toContain(PINNED_TOOLCHAIN_VERSIONS.grok);
    },
    TIMEOUT_MS,
  );

  test(
    "skills the executor writes to ~/.grok/skills and ~/.agents/skills are in Grok's own discovery listing at their installed paths, and gone after removal",
    async () => {
      const box = await sandbox();
      const cli = cliFor(grok!, box, "Grok Build");
      const own = await deliverFile(
        box,
        "skill",
        "grok-user-skills",
        "ork-grok-skill",
        SKILL("ork-grok-skill"),
      );
      const shared = await deliverFile(
        box,
        "skill",
        "agents-shared-skills",
        "ork-shared-skill",
        SKILL("ork-shared-skill"),
      );
      expect(own.installed?.status).toBe("installed-next-session");
      expect(shared.installed?.status).toBe("installed-next-session");
      const listed = await grokDiscoveredSkills(cli);
      expect(listed).not.toBeNull();
      const paths = new Map(listed!.map((entry) => [entry.name, path.resolve(entry.path)]));
      expect(paths.get("ork-grok-skill")).toBe(
        path.join(box.homes.home, ".grok", "skills", "ork-grok-skill", "SKILL.md"),
      );
      expect(paths.get("ork-shared-skill")).toBe(
        path.join(box.homes.home, ".agents", "skills", "ork-shared-skill", "SKILL.md"),
      );
      // The listing grades the matching receipt advertised, by path, not by name.
      const proofs = gradeGrokDiscovery({
        receipts: [
          {
            id: "r1",
            nodeId: "self",
            locationId: "grok-user-skills",
            componentId: "c1",
            packageId: "p1",
            digest: "d",
            packageDigest: "pd",
            references: [],
            providers: ["grok"],
            alsoVisibleTo: [],
            status: "installed-next-session",
            verification: "present",
            operationId: "op",
            appliedAt: new Date().toISOString(),
          },
        ],
        matching: new Set(["r1"]),
        discovered: listed!,
        homes: box.homes,
        state: {
          components: {
            c1: {
              id: "c1",
              packageId: "p1",
              kind: "skill",
              name: "ork-grok-skill",
              pathOrKey: "",
              dependencies: [],
              providerHints: [],
              requirements: {},
            } as never,
          },
        },
      });
      expect(proofs.get("c1")?.level).toBe("advertised");
      expect((await own.remove())?.status).toBe("ready");
      expect((await shared.remove())?.status).toBe("ready");
      const after = (await grokDiscoveredSkills(cli)) ?? [];
      expect(after.some((entry) => entry.name.startsWith("ork-"))).toBe(false);
    },
    TIMEOUT_MS,
  );
});

// Pi is qualified through its pinned SDK (bridges/pi-bridge,
// capability-delivery-conformance.test.ts). The Cursor SDK has no
// credential-free listing: it discovers skills only inside an authenticated
// run, so it is qualified by a billed run in an isolated dev:test profile
// instead (e2e/agent-testing/capability-cursor-live.spec.ts).
test.skip("Cursor SDK: qualified by e2e/agent-testing/capability-cursor-live.spec.ts", () => {});
