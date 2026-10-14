import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MAX_AGENT_ACCOUNTS_PER_PLATFORM } from "@orkestrator/protocol/agent-accounts";
import { loadAppWithDevRetry } from "./dev-startup-retry";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";

/** The account registry lives in the backend database; stage it through Bun. */
function accountRegistry(
  dataDir: string,
  action: "read" | "write" | "delete",
  value?: unknown,
): { value: unknown } | null {
  const result = spawnSync(
    "bun",
    [path.join(import.meta.dirname, "backend-store.ts"), dataDir, "agent-accounts.json", action],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      input: value === undefined ? undefined : JSON.stringify(value),
    },
  );
  if (result.status !== 0) throw new Error(result.stderr || `backend-store ${action} failed`);
  return action === "read" ? (JSON.parse(result.stdout) as { value: unknown } | null) : null;
}

async function login(page: Page, testInfo: TestInfo): Promise<void> {
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(command.stderr || "dev:login failed");
  const { loginUrl } = JSON.parse(command.stdout) as { loginUrl?: unknown };
  if (typeof loginUrl !== "string") throw new Error("dev:login returned no login URL");
  await loadAppWithDevRetry(page, testInfo, () =>
    page.goto(loginUrl, { waitUntil: "domcontentloaded" }),
  );
}

async function openCodexAccounts(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Global settings" }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Codex", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "Codex accounts" })).toBeVisible();
}

test("account switching and errors rehydrate from the real backend", async ({ page }, testInfo) => {
  const statusCommand = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (statusCommand.status !== 0) throw new Error(statusCommand.stderr || "dev:status failed");
  const status = JSON.parse(statusCommand.stdout) as {
    status: string;
    flavor: string;
    dataDir: string;
  };
  expect(status.status).toBe("ready");
  expect(status.flavor).toBe("agent-test");
  const original = accountRegistry(status.dataDir, "read");
  const accountId = randomUUID();
  const home = path.join(status.dataDir, "agent-accounts", "codex", accountId);
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(
    path.join(home, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { refresh_token: "fixture-only", account_id: "fixture" },
    }),
  );
  accountRegistry(status.dataDir, "write", {
    version: 1,
    active: {},
    accounts: [
      {
        id: accountId,
        platform: "codex",
        label: "Fixture account",
        createdAt: "2026-09-28T00:00:00Z",
      },
    ],
  });
  try {
    await login(page, testInfo);
    await openCodexAccounts(page);
    const added = page.getByRole("listitem", { name: "Fixture account" });
    await expect(added).toBeVisible();
    await added.getByRole("button", { name: "Use" }).click();
    await expect(added.getByText("Active")).toBeVisible();

    await page.reload();
    await openCodexAccounts(page);
    await expect(
      page.getByRole("listitem", { name: "Fixture account" }).getByText("Active"),
    ).toBeVisible();
    await page
      .getByRole("listitem", { name: "Host login" })
      .getByRole("button", { name: "Use" })
      .click();
    await expect(
      page.getByRole("listitem", { name: "Host login" }).getByText("Active"),
    ).toBeVisible();

    accountRegistry(status.dataDir, "write", { version: 1, active: {}, accounts: [] });
    await added.getByRole("button", { name: "Use" }).click();
    await expect(page.getByText("Unknown agent account", { exact: true })).toBeVisible();
    await page.reload();
    await openCodexAccounts(page);
    await expect(page.getByRole("listitem", { name: "Fixture account" })).toHaveCount(0);

    accountRegistry(status.dataDir, "write", {
      version: 1,
      active: {},
      accounts: Array.from({ length: MAX_AGENT_ACCOUNTS_PER_PLATFORM }, (_, index) => ({
        id: randomUUID(),
        platform: "codex",
        label: `Limit fixture ${index}`,
        createdAt: "2026-09-28T00:00:00Z",
      })),
    });
    await page.reload();
    await openCodexAccounts(page);
    await page
      .getByRole("region", { name: "Codex accounts" })
      .getByRole("button", { name: "Add account" })
      .click();
    await expect(
      page.getByText("No more accounts can be added for this platform.", { exact: true }),
    ).toBeVisible();
  } finally {
    if (original === null) accountRegistry(status.dataDir, "delete");
    else accountRegistry(status.dataDir, "write", original.value);
    await fs.rm(home, { recursive: true, force: true });
  }
});
