/**
 * The `account-switch` case's profile fixtures against a real store: the
 * scripted orchestration test fakes both fixtures, so this is what proves the
 * registry write, the seeded outcome, the missing-session exit and the exact
 * registry restore through the real `backend-store.ts` process.
 *
 * Slow tier by name: each fixture call spawns that helper under Bun, about a
 * second apiece.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseAgentAccountStore } from "../../apps/backend/src/core/agent-accounts-store";
import { nativeAgentSessionStorageKey } from "../../apps/backend/src/core/native-agent-service-shared";
import { createEnvironment, StorageService } from "../../apps/backend/src/core/storage";
import { readStoredValue, seedStore } from "../../apps/backend/src/core/storage-test-support";
import { profileAccountFixtures } from "./coordinator-live-account-fixtures";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const roots: string[] = [];
const services: StorageService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function profile(): { dataDir: string; cleanup: Array<() => Promise<unknown>> } {
  const root = mkdtempSync(path.join(tmpdir(), "coordinator-live-account-fixtures-"));
  roots.push(root);
  return { dataDir: path.join(root, "data"), cleanup: [] };
}

/** Undo in reverse, as `runCoordinatorCleanup` does; a failed step fails the test. */
async function runCleanup(cleanup: Array<() => Promise<unknown>>): Promise<void> {
  for (const step of cleanup.toReversed()) await step();
}

test("a staged account joins the registry inactive and signed in, and cleanup restores the registry exactly", async () => {
  const { dataDir, cleanup } = profile();
  const original = {
    version: 1,
    accounts: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        platform: "claude",
        label: "existing",
        createdAt: "2026-11-01T00:00:00.000Z",
      },
    ],
    active: { claude: "11111111-1111-4111-8111-111111111111" },
  };
  seedStore(dataDir, "agent-accounts.json", original);
  const fixtures = profileAccountFixtures({ repositoryRoot, dataDir, cleanup });

  const { accountId } = await fixtures.stageAccount("claude", "fixture-a");

  const staged = parseAgentAccountStore(readStoredValue(dataDir, "agent-accounts.json"));
  expect(staged.accounts.map((account) => account.id)).toEqual([
    original.accounts[0]!.id,
    accountId,
  ]);
  expect(staged.accounts[1]).toMatchObject({ platform: "claude", label: "fixture-a" });
  // Staging never switches: the existing account stays active.
  expect(staged.active.claude).toBe(original.active.claude);
  const home = path.join(dataDir, "agent-accounts", "claude", accountId);
  expect(statSync(home).mode & 0o777).toBe(0o700);
  for (const file of [".credentials.json", ".claude.json"]) {
    expect(statSync(path.join(home, file)).mode & 0o777).toBe(0o600);
  }
  const credential = JSON.parse(readFileSync(path.join(home, ".credentials.json"), "utf8")) as {
    claudeAiOauth: { accessToken: string };
  };
  expect(credential.claudeAiOauth.accessToken).toBe("fixture-access-fixture-a");

  // A switch during the case (the granted phase) is undone with the rest.
  seedStore(dataDir, "agent-accounts.json", {
    ...(readStoredValue(dataDir, "agent-accounts.json") as object),
    active: { claude: accountId },
  });
  await runCleanup(cleanup);
  expect(readStoredValue(dataDir, "agent-accounts.json")).toEqual(original);
  expect(existsSync(home)).toBe(false);
});

test("with no registry before the case, cleanup removes the one staging wrote", async () => {
  const { dataDir, cleanup } = profile();
  // An unrelated store, so the profile's database exists the way a running one's does.
  seedStore(dataDir, "prompt-queues.json", {});
  const fixtures = profileAccountFixtures({ repositoryRoot, dataDir, cleanup });

  const { accountId } = await fixtures.stageAccount("codex", "fixture-b");
  const staged = parseAgentAccountStore(readStoredValue(dataDir, "agent-accounts.json"));
  expect(staged.accounts).toEqual([
    expect.objectContaining({ id: accountId, platform: "codex", label: "fixture-b" }),
  ]);
  expect(staged.active.codex).toBeUndefined();
  expect(existsSync(path.join(dataDir, "agent-accounts", "codex", accountId, "auth.json"))).toBe(
    true,
  );

  await runCleanup(cleanup);
  expect(readStoredValue(dataDir, "agent-accounts.json")).toBeUndefined();
});

test("a seeded outcome lands on a running backend's stored session; a missing session is refused", async () => {
  const { dataDir, cleanup } = profile();
  const storage = new StorageService(dataDir);
  services.push(storage);
  await storage.init();
  const environment = await storage.addEnvironment({
    ...createEnvironment("project-1"),
    name: "Limited worker",
  });
  const identity = {
    environmentId: environment.id,
    agent: "codex" as const,
    logicalSessionKey: `env-${environment.id}:startup-agent`,
  };
  const key = nativeAgentSessionStorageKey(
    identity.environmentId,
    identity.agent,
    identity.logicalSessionKey,
  );
  await storage.getOrCreateNativeAgentSession({ key, ...identity }, async () => "provider-session");
  const fixtures = profileAccountFixtures({ repositoryRoot, dataDir, cleanup });
  const outcome = {
    requestId: "account-switch-fixture",
    outcome: "failed" as const,
    error: "You've hit your usage limit.",
    failureKind: "usage-limit" as const,
    observedAt: "2026-11-13T10:00:00.000Z",
  };

  await fixtures.seedTurnOutcome(identity, outcome);
  const sessions = readStoredValue<Record<string, { turnOutcomes?: unknown[] }>>(
    dataDir,
    "native-agent-sessions.json",
  );
  expect(sessions?.[key]?.turnOutcomes?.at(-1)).toEqual(outcome);

  // backend-store exits 3 for a session that is not stored.
  await expect(
    fixtures.seedTurnOutcome({ ...identity, logicalSessionKey: "env-missing:tab" }, outcome),
  ).rejects.toThrow("the limited worker's session is not stored");
  expect(cleanup).toEqual([]);
});
