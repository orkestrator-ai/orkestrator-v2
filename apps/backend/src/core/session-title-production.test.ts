/** Production composition, with only account/credential boundaries replaced. */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAccountsSnapshot } from "@orkestrator/protocol/agent-accounts";
import type { CommandContext } from "./commands-context.js";
import * as accounts from "./agent-accounts.js";
import * as active from "./agent-accounts-active.js";
import * as credentials from "./host-agent-credentials.js";
import {
  createSessionTitleService,
  sessionTitleGenerationEnabled,
} from "./session-title-service.js";

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

function fixtureEnv(key: string, value: string) {
  const previous = process.env[key];
  process.env[key] = value;
  restores.push(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

describe("production session title service", () => {
  test.each([
    [{}, true],
    [{ NODE_ENV: "production" }, true],
    [{ NODE_ENV: "test" }, false],
    [{ ORKESTRATOR_SESSION_TITLE_GENERATION: "0" }, false],
    [{ ORKESTRATOR_SESSION_TITLE_GENERATION: "1" }, true],
    [{ NODE_ENV: "test", ORKESTRATOR_SESSION_TITLE_GENERATION: "1" }, false],
  ] as const)("honors production generation gates (%j)", (env, enabled) => {
    expect(sessionTitleGenerationEnabled(env)).toBe(enabled);
  });

  test.each(["codex", "claude"] as const)(
    "selects the signed-in active %s account and managed binary",
    async (strategy) => {
      const root = await mkdtemp(join(tmpdir(), "title-production-"));
      const accountSnapshot: AgentAccountsSnapshot = {
        active: { codex: "work", claude: "work" },
        accounts: ["codex", "claude"].map((platform) => ({
          id: "work",
          platform: platform as "codex" | "claude",
          label: "Fixture account",
          isDefault: false,
          isActive: true,
          signedIn: platform === strategy,
          identity: {},
        })),
      };
      const accountRead = spyOn(accounts, "listAgentAccounts").mockResolvedValue(accountSnapshot);
      restores.push(() => accountRead.mockRestore());
      const launchOrder: string[] = [];
      const accountEnvironment = spyOn(
        active,
        "applyActiveAgentAccountEnvironment",
      ).mockImplementation(async (_context, platform, env) => {
        launchOrder.push(`account:${platform}`);
        env[platform === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"] = join(
          root,
          "active-account",
        );
        return "work";
      });
      restores.push(() => accountEnvironment.mockRestore());
      const hostEnvironment = spyOn(
        credentials,
        "applyClaudeHostCredentialEnvironment",
      ).mockImplementation(async (_context, env) => {
        launchOrder.push("host:claude");
        env.CLAUDE_CONFIG_DIR = join(root, "host-account");
      });
      restores.push(() => hostEnvironment.mockRestore());
      fixtureEnv("GH_TOKEN", "fixture-github-token");
      fixtureEnv("GITHUB_TOKEN", "fixture-github-token");
      fixtureEnv("DISABLE_AUTOUPDATER", "0");
      fixtureEnv("FORCE_AUTOUPDATE_PLUGINS", "0");
      const record = join(root, "launch");
      const executable = join(root, strategy);
      await writeFile(
        executable,
        `#!/bin/sh\nset -eu\ncat >/dev/null\nprintf '%s\\n' "$0" "\${CODEX_HOME:-}" "\${CLAUDE_CONFIG_DIR:-}" "\${GH_TOKEN:+present}" "\${GITHUB_TOKEN:+present}" "\${DISABLE_AUTOUPDATER:-}" "\${FORCE_AUTOUPDATE_PLUGINS:-}" > '${record}'\nprintf 'Production title\\n'\n`,
      );
      await chmod(executable, 0o755);
      const context = {
        appRoot: root,
        resourceRoot: root,
        toolchainBinDir: root,
        storage: { loadConfig: async () => ({ global: {} }) },
      } as unknown as CommandContext;
      const service = createSessionTitleService(context);
      try {
        // An unrelated platform still uses the only signed-in strategy.
        expect(await service.generate({ agent: "pi", source: "Fixture request" })).toEqual({
          title: "Production title",
          strategy,
        });
        expect(accountRead).toHaveBeenCalledWith(context);
        expect(accountEnvironment).toHaveBeenCalledWith(context, strategy, expect.any(Object));
        const lines = (await readFile(record, "utf8")).split("\n");
        expect(lines[0]).toBe(executable);
        expect(lines[strategy === "codex" ? 1 : 2]).toBe(join(root, "active-account"));
        expect(lines.slice(3, 5)).toEqual(["", ""]);
        if (strategy === "claude") {
          expect(lines.slice(5, 7)).toEqual(["1", "1"]);
          expect(launchOrder).toEqual(["host:claude", "account:claude"]);
        } else {
          expect(launchOrder).toEqual(["account:codex"]);
          expect(hostEnvironment).not.toHaveBeenCalled();
        }
        // The saved setting decides: a Pi session's first message stays home.
        const ownLoginOnly = createSessionTitleService({
          ...context,
          storage: {
            loadConfig: async () => ({ global: { sessionTitleGeneration: "own-platform" } }),
          },
        } as unknown as CommandContext);
        await expect(ownLoginOnly.generate({ agent: "pi", source: "Fixture" })).resolves.toBeNull();
        await ownLoginOnly.shutdown();
      } finally {
        await service.shutdown();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
