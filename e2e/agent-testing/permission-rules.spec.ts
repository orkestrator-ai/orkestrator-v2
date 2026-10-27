import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { loadAppWithDevRetry } from "./dev-startup-retry";

/**
 * Settings → Permissions against the real backend (todo 0723): a rule the
 * backend holds is listed with its pattern, scope and use, and removing it
 * from the page removes it from the backend's store. Rules are staged straight
 * into the profile's database because only an approval card can create one,
 * and a card needs a real, billed provider turn.
 */

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";

function rulesStore(dataDir: string, action: "list" | "create", value?: unknown): unknown {
  const result = spawnSync(
    "bun",
    [path.join(import.meta.dirname, "permission-rules-store.ts"), dataDir, action],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      input: value === undefined ? undefined : JSON.stringify(value),
    },
  );
  if (result.status !== 0) throw new Error(result.stderr || `permission rules ${action} failed`);
  return action === "list" ? JSON.parse(result.stdout) : null;
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

test("Settings lists the backend's permission rules and removes one", async ({
  page,
}, testInfo) => {
  const statusCommand = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (statusCommand.status !== 0) throw new Error(statusCommand.stderr || "dev:status failed");
  const status = JSON.parse(statusCommand.stdout) as { status: string; dataDir: string };
  expect(status.status).toBe("ready");

  const ruleId = randomUUID();
  const pattern = `npm run e2e-${ruleId.slice(0, 8)}`;
  rulesStore(status.dataDir, "create", {
    id: ruleId,
    provider: "codex",
    scope: "project",
    projectId: `e2e-permission-${ruleId.slice(0, 8)}`,
    kind: "command-prefix",
    pattern,
    createdAt: Date.now(),
    createdFrom: { environmentId: "e2e-environment", agent: "codex", interactionId: "e2e" },
    lastUsedAt: Date.now(),
    useCount: 2,
  });

  // This check uses no agent, Docker or GitHub: let credential-free profiles
  // reach the workspace through the ordinary optional-tool dialogs.
  for (const name of [
    "Continue Without Claude",
    "Continue Without Docker",
    "Continue Without GitHub CLI",
  ]) {
    await page.addLocatorHandler(page.getByRole("button", { name, exact: true }), (button) =>
      button.click(),
    );
  }
  await login(page, testInfo);
  await page.getByRole("button", { name: "Global settings" }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Permissions", exact: true })
    .click();
  const row = page.getByTestId("permission-rule-row").filter({ hasText: pattern });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Whole project");
  await expect(row).toContainText("Used 2 times");
  await expect(page.getByRole("region", { name: "Rules outside Orkestrator" })).toBeVisible();

  await row.getByRole("button", { name: `Remove rule ${pattern}` }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(row).toHaveCount(0);
  const remaining = rulesStore(status.dataDir, "list") as Array<{ id: string }>;
  expect(remaining.some((rule) => rule.id === ruleId)).toBe(false);
});
