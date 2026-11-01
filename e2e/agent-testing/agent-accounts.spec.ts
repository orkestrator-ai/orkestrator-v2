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

test("automatic switching, its pin and its ticks rehydrate from the real backend", async ({
  page,
}, testInfo) => {
  const statusCommand = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (statusCommand.status !== 0) throw new Error(statusCommand.stderr || "dev:status failed");
  const status = JSON.parse(statusCommand.stdout) as { dataDir: string };
  const original = accountRegistry(status.dataDir, "read");
  // No access token, so no usage read leaves this machine: the rule has no reading
  // of either account, and the host login has no email, so it stays unticked.
  const accounts = ["one", "two"].map((name) => ({
    id: randomUUID(),
    platform: "codex",
    label: `Fixture ${name}`,
    createdAt: "2026-09-28T00:00:00Z",
    identity: { email: `${name}@example.com` },
  }));
  for (const account of accounts) {
    const home = path.join(status.dataDir, "agent-accounts", "codex", account.id);
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(home, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { refresh_token: "fixture-only", account_id: "fixture" },
      }),
    );
  }
  accountRegistry(status.dataDir, "write", { version: 1, active: {}, accounts });
  const mainTick = () =>
    page.getByRole("checkbox", { name: /Automatically use the account whose weekly limit/ });
  const row = (name: string) => page.getByRole("listitem", { name });
  const region = () => page.getByRole("region", { name: "Codex accounts" });
  try {
    await login(page, testInfo);
    await openCodexAccounts(page);
    // A manual profile keeps its config, so an earlier failed run may have left it on.
    await expect(mainTick()).toBeVisible();
    if (await mainTick().isChecked()) await mainTick().click();
    await expect(mainTick()).not.toBeChecked();
    await expect(region().getByText("Off", { exact: true })).toBeVisible();

    // Ticked, the host login is not included, so the machine moves by itself.
    await mainTick().click();
    await expect(region().getByText("Automatic", { exact: true })).toBeVisible();
    await expect(mainTick()).toBeChecked();
    await expect(region().getByText("Active", { exact: true })).toBeVisible();
    await expect(row("Host login").getByText("Active", { exact: true })).toHaveCount(0);

    // Its own switch does not pin. The next one, made by hand, does.
    const activeIsOne = (await row("Fixture one").getByText("Active", { exact: true }).count()) > 0;
    const other = activeIsOne ? "Fixture two" : "Fixture one";
    await row(other).getByRole("button", { name: "Use" }).click();
    await expect(region().getByText(`Pinned to ${other}`)).toBeVisible();
    await expect(mainTick()).not.toBeChecked();

    await page.reload();
    await openCodexAccounts(page);
    await expect(region().getByText(`Pinned to ${other}`)).toBeVisible();
    await expect(row(other).getByText("Active", { exact: true })).toBeVisible();

    await mainTick().click();
    await expect(region().getByText("Automatic", { exact: true })).toBeVisible();

    // An account's own tick off moves the machine off it, and it is never chosen.
    await row(other)
      .getByRole("checkbox", { name: `Include ${other} in automatic switching` })
      .click();
    const remaining = other === "Fixture one" ? "Fixture two" : "Fixture one";
    await expect(row(remaining).getByText("Active", { exact: true })).toBeVisible();
    await page.reload();
    await openCodexAccounts(page);
    await expect(
      row(other).getByRole("checkbox", { name: `Include ${other} in automatic switching` }),
    ).not.toBeChecked();
    await mainTick().click();
    await expect(region().getByText("Off", { exact: true })).toBeVisible();
  } finally {
    if (original) accountRegistry(status.dataDir, "write", original.value);
    else accountRegistry(status.dataDir, "delete");
  }
});

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

for (const width of [1280, 390]) {
  test(`an unavailable preferred login can be cleared and stays cleared after reload (${width}px)`, async ({
    page,
  }, testInfo) => {
    const statusCommand = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    if (statusCommand.status !== 0) throw new Error(statusCommand.stderr || "dev:status failed");
    const status = JSON.parse(statusCommand.stdout) as {
      status: string;
      flavor: string;
      dataDir: string;
      testProject: string;
      browserUrl: string;
    };
    expect(status.status).toBe("ready");
    expect(status.flavor).toBe("agent-test");
    const original = accountRegistry(status.dataDir, "read");
    const openOverview = async () => {
      const settings = page.getByRole("button", { name: "Global settings", exact: true });
      if (width < 768) {
        await expect(
          page
            .getByRole("dialog", { name: "Projects and environments", exact: true })
            .or(page.getByRole("button", { name: "Open projects and environments", exact: true })),
        ).toBeVisible();
        // On a phone the sidebar's bottom bar, with Settings, is in the
        // projects drawer, which may already be open on first load.
        const drawer = page.getByRole("dialog", { name: "Projects and environments", exact: true });
        await expect(async () => {
          if (!(await drawer.isVisible())) {
            await page
              .getByRole("button", { name: "Open projects and environments" })
              .click({ timeout: 1_000 });
          }
          await drawer
            .getByRole("button", { name: "Global settings", exact: true })
            .click({ timeout: 1_000 });
          await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible({
            timeout: 1_000,
          });
        }).toPass({ timeout: 15_000 });
      } else {
        await settings.click();
      }
      if (width < 768) {
        await page.getByRole("combobox", { name: "Settings section" }).click();
        await page.getByRole("option", { name: "Machines", exact: true }).click();
      } else {
        await page
          .getByRole("navigation", { name: "Settings sections" })
          .getByRole("button", { name: "Machines", exact: true })
          .click();
      }
      await expect(page.getByTestId("machine-agent-accounts-row")).toHaveCount(1);
    };
    accountRegistry(status.dataDir, "write", {
      version: 1,
      active: {},
      accounts: [],
      preferred: { claude: "gone@example.com" },
    });
    try {
      await page.setViewportSize({ width, height: 900 });
      await login(page, testInfo);
      const projectsResponse = await page.request.post(
        new URL("/__orkestrator/invoke", status.browserUrl).href,
        {
          data: { command: "get_projects", args: {} },
        },
      );
      expect(projectsResponse.ok()).toBe(true);
      const projects = (await projectsResponse.json()) as {
        result: Array<{ name: string; localPath: string }>;
      };
      const fixture = projects.result.find((project) => project.localPath === status.testProject);
      if (!fixture) throw new Error("The profile's fixture project was not found");
      await openOverview();
      const summary = page.getByTestId("machine-agent-preferred");
      await expect(summary).toContainText("gone@example.com");
      await expect(page.getByRole("button", { name: "By account", exact: true })).toHaveCount(0);
      const clear = page.getByRole("button", { name: "Clear preferred Claude Code login" });
      await clear.scrollIntoViewIfNeeded();
      await expect(clear).toBeInViewport();
      await clear.focus();
      await expect(clear).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(summary).toHaveCount(0);
      expect(accountRegistry(status.dataDir, "read")?.value).not.toHaveProperty("preferred");
      await page.reload();
      await openOverview();
      await expect(page.getByTestId("machine-agent-preferred")).toHaveCount(0);
    } finally {
      if (original === null) accountRegistry(status.dataDir, "delete");
      else accountRegistry(status.dataDir, "write", original.value);
    }
  });
}
