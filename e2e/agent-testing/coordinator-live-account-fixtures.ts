/**
 * The `account-switch` case's out-of-band fixtures for a running agent-test
 * profile (`coordinator-live-account-switch-orchestration.ts`): one more
 * signed-in fixture account in the profile's own account directory and
 * registry, and a usage-limit turn outcome appended to a worker's session.
 *
 * Everything is written under the profile's data directory through
 * `backend-store.ts`, which commits like a second backend process; nothing
 * touches `~/.claude`, `~/.codex` or a real login, and every token is a
 * fixture string no provider accepts. Each undo is pushed to `cleanup`.
 *
 * Runs under Node (the spec), so the store helper is spawned with Bun.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentAccountPlatform } from "@orkestrator/protocol/agent-accounts";
import type { AccountSwitchFixtures } from "../../apps/desktop/scripts/dev/coordinator-live-account-switch-orchestration";

type StoredRegistry = {
  version?: number;
  accounts?: unknown[];
  active?: Record<string, string>;
  [key: string]: unknown;
};

function backendStore(
  repositoryRoot: string,
  dataDir: string,
  file: string,
  action: "read" | "write" | "delete" | "append-turn-outcome",
  value?: unknown,
): { status: number | null; stdout: string } {
  const result = spawnSync(
    "bun",
    [path.join(import.meta.dirname, "backend-store.ts"), dataDir, file, action],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      input: value === undefined ? undefined : JSON.stringify(value),
    },
  );
  return { status: result.status, stdout: result.stdout };
}

function insideProfile(dataDir: string, ...parts: string[]): string {
  const root = path.resolve(dataDir);
  const file = path.join(root, ...parts);
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error("A fixture path escapes the profile");
  return file;
}

/** Login files that make a home read as signed in, for each account platform. */
function writeFixtureLogin(home: string, platform: AgentAccountPlatform, label: string): void {
  if (platform === "claude") {
    writeFileSync(
      path.join(home, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: `fixture-access-${label}`,
          refreshToken: `fixture-refresh-${label}`,
          expiresAt: Date.now() + 7 * 24 * 3_600_000,
          scopes: ["user:inference", "user:profile"],
          subscriptionType: "max",
        },
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        hasCompletedOnboarding: true,
        oauthAccount: {
          emailAddress: `${label}@fixture.invalid`,
          accountUuid: `fixture-${label}`,
          organizationUuid: "fixture-org",
        },
      }),
      { mode: 0o600 },
    );
  } else {
    writeFileSync(
      path.join(home, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: `fixture-not-a-key-${label}` }),
      { mode: 0o600 },
    );
  }
}

export function profileAccountFixtures(input: {
  repositoryRoot: string;
  dataDir: string;
  cleanup: Array<() => Promise<unknown>>;
}): AccountSwitchFixtures {
  const { repositoryRoot, dataDir, cleanup } = input;
  return {
    async stageAccount(platform, label) {
      const read = backendStore(repositoryRoot, dataDir, "agent-accounts.json", "read");
      if (read.status !== 0) throw new Error("backend-store could not read the account registry");
      const original = (JSON.parse(read.stdout) as { value: StoredRegistry } | null)?.value;
      const accountId = randomUUID();
      const home = insideProfile(dataDir, "agent-accounts", platform, accountId);
      mkdirSync(home, { recursive: true, mode: 0o700 });
      cleanup.push(async () => rmSync(home, { recursive: true, force: true }));
      writeFixtureLogin(home, platform, label);
      // Restore the registry exactly, which also undoes the switch and its pin.
      cleanup.push(async () => {
        const restored = original
          ? backendStore(repositoryRoot, dataDir, "agent-accounts.json", "write", original)
          : backendStore(repositoryRoot, dataDir, "agent-accounts.json", "delete");
        if (restored.status !== 0) throw new Error("The account registry could not be restored");
      });
      const written = backendStore(repositoryRoot, dataDir, "agent-accounts.json", "write", {
        ...original,
        version: original?.version ?? 1,
        accounts: [
          ...(original?.accounts ?? []),
          {
            id: accountId,
            platform,
            label,
            createdAt: new Date().toISOString(),
            identity: { email: `${label}@fixture.invalid` },
          },
        ],
        active: { ...original?.active },
      });
      if (written.status !== 0)
        throw new Error("backend-store could not stage the fixture account");
      return { accountId };
    },
    async seedTurnOutcome(identity, outcome) {
      const result = backendStore(
        repositoryRoot,
        dataDir,
        "native-agent-sessions.json",
        "append-turn-outcome",
        { session: identity, outcome },
      );
      if (result.status === 3) throw new Error("the limited worker's session is not stored");
      if (result.status !== 0) throw new Error("backend-store could not seed the turn outcome");
    },
  };
}
