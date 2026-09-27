import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  INPUT_LIMITS,
  INPUT_REVISION_PRUNE_GRACE_MS,
  portableInputSpec,
  pruneInputRevisions,
  readInputsManifest,
  scrubStagedProvider,
  stagePortableInputs,
  stagedInputMountArguments,
  type InputSourceRoots,
} from "../../../apps/backend/src/core/portable-inputs";
import {
  providerCredentialsAllowed,
  revokeProviderCredentials,
  selectedInputProviders,
} from "../../../apps/backend/src/core/portable-input-status";
import { environmentStateDirectory } from "../../../apps/backend/src/core/environment-state-paths";
import {
  lifecycleEnvironment,
  memoryLifecycleContext,
  tempDir,
  withDockerScript,
} from "./container-lifecycle-fixtures";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function write(file: string, content: string | Buffer = "x") {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

/** A fake host home with inputs, excluded state and sentinels. */
async function fixtureHome() {
  const root = await tempDir("ork-inputs-");
  cleanup.push(root);
  const home = path.join(root, "home");
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir, { recursive: true });
  // Claude: allowlisted files and extensions, plus state that must never be staged.
  await write(path.join(home, ".claude", "CLAUDE.md"), "memory");
  await write(path.join(home, ".claude", ".credentials.json"), '{"token":"fixture"}');
  await write(path.join(home, ".claude", "history.jsonl"), "SENTINEL-HISTORY");
  await write(path.join(home, ".claude", "projects", "p", "s.jsonl"), "SENTINEL-TRANSCRIPT");
  await write(path.join(home, ".claude", "commands", "review.md"), "command");
  await fs.symlink("/etc/hostname", path.join(home, ".claude", "commands", "escape.md"));
  await write(path.join(home, ".claude.json"), '{"hasCompletedOnboarding":true}');
  // Codex: disabled in most tests; its sentinel must never appear.
  await write(path.join(home, ".codex", "auth.json"), "SENTINEL-CODEX-AUTH");
  await write(path.join(home, ".codex", "sessions", "r.jsonl"), "SENTINEL-CODEX-SESSION");
  // A dotfiles-managed gitconfig (the file itself is a link).
  await write(path.join(root, "dotfiles", "gitconfig"), "[user]\n\tname = Fixture\n");
  await fs.symlink(path.join(root, "dotfiles", "gitconfig"), path.join(home, ".gitconfig"));
  const roots: InputSourceRoots = { home, agentTest: false };
  return { root, home, dataDir, roots };
}

async function listFiles(directory: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (relative: string) => {
    for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      else out.push(child);
    }
  };
  await walk("");
  return out.sort();
}

