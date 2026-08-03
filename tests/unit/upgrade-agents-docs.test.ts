import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");

async function read(relativePath: string): Promise<string> {
  return readFile(join(repoRoot, relativePath), "utf8");
}

describe("agent upgrade runbook contracts", () => {
  test("all upgrade entry points reference the consolidated runbook", async () => {
    const legacyGuide = ["docs/codex", "upgrade", "guide.md"].join("-");
    const sources = await Promise.all([
      read("AGENTS.md"),
      read("scripts/verify-toolchain-artifacts.ts"),
      read("bridges/codex-bridge/src/app-server/notification-replay.test.ts"),
    ]);

    for (const source of sources) {
      expect(source).toContain("docs/upgrade-agents.md");
      expect(source).not.toContain(legacyGuide);
    }
  });

  test("pins the same explicit Codex binary for generation and the live contract", async () => {
    const runbook = await read("docs/upgrade-agents.md");

    expect(runbook).toMatch(
      /CODEX_PROTOCOL_BINARY=\/absolute\/path\/to\/new\/codex \\\n\s+bun run verify:codex:protocol/,
    );
    expect(runbook).toMatch(
      /CODEX_PROTOCOL_BINARY=\/absolute\/path\/to\/new\/codex \\\n\s+RUN_LIVE_CODEX_APP_SERVER=1 \\\n\s+bun test bridges\/codex-bridge\/src\/app-server\/live-contract\.test\.ts/,
    );
  });

  test("documents full live artifact verification and the actual Codex pin source", async () => {
    const [runbook, dockerfile] = await Promise.all([
      read("docs/upgrade-agents.md"),
      read("docker/Dockerfile"),
    ]);

    expect(runbook).toContain("bun run verify:toolchains:live");
    const codexSyncComment = dockerfile.match(/^#   CODEX_CLI_VERSION.*$/m)?.[0];
    expect(codexSyncComment).toContain("config/codex-version.json");
    expect(codexSyncComment).toContain("generated app-server protocol");
    expect(codexSyncComment).not.toContain("@openai/codex-sdk");
  });
});
