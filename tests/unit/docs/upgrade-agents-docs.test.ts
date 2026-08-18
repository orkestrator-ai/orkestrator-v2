import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../../..");

/**
 * Assembled rather than written out so this file is not itself a hit for the
 * repo-wide `rg codex-upgrade-guide` sweep the runbook prescribes — the guard
 * would otherwise report itself as a stale reference forever. Do not
 * "simplify" this back into a string literal.
 */
const LEGACY_GUIDE = ["docs/codex", "upgrade", "guide.md"].join("-");

function read(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), "utf8");
}

/**
 * `git grep` rather than reading every tracked file: it searches the working
 * tree, so a file that is tracked but deleted locally is skipped instead of
 * throwing ENOENT. This is also the exact sweep the runbook prescribes.
 */
function filesReferencing(needle: string): string[] {
  const search = Bun.spawnSync(["git", "grep", "-l", "-F", needle], { cwd: root });
  if (search.exitCode === 1) return [];
  if (search.exitCode !== 0) {
    throw new Error(`git grep failed: ${search.stderr.toString()}`);
  }
  return search.stdout.toString().split("\n").filter(Boolean);
}

describe("agent upgrade runbook contracts", () => {
  test("no tracked file anywhere still references the removed Codex guide", () => {
    // The previous version of this guard hand-listed three files, so a stale
    // reference reintroduced in README.md or an ADR would have gone unnoticed.
    expect(filesReferencing(LEGACY_GUIDE)).toEqual([]);
  });

  test("all upgrade entry points reference the consolidated runbook", async () => {
    const sources = await Promise.all([
      read("AGENTS.md"),
      read("scripts/verify-toolchain-artifacts.ts"),
      read("bridges/codex-bridge/src/app-server/notification-replay.test.ts"),
    ]);

    for (const source of sources) {
      expect(source).toContain("docs/upgrade-agents.md");
    }
  });

  test("pins the same explicit Codex binary for generation and the live contract", async () => {
    // Asserted as independent tokens inside the fenced blocks rather than as one
    // regex over exact line-continuation whitespace, so reflowing the markdown
    // does not fail the build for a cosmetic edit.
    const runbook = await read("docs/upgrade-agents.md");
    const fences = [...runbook.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]);

    const generationBlock = fences.find((fence) => fence.includes("verify:codex:protocol"));
    const liveContractBlock = fences.find((fence) => fence.includes("live-contract.test.ts"));

    expect(generationBlock).toBeDefined();
    expect(liveContractBlock).toBeDefined();
    for (const block of [generationBlock!, liveContractBlock!]) {
      expect(block).toContain("CODEX_PROTOCOL_BINARY=");
    }
    expect(liveContractBlock).toContain("RUN_LIVE_CODEX_APP_SERVER=1");
  });

  test("every command the runbook tells you to run actually exists", async () => {
    // The point of this guard: the runbook naming a script that was renamed or
    // deleted is exactly the drift the consolidation was meant to end, and
    // asserting the prose alone cannot catch it.
    const runbook = await read("docs/upgrade-agents.md");

    // `download:<claude|codex|opencode>` is a documented placeholder, not a
    // script name. Capture any trailing `<` so those are recognisable and drop
    // them — a lookahead would just backtrack into the shorter `download`.
    const invocations = [...runbook.matchAll(/\bbun run (?:--cwd (\S+) )?([\w:-]+<?)/g)]
      .map((match) => ({ workspace: match[1], script: match[2] }))
      .filter(({ script }) => !script.includes("<"));

    expect(invocations.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const { workspace, script } of invocations) {
      const manifestPath = workspace ? `${workspace}/package.json` : "package.json";
      if (seen.has(`${manifestPath} ${script}`)) continue;
      seen.add(`${manifestPath} ${script}`);

      const manifest = (await Bun.file(path.join(root, manifestPath)).json()) as {
        scripts?: Record<string, string>;
      };
      const invocation = workspace ? `--cwd ${workspace} ${script}` : script;
      expect(
        manifest.scripts?.[script],
        `docs/upgrade-agents.md runs \`bun run ${invocation}\``,
      ).toBeTruthy();
    }
  });

  test("every repository path the runbook cites exists", async () => {
    const runbook = await read("docs/upgrade-agents.md");
    const cited = new Set(
      [...runbook.matchAll(/`((?:apps|bridges|config|docs|packages|scripts|tests)\/[\w./-]+)`/g)]
        .map((match) => match[1])
        .filter((candidate) => path.extname(candidate) !== ""),
    );

    expect(cited.size).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const candidate of cited) {
      if (!(await Bun.file(path.join(root, candidate)).exists())) missing.push(candidate);
    }

    expect(missing).toEqual([]);
  });

  test("documents full live artifact verification and the actual pin sources", async () => {
    const [runbook, dockerfile] = await Promise.all([
      read("docs/upgrade-agents.md"),
      read("docker/Dockerfile"),
    ]);

    expect(runbook).toContain("bun run verify:toolchains:live");

    const codexSyncComment = dockerfile.match(/^#   CODEX_CLI_VERSION.*$/m)?.[0];
    expect(codexSyncComment).toContain("config/codex-version.json");
    expect(codexSyncComment).toContain("generated app-server protocol");
    expect(codexSyncComment).not.toContain("@openai/codex-sdk");

    // The Codex line was corrected while the line directly below it kept naming
    // a dependency the root manifest does not have.
    const opencodeSyncComment = dockerfile.match(/^#   OPENCODE_CLI_VERSION.*$/m)?.[0];
    expect(opencodeSyncComment).toContain("apps/web/package.json");
    expect(opencodeSyncComment).toContain("apps/backend/package.json");
  });
});