describe("portable input staging", () => {
  test("stages only the allowlist of enabled providers and binds only staged subtrees", async () => {
    const { dataDir, roots } = await fixtureHome();
    const staged = await stagePortableInputs(
      dataDir,
      "env-inputs",
      new Set(["claude", "git"] as const),
      roots,
    );
    const files = await listFiles(staged.directory);
    expect(files).toEqual([
      "claude-config/.credentials.json",
      "claude-config/CLAUDE.md",
      "claude-config/commands/review.md",
      "files/claude.json/.claude.json",
      "files/gitconfig/gitconfig",
      "manifest.json",
    ]);
    for (const file of files) {
      const content = await fs.readFile(path.join(staged.directory, file), "utf8");
      expect(content).not.toContain("SENTINEL");
    }
    expect(staged.providers.find((entry) => entry.provider === "claude")).toMatchObject({
      files: 5 - 1,
      skipped: { symlink: 1 },
    });
    // Mounts: the staged subtrees at the entrypoint's paths, read-only, and
    // never the revision directory or its parent.
    const args = stagedInputMountArguments(staged);
    expect(args.filter((arg) => arg !== "--mount")).toEqual([
      `type=bind,src=${staged.directory}/claude-config,dst=/claude-config,readonly`,
      `type=bind,src=${staged.directory}/files/claude.json/.claude.json,dst=/claude-config.json,readonly`,
      `type=bind,src=${staged.directory}/files/gitconfig/gitconfig,dst=/tmp/gitconfig,readonly`,
    ]);
    for (const arg of args) expect(arg).not.toContain("SENTINEL");
  });

  test("revisions are private, atomic and described by a content-free manifest", async () => {
    const { dataDir, roots } = await fixtureHome();
    const staged = await stagePortableInputs(
      dataDir,
      "env-inputs",
      new Set(["claude"] as const),
      roots,
    );
    const parent = environmentStateDirectory(dataDir, "portable-inputs", "env-inputs");
    expect((await fs.stat(parent)).mode & 0o777).toBe(0o700);
    expect(
      (await fs.stat(path.join(staged.directory, "claude-config", ".credentials.json"))).mode &
        0o777,
    ).toBe(0o600);
    expect((await fs.readdir(parent)).filter((name) => name.endsWith(".partial"))).toEqual([]);
    const manifest = await readInputsManifest(dataDir, "env-inputs", staged.revision);
    expect(manifest?.providers).toEqual(staged.providers);
    expect(JSON.stringify(manifest)).not.toContain("review.md");
    expect(await readInputsManifest(dataDir, "env-inputs", "../../etc")).toBeNull();
  });

  test("enforces per-file, per-directory and aggregate bounds while copying", async () => {
    const { dataDir, roots, home } = await fixtureHome();
    await write(path.join(home, ".claude", "commands", "big.md"), Buffer.alloc(2048, 1));
    for (let index = 0; index < 5; index += 1) {
      await write(path.join(home, ".claude", "agents", `a${index}.md`), "agent");
    }
    const staged = await stagePortableInputs(
      dataDir,
      "env-inputs",
      new Set(["claude"] as const),
      roots,
      new Date(),
      { ...INPUT_LIMITS, fileBytes: 1024, totalEntries: 6 },
    );
    const summary = staged.providers[0]!;
    expect(summary.skipped["too-large"]).toBe(1);
    expect(summary.skipped["aggregate-budget"]).toBeGreaterThan(0);
    expect(summary.files).toBeLessThanOrEqual(6);
  });

  test("a symlinked ancestor below the home entry is never followed", async () => {
    const { dataDir, roots, home, root } = await fixtureHome();
    await write(path.join(root, "elsewhere", "secret.md"), "SENTINEL-ELSEWHERE");
    await fs.symlink(path.join(root, "elsewhere"), path.join(home, ".claude", "plugins"));
    const staged = await stagePortableInputs(
      dataDir,
      "env-inputs",
      new Set(["claude"] as const),
      roots,
    );
    const files = await listFiles(staged.directory);
    expect(files.some((file) => file.startsWith("claude-config/plugins"))).toBe(false);
    expect(staged.providers[0]!.skipped.symlink).toBeGreaterThanOrEqual(2);
  });

  test("prunes only revisions no container binds", async () => {
    const { dataDir, roots } = await fixtureHome();
    const first = await stagePortableInputs(
      dataDir,
      "env-inputs",
      new Set(["git"] as const),
      roots,
    );
    const second = await stagePortableInputs(
      dataDir,
      "env-inputs",
      new Set(["git"] as const),
      roots,
    );
    const parent = environmentStateDirectory(dataDir, "portable-inputs", "env-inputs");
    await fs.mkdir(path.join(parent, ".r0-abcdef01.partial"));
    await fs.writeFile(path.join(parent, "unrelated.txt"), "keep");
    // Nothing is old enough yet: a staging or creation may still be using them.
    expect(await pruneInputRevisions(dataDir, "env-inputs", new Set([second.revision]))).toBe(0);
    const later = Date.now() + INPUT_REVISION_PRUNE_GRACE_MS + 1_000;
    expect(
      await pruneInputRevisions(dataDir, "env-inputs", new Set([second.revision]), later),
    ).toBe(2);
    expect((await fs.readdir(parent)).sort()).toEqual([second.revision, "unrelated.txt"].sort());
    expect(first.revision).not.toBe(second.revision);
  });
});

describe("provider selection", () => {
  test("stages enabled providers, narrowed to authorized ones in agent-test profiles", () => {
    expect([...selectedInputProviders({}, ["claude", "codex"])].sort()).toEqual([
      "claude",
      "codex",
      "git",
    ]);
    expect(
      [
        ...selectedInputProviders(
          { runtimeFlavor: "agent-test", credentialSources: new Set(["codex"]) },
          ["claude", "codex"],
        ),
      ].sort(),
    ).toEqual(["codex"]);
  });

  test("scrubbing a provider empties its staged inputs in place and leaves others", async () => {
    const { dataDir, roots } = await fixtureHome();
    const staged = await stagePortableInputs(
      dataDir,
      "env-inputs",
      new Set(["claude", "git"] as const),
      roots,
    );
    const claudeMount = staged.mounts.find((mount) => mount.target === "/claude-config")!;
    const configFile = staged.mounts.find((mount) => mount.target === "/claude-config.json")!;
    const before = await fs.stat(configFile.source);
    expect(await scrubStagedProvider(dataDir, "env-inputs", staged.revision, "claude")).toBe(true);
    // The bound directory still exists (a bind mount keeps it) but is empty.
    expect(await fs.readdir(claudeMount.source)).toEqual([]);
    // A bound file keeps its inode, so the container sees it emptied.
    const after = await fs.stat(configFile.source);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(0);
    const git = staged.mounts.find((mount) => mount.target === "/tmp/gitconfig")!;
    expect((await fs.readFile(git.source, "utf8")).length).toBeGreaterThan(0);
    expect(await scrubStagedProvider(dataDir, "env-inputs", "r0-00000000", "claude")).toBe(false);
    expect(await scrubStagedProvider(dataDir, "env-inputs", "../escape", "claude")).toBe(false);
  });

  test("revocation is recorded, empties the staged inputs and gates later credential syncs", async () => {
    const { dataDir, roots } = await fixtureHome();
    const staged = await stagePortableInputs(
      dataDir,
      "env-lifecycle",
      new Set(["claude", "git"] as const),
      roots,
    );
    const { context, environments } = memoryLifecycleContext(
      [lifecycleEnvironment({ containerId: "container-1" })],
      dataDir,
    );
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  inspect) printf '${staged.revision}\\n' ;;
esac
exit 0
`,
      async (log) => {
        const result = await revokeProviderCredentials("env-lifecycle", "claude", context);
        expect(result).toEqual({
          provider: "claude",
          removed: true,
          pendingRebuild: false,
          processesStopped: true,
        });
        const calls = await log.read();
        expect(calls).toContain("/home/node/.claude/.credentials.json");
        expect(calls).toContain("pkill -TERM -f '[/]opt/claude-bridge/'");
      },
    );
    expect(environments.get("env-lifecycle")?.revokedInputProviders).toEqual(["claude"]);
    const claudeMount = staged.mounts.find((mount) => mount.target === "/claude-config")!;
    expect(await fs.readdir(claudeMount.source)).toEqual([]);
    const environment = environments.get("env-lifecycle")!;
    expect(providerCredentialsAllowed({}, ["claude", "codex"], environment, "claude")).toBe(false);
    expect(providerCredentialsAllowed({}, ["claude", "codex"], environment, "codex")).toBe(true);
    expect([
      ...selectedInputProviders({}, ["claude", "codex"], environment.revokedInputProviders),
    ]).toEqual(["codex", "git"]);
    // Disabled is never allowed, revoked or not.
    expect(providerCredentialsAllowed({}, ["codex"], null, "claude")).toBe(false);
  });

  test("a revocation interrupted before the container answers is still in force", async () => {
    const { dataDir } = await fixtureHome();
    const { context, environments } = memoryLifecycleContext(
      [lifecycleEnvironment({ containerId: "container-1" })],
      dataDir,
    );
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
echo "Cannot connect to the Docker daemon" >&2
exit 1
`,
      async () => {
        const result = await revokeProviderCredentials("env-lifecycle", "claude", context);
        // Nothing could be confirmed in the container...
        expect(result.removed).toBe(false);
        expect(result.pendingRebuild).toBe(true);
      },
    );
    // ...but the revocation was recorded first, so nothing hands it back.
    const environment = environments.get("env-lifecycle")!;
    expect(environment.revokedInputProviders).toEqual(["claude"]);
    expect(providerCredentialsAllowed({}, ["claude"], environment, "claude")).toBe(false);
  });

  test("a staging interrupted by a restart is never read and a new one is independent", async () => {
    const { dataDir, roots } = await fixtureHome();
    const parent = environmentStateDirectory(dataDir, "portable-inputs", "env-inputs");
    await fs.mkdir(path.join(parent, ".r0-abcdef01.partial", "claude-config"), { recursive: true });
    await fs.writeFile(path.join(parent, ".r0-abcdef01.partial", "claude-config", "x"), "half");
    expect(await readInputsManifest(dataDir, "env-inputs", ".r0-abcdef01.partial")).toBeNull();
    expect(await readInputsManifest(dataDir, "env-inputs", "r0-abcdef01")).toBeNull();
    const staged = await stagePortableInputs(
      dataDir,
      "env-inputs",
      new Set(["claude", "git"] as const),
      roots,
    );
    expect(staged.revision).not.toBe("r0-abcdef01");
    expect(await readInputsManifest(dataDir, "env-inputs", staged.revision)).toMatchObject({
      revision: staged.revision,
    });
    // The abandoned partial goes once it is old enough, never the live one.
    const later = Date.now() + INPUT_REVISION_PRUNE_GRACE_MS + 1_000;
    expect(
      await pruneInputRevisions(dataDir, "env-inputs", new Set([staged.revision]), later),
    ).toBe(1);
    expect(await fs.readdir(parent)).toEqual([staged.revision]);
  });

  test("the allowlist mirrors every mount point the entrypoint reads", async () => {
    const entrypoint = await fs.readFile(
      path.join(import.meta.dir, "../../../docker/entrypoint.sh"),
      "utf8",
    );
    const spec = portableInputSpec({ home: "/h", agentTest: false });
    for (const provider of spec) {
      for (const directory of provider.directories) {
        expect(entrypoint).toContain(directory.target);
        for (const file of directory.files ?? []) {
          expect(entrypoint).toContain(path.basename(file));
        }
      }
      for (const file of provider.files) expect(entrypoint).toContain(file.target);
    }
    expect(entrypoint).toContain("ORKESTRATOR_CAPABILITY staged-inputs=1");
  });
});
