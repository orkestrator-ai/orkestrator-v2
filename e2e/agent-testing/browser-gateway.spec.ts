import {
  newReviewValidationRun,
  type ReviewValidationRun,
} from "@orkestrator/protocol/review-workflow";
import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dismissSidebarTooltip } from "./sidebar-tooltip";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import { environmentStateDirectories } from "../../apps/backend/src/core/environment-state-paths";
import type {
  MultiReviewActionResult,
  MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";

import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";

type Status = {
  status: string;
  profile?: string;
  flavor?: string;
  browserUrl?: string;
  authFile?: string;
  dataDir?: string;
  testProject?: string;
};
type Project = { id: string; name: string; localPath: string | null };
type Environment = {
  id: string;
  name: string;
  worktreePath?: string | null;
  branch: string;
  containerId?: string | null;
  status: string;
};
type AgentMessagingSettings = {
  enabled: boolean;
  paused: boolean;
  defaultInjectPolicy: "off" | "idle";
  allowCrossProject: boolean;
  retentionDays: number;
};

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";

/**
 * Environment ids the deletion ledger still owes cleanup for. The ledger lives
 * in the backend database, which Node cannot open; read it through Bun.
 */
function pendingCleanupEnvironmentIds(dataDir: string): string[] {
  const result = spawnSync(
    "bun",
    [
      path.join(import.meta.dirname, "backend-store.ts"),
      dataDir,
      "environment-cleanup-ledger.json",
      "read",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr || "backend-store read failed");
  const stored = JSON.parse(result.stdout) as {
    value?: { entries?: Record<string, { environmentId?: unknown }> };
  } | null;
  return Object.values(stored?.value?.entries ?? {}).flatMap((entry) =>
    typeof entry.environmentId === "string" ? [entry.environmentId] : [],
  );
}

async function profileStatus(): Promise<Status> {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) throw new Error(command.stderr || "dev:status returned no manifest");
  return JSON.parse(command.stdout) as Status;
}

async function authenticatedInvoke(page: Page, status: Status) {
  // Exercise the exact host command agents use. Its stdout is parsed in memory
  // and never copied into Playwright output, so the one-shot code stays out of
  // traces and reports.
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(command.stderr || "dev:login failed");
  let login: { loginUrl?: unknown };
  try {
    login = JSON.parse(command.stdout) as { loginUrl?: unknown };
  } catch {
    throw new Error("dev:login returned invalid JSON");
  }
  if (typeof login.loginUrl !== "string") throw new Error("dev:login returned no login URL");
  const response = await page.goto(login.loginUrl, { waitUntil: "domcontentloaded" });
  expect(response?.ok() ?? false).toBe(true);
  expect(page.url()).not.toContain("/__orkestrator/agent-test/login");
  expect(page.url()).not.toContain("code=");
  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const invokeResponse = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl!).href,
      {
        data: { command, args },
      },
    );
    expect(invokeResponse.ok(), `${command}: ${await invokeResponse.text()}`).toBe(true);
    return ((await invokeResponse.json()) as { result: T }).result;
  };
}

test.describe("host path browsing", () => {
  let onboardingFile: string;
  let seededOnboarding = false;
  test.beforeAll(async () => {
    const status = await profileStatus();
    expect(status.status).toBe("ready");
    const runtime = resolveRuntimeProfile({
      repositoryRoot,
      requestedId: profile,
      flavor: "agent-test",
    });
    onboardingFile = path.join(runtime.dataDir, "agent-credentials", "home", ".claude.json");
    // Start the profile with --credential-source claude so its host-tool onboarding read is
    // enabled. These tests run no agent turns. Seed only an empty isolated-home marker,
    // as the Codex scenario below does, without writing any authentication data.
    await fs.writeFile(onboardingFile, "{}", { flag: "wx", mode: 0o600 }).then(
      () => {
        seededOnboarding = true;
      },
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
  });
  test.afterAll(async () => {
    if (seededOnboarding) await fs.rm(onboardingFile, { force: true });
  });

  for (const viewport of [
    { name: "desktop", width: 1280, height: 860 },
    { name: "narrow", width: 390, height: 844 },
  ]) {
    test(`host picker creates and browses folders through the authenticated gateway above fullscreen settings (${viewport.name})`, async ({
      page,
    }) => {
      page.setDefaultTimeout(15_000);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const status = await profileStatus();
      expect(status.status).toBe("ready");
      const invoke = await authenticatedInvoke(page, status);
      const projects = await invoke<Project[]>("get_projects");
      const fixture = projects.find((project) => project.localPath === status.testProject)!;
      expect(fixture).toBeTruthy();
      // Keep the disposable fixture socket below the POSIX socket path length limit.
      const directory = await fs.mkdtemp("/tmp/orkestrator-picker-");
      const createdDirectory = path.join(directory, "New destination");
      // Use a real socket: SSH agents expose sockets rather than regular files.
      const socketPath = path.join(directory, "agent.sock");
      const socket = createServer();
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.listen(socketPath, resolve);
      });
      try {
        const listing = await invoke<{
          path: string;
          requestedFile: string;
          entries: { path: string }[];
        }>("list_host_directory", {
          path: directory + "/../" + path.basename(directory) + "/agent.sock",
          includeFiles: true,
        });
        expect(listing.path).toBe(directory);
        expect(listing.requestedFile).toBe(socketPath);
        expect(listing.entries.some((entry) => entry.path === socketPath)).toBe(true);

        // A computed layer assertion catches an invisible overlay as well as hidden content.
        const assertPickerLayers = async (name: string, surface: string) => {
          const picker = page.getByRole("dialog", { name, exact: true });
          await expect(picker).toBeVisible();
          const layers = await page.evaluate(
            ({ name, surface }) => {
              const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'));
              const settings = dialogs.find((node) => node.getAttribute("aria-label") === surface)!;
              const picker = dialogs.find(
                (node) => node.textContent?.includes(name) && node !== settings,
              )!;
              const overlay = document.querySelector<HTMLElement>(
                '[data-slot="dialog-overlay"][data-state="open"]',
              )!;
              return [settings, picker, overlay].map((node) =>
                Number(getComputedStyle(node).zIndex),
              );
            },
            { name, surface },
          );
          expect(layers[1]).toBeGreaterThan(layers[0]!);
          expect(layers[2]).toBeGreaterThan(layers[0]!);
          const box = await picker.boundingBox();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
          return picker;
        };

        for (const pass of ["initial", "after reload"]) {
          // Open settings in the same layout where the picker will be used. Resizing
          // across the mobile breakpoint remounts the sidebar that owns this surface.
          if (viewport.name === "narrow") {
            const drawer = page.getByRole("dialog", {
              name: "Projects and environments",
              exact: true,
            });
            const openDrawer = page.getByRole("button", { name: "Open projects and environments" });
            const closeDrawer = page
              .getByRole("button", { name: "Close projects and environments" })
              .first();
            await expect(openDrawer.or(closeDrawer).first()).toBeVisible();
            if (await openDrawer.isVisible()) await openDrawer.click();
            await expect(drawer).toBeVisible();
          }
          if (viewport.name === "narrow") {
            const drawer = page.getByRole("dialog", {
              name: "Projects and environments",
              exact: true,
            });
            await drawer.getByText(fixture.name, { exact: true }).first().click();
            if (await drawer.isVisible()) {
              await drawer
                .getByRole("button", { name: "Close projects and environments" })
                .first()
                .click();
            }
            await page.getByRole("button", { name: "Open tools" }).click();
            await page.getByRole("button", { name: "Repository settings", exact: true }).click();
          } else {
            await page.getByText(fixture.name, { exact: true }).first().click({ button: "right" });
            await page.getByRole("menuitem", { name: "Repository Settings", exact: true }).click();
          }
          const repository = page.getByRole("dialog", { name: "Repository Settings", exact: true });
          await repository.getByRole("button", { name: "Browse for local path" }).click();
          const picker = await assertPickerLayers(
            "Select Repository Directory",
            "Repository Settings",
          );
          await expect(picker.getByRole("button", { name: "Select this folder" })).toBeEnabled();
          await picker.getByLabel("Path", { exact: true }).fill(directory);
          await picker.getByLabel("Path", { exact: true }).press("Enter");
          await expect(
            picker.getByRole("button", { name: "New folder", exact: true }),
          ).toBeEnabled();
          if (pass === "initial") {
            await picker.getByRole("button", { name: "New folder", exact: true }).click();
            const folderName = picker.getByLabel("New folder name", { exact: true });
            await expect(folderName).toBeFocused();
            await expect(
              picker.getByRole("button", { name: "Create", exact: true }),
            ).toBeDisabled();
            await folderName.fill("New destination");
            await folderName.press("Enter");
            await expect(picker.getByLabel("Path", { exact: true })).toHaveValue(createdDirectory);
            await expect(folderName).toHaveCount(0);
            await expect(picker.getByText("No subfolders here.", { exact: true })).toBeVisible();
            expect((await fs.stat(createdDirectory)).isDirectory()).toBe(true);
          } else {
            await picker.getByRole("button", { name: "New destination", exact: true }).click();
            await expect(picker.getByLabel("Path", { exact: true })).toHaveValue(createdDirectory);
          }
          await expect(picker.getByRole("button", { name: "Select this folder" })).toBeEnabled();
          await picker.getByRole("button", { name: "Select this folder" }).click();
          await expect(repository.getByLabel("Local Path", { exact: true })).toHaveValue(
            createdDirectory,
          );
          // Reopen immediately, then revisit after reload to prove host filesystem persistence.
          await repository.getByRole("button", { name: "Browse for local path" }).click();
          await expect(picker.getByLabel("Path", { exact: true })).toHaveValue(createdDirectory);
          await picker.getByRole("button", { name: "Parent folder", exact: true }).click();
          await expect(picker.getByLabel("Path", { exact: true })).toHaveValue(directory);
          await picker.getByRole("button", { name: "New folder", exact: true }).click();
          await picker.getByLabel("New folder name", { exact: true }).fill("New destination");
          // Duplicate creation is a real backend error and leaves the current listing intact.
          await picker.getByRole("button", { name: "Create", exact: true }).click();
          await expect(picker.getByRole("alert")).toContainText("already exists");
          await expect(picker.getByLabel("Path", { exact: true })).toHaveValue(directory);
          await picker.getByRole("button", { name: "Cancel new folder", exact: true }).click();
          await picker.getByRole("button", { name: "Cancel", exact: true }).click();
          // Cancel repository edits so the fixture's authoritative local path stays intact.
          await repository.getByRole("button", { name: "Close settings" }).click();

          if (viewport.name === "narrow") {
            await page.getByRole("button", { name: "Open tools" }).click();
          }
          await page.getByRole("button", { name: "Global settings", exact: true }).click();
          const settings = page.getByRole("dialog", { name: "Settings", exact: true });
          await settings.getByRole("button", { name: "Browse for SSH agent socket" }).click();
          const filePicker = await assertPickerLayers("Select SSH agent socket", "Settings");
          await filePicker.getByLabel("Path", { exact: true }).fill(socketPath);
          await filePicker.getByLabel("Path", { exact: true }).press("Enter");
          await expect(filePicker.getByRole("button", { name: "Select file" })).toBeEnabled();
          await filePicker.getByRole("button", { name: "Select file" }).click();
          await expect(
            settings.getByRole("textbox", { name: "SSH agent socket", exact: true }),
          ).toHaveValue(socketPath);
          await settings.getByRole("textbox", { name: "SSH agent socket", exact: true }).fill("");
          await settings.getByRole("button", { name: "Close settings" }).click();
          if (pass === "initial") await page.reload({ waitUntil: "domcontentloaded" });
        }
      } finally {
        await new Promise<void>((resolve, reject) =>
          socket.close((error) => (error ? reject(error) : resolve())),
        );
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
  }

  test("typed project paths detect a remote and preserve newer manual URL edits", async ({
    page,
  }) => {
    const status = await profileStatus();
    expect(status.status).toBe("ready");
    expect(status.testProject).toBeTruthy();
    await authenticatedInvoke(page, status);
    const runtime = resolveRuntimeProfile({
      repositoryRoot,
      requestedId: profile,
      flavor: "agent-test",
    });
    const repository = await fs.mkdtemp(path.join(runtime.profileRoot, "remote-detection-"));
    const detectedUrl = "https://github.com/acme/detected.git";
    try {
      for (const args of [
        ["init", repository],
        ["-C", repository, "remote", "add", "origin", detectedUrl],
      ]) {
        expect(spawnSync("git", args, { encoding: "utf8" }).status).toBe(0);
      }
      await page.getByRole("button", { name: "Add project", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Add project", exact: true });
      const urlInput = dialog.getByLabel(/Git URL/);
      const pathInput = dialog.getByLabel(/Local path/);
      await expect(urlInput).toHaveValue("");
      await expect(dialog.getByRole("button", { name: "Add project", exact: true })).toBeDisabled();
      await pathInput.fill(repository);
      await expect(urlInput).toHaveValue(detectedUrl, { timeout: 10_000 });
      await expect(urlInput).toHaveClass(/border-green-500/);

      // An explicit picker action inspects the same path immediately in a browser.
      await urlInput.fill("");
      await dialog.getByRole("button", { name: "Select or detect repository directory" }).click();
      await page
        .getByRole("dialog", { name: "Select repository directory", exact: true })
        .getByRole("button", { name: "Select this folder" })
        .click();
      await expect(urlInput).toHaveValue(detectedUrl);

      // Changing the path arms another debounce; the later URL edit stays authoritative.
      await pathInput.fill(`${repository}/.`);
      await urlInput.fill("manual-invalid-url");
      await page.waitForTimeout(2300);
      await expect(urlInput).toHaveValue("manual-invalid-url");
      await expect(urlInput).toHaveClass(/border-destructive/);
      await dialog.getByRole("button", { name: "Add project", exact: true }).click();
      await expect(dialog.getByRole("alert")).toHaveText("Invalid Git URL format");

      await pathInput.fill(`${repository}/missing`);
      await dialog.getByRole("tab", { name: "Create new", exact: true }).click();
      await page.waitForTimeout(2300);
      await dialog.getByRole("tab", { name: "Existing repository", exact: true }).click();
      await expect(urlInput).toHaveValue("manual-invalid-url");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.reload();
      await page.getByRole("button", { name: "Add project", exact: true }).click();
      await expect(urlInput).toHaveValue("");
      await expect(pathInput).toHaveValue("");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    } finally {
      await fs.rm(repository, { recursive: true, force: true });
    }
  });
});

test("project Home retains background work and unread attention beneath the board", async ({
  page,
}) => {
  // The credential-free fixture exercises navigation and terminals, not login.
  await page.route("**/__orkestrator/invoke", async (route) => {
    if (route.request().postDataJSON()?.command === "check_claude_cli") {
      await route.fulfill({ json: { result: false } });
    } else await route.continue();
  });
  const status = await profileStatus();
  const invoke = await authenticatedInvoke(page, status);
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === status.testProject,
  )!;
  expect(fixture).toBeTruthy();
  const home = await invoke<Environment>("ensure_project_home_environment", {
    projectId: fixture.id,
  });
  const layout = await invoke<{ revision: number } | null>("get_pane_layout", {
    environmentId: home.id,
  });
  await invoke("save_pane_layout", {
    environmentId: home.id,
    expectedRevision: layout?.revision ?? 0,
    layout: {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "home-pane",
      root: {
        kind: "leaf",
        id: "home-pane",
        activeTabId: "home-browser",
        tabs: [{ id: "home-browser", type: "browser", browserData: { url: "" } }],
      },
    },
  });
  await page.goto(status.browserUrl!);
  const projectRow = page.getByRole("button", { name: new RegExp(`^${fixture.name}`) }).first();
  await projectRow.click();
  await expect(page.getByRole("tab", { name: "Coordinator", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("tab", { name: "Home", exact: true }).click();
  await expect(page.locator("#project-panel-home")).toBeVisible();
  const terminal = await invoke<{ sessionId: string }>("create_local_terminal_session", {
    environmentId: home.id,
    terminalKey: "home-background-check",
    cols: 80,
    rows: 24,
  });
  try {
    await invoke("start_local_terminal_session", { sessionId: terminal.sessionId });
    await invoke("local_terminal_write", {
      sessionId: terminal.sessionId,
      data: "sleep 1; printf 'home-background-finished\\n'\n",
    });
    await page.getByRole("tab", { name: "Kanban", exact: true }).click();
    await expect(page.locator("#project-panel-home")).not.toBeVisible();
    await expect
      .poll(async () => {
        const snapshot = await invoke<{ output: string }>("get_terminal_output_snapshot", {
          sessionId: terminal.sessionId,
        });
        return snapshot.output.split(/\r?\n/).some((line) => line === "home-background-finished");
      })
      .toBe(true);
    await invoke("set_environment_unread", { environmentId: home.id, unread: true });
    const attention = page.getByRole("button", { name: `${fixture.name} Home needs attention` });
    await expect(attention).toBeVisible();
    await expect
      .poll(
        async () =>
          (await invoke<{ hasUnreadWork: boolean }>("get_environment", { environmentId: home.id }))
            .hasUnreadWork,
      )
      .toBe(true);
    await page.reload();
    await projectRow.click();
    await expect(attention).toBeVisible();
    await attention.click();
    await expect(page.getByRole("tab", { name: "Home", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect
      .poll(
        async () =>
          (await invoke<{ hasUnreadWork: boolean }>("get_environment", { environmentId: home.id }))
            .hasUnreadWork,
      )
      .toBe(false);
    await projectRow.click();
    await expect(page.getByRole("tab", { name: "Coordinator", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    // Wait for the phone layout before probing for its drawer: a check that
    // runs before the media query swaps the shell sees no drawer at all. The
    // drawer opens only on a phone-sized first load; CSS finds the trigger
    // even while that modal hides it from roles.
    await expect(page.locator('button[aria-label="Open tools"]')).toBeVisible();
    const closeProjects = page
      .getByRole("button", { name: "Close projects and environments", exact: true })
      .first();
    if (await closeProjects.isVisible()) await closeProjects.click();
    await page.getByRole("button", { name: "Open tools", exact: true }).click();
    const homeTab = page.getByRole("tab", { name: "Home", exact: true });
    await expect(homeTab).toBeVisible();
    await homeTab.focus();
    await homeTab.press("Enter");
    await expect(page.locator("#project-panel-home")).toBeVisible();
  } finally {
    await invoke("close_local_terminal_session", { sessionId: terminal.sessionId });
    await invoke("set_environment_unread", { environmentId: home.id, unread: false });
  }
});

test("real browser gateway exercises an authoritative local environment", async ({ page }) => {
  const status = await profileStatus();
  expect(status.status).toBe("ready");
  expect(status.browserUrl).toBeTruthy();
  expect(status.authFile).toBeTruthy();
  expect(status.testProject).toBeTruthy();
  const invoke = await authenticatedInvoke(page, status);

  const projects = await invoke<Project[]>("get_projects");
  const fixture = projects.find((project) => project.localPath === status.testProject);
  expect(fixture).toBeTruthy();

  await page.goto(status.browserUrl!);
  await expect(page.getByText(fixture!.name, { exact: false }).first()).toBeVisible({
    timeout: 30_000,
  });

  const environment = await invoke<Environment>("create_environment", {
    projectId: fixture!.id,
    name: `smoke-${Date.now()}`,
    networkAccessMode: "restricted",
    environmentType: "local",
  });
  try {
    await invoke("start_environment", { environmentId: environment.id });
    const hydrated = await invoke<Environment>("get_environment", {
      environmentId: environment.id,
    });
    expect(hydrated.worktreePath).toBeTruthy();
    expect(hydrated.worktreePath!.includes(`${path.sep}worktrees${path.sep}`)).toBe(true);

    const terminal = await invoke<{ sessionId: string }>("create_local_terminal_session", {
      environmentId: environment.id,
      terminalKey: "agent-smoke",
      cols: 80,
      rows: 24,
      trackEnvironmentActivity: true,
    });
    await invoke("start_local_terminal_session", { sessionId: terminal.sessionId });
    await invoke("local_terminal_write", {
      sessionId: terminal.sessionId,
      data: "sleep 1; i=0; while [ $i -lt 1100 ]; do printf '%0480d\\n' \"$i\"; i=$((i + 1)); done; printf 'background-done\\n'; printf 'changed\\n' > smoke-change.txt\n",
    });

    // Exercise the inactive-environment contract through unrelated authoritative
    // reads while the backend-owned terminal keeps progressing.
    await invoke("get_projects");
    await invoke("get_environments", { projectId: fixture!.id });
    await page.reload();
    await expect(page.getByText(fixture!.name, { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });

    await expect
      .poll(
        async () => {
          const snapshot = await invoke<{
            mode: string;
            output: string;
            revision: number;
            historyTruncated: boolean;
          } | null>("get_terminal_state_snapshot", { sessionId: terminal.sessionId });
          return {
            current: snapshot?.mode === "state" && snapshot.output.includes("background-done"),
            retainedWithinBudget:
              (snapshot?.output.length ?? Number.POSITIVE_INFINITY) <= 2 * 1024 * 1024,
            rolledOver: snapshot?.historyTruncated === true,
          };
        },
        { timeout: 30_000 },
      )
      .toEqual({ current: true, retainedWithinBudget: true, rolledOver: true });
    const historyPage = await invoke<{
      rows: Array<{ text: string }>;
      previousCursor: string | null;
    } | null>("get_terminal_history_page", { sessionId: terminal.sessionId });
    expect(historyPage?.rows.some((row) => row.text.includes("background-done"))).toBe(true);
    await invoke<void>("refresh_environment_diff_stats", {
      environmentId: environment.id,
    });
    await expect
      .poll(
        async () => {
          const snapshot = await invoke<{
            entries: Array<{ environmentId: string; stats: { filesChanged: number } }>;
          }>("get_environment_diff_stats");
          return (
            snapshot.entries.find((entry) => entry.environmentId === environment.id)?.stats
              .filesChanged ?? 0
          );
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
    await invoke("close_local_terminal_session", { sessionId: terminal.sessionId });
  } finally {
    await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
  }
});

test("file rename preserves selection, survives reload and cancels on workspace change", async ({
  page,
}) => {
  const status = await profileStatus();
  expect(status.status).toBe("ready");
  // This file-browser scenario uses no agents or host credentials.
  await page.route("**/__orkestrator/invoke", async (route) => {
    if (route.request().postDataJSON()?.command === "check_claude_cli") {
      await route.fulfill({ json: { result: false } });
    } else {
      await route.continue();
    }
  });
  const invoke = await authenticatedInvoke(page, status);
  const projects = await invoke<Project[]>("get_projects");
  const fixture = projects.find((project) => project.localPath === status.testProject)!;
  expect(fixture).toBeTruthy();
  const environments: Environment[] = [];
  try {
    for (const suffix of ["source", "other"]) {
      const environment = await invoke<Environment>("create_environment", {
        projectId: fixture.id,
        name: `file-rename-${suffix}-${Date.now()}`,
        environmentType: "local",
        networkAccessMode: "restricted",
      });
      environments.push(environment);
      await invoke("start_environment", { environmentId: environment.id });
      const hydrated = await invoke<Environment>("get_environment", {
        environmentId: environment.id,
      });
      environment.worktreePath = hydrated.worktreePath;
      await fs.writeFile(path.join(environment.worktreePath!, "rename-source.txt"), suffix);
      await fs.writeFile(path.join(environment.worktreePath!, "rename-conflict.txt"), "conflict");
    }
    const [source, other] = environments;
    await page.reload();
    const expand = page.getByRole("button", {
      name: `Expand project ${fixture.name}`,
      exact: true,
    });
    const entry = page.getByText(source!.name, { exact: true }).first();
    const openSourceFiles = async () => {
      await expect(expand.or(entry)).toBeVisible({ timeout: 30_000 });
      if (await expand.isVisible()) await expand.click();
      await entry.click();
      const showFiles = page.getByRole("button", { name: "Show file panel", exact: true });
      if (await showFiles.isVisible()) await showFiles.click();
      await page.getByRole("tab", { name: "All files", exact: true }).click();
    };
    await openSourceFiles();
    const file = page.getByRole("button", { name: "rename-source.txt", exact: true });
    await file.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename…", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Rename file", exact: true });
    await expect(dialog.getByLabel("File name")).toBeFocused();
    await expect(dialog.getByRole("button", { name: "Rename", exact: true })).toBeDisabled();
    await dialog.getByLabel("File name").fill("rename-conflict.txt");
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(dialog.getByText("A file already exists at rename-conflict.txt")).toBeVisible();
    await dialog.getByLabel("File name").fill("RENAMED.txt");
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("button", { name: "RENAMED.txt", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await fs.readFile(path.join(source!.worktreePath!, "RENAMED.txt"), "utf8")).toBe(
      "source",
    );
    await page.reload();
    await openSourceFiles();
    await expect(page.getByRole("button", { name: "RENAMED.txt", exact: true })).toBeVisible();
    await expect(file).toHaveCount(0);

    await page.getByRole("button", { name: "RENAMED.txt", exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename…", exact: true }).click();
    await dialog.getByLabel("File name").fill("wrong-workspace.txt");
    // A selection change can arrive from outside this modal (e.g. another
    // navigation control). Exercise the renderer's real selection store.
    await page.evaluate(
      async ({ projectId, environmentId }) => {
        const modulePath = "/src/stores/uiStore.ts";
        const { useUIStore } = await import(modulePath);
        useUIStore.getState().selectProjectAndEnvironment(projectId, environmentId);
      },
      { projectId: fixture.id, environmentId: other!.id },
    );
    await expect(dialog).not.toBeVisible();
    await expect(file).toBeVisible();
    expect(await fs.readdir(other!.worktreePath!)).toContain("rename-source.txt");
    expect(await fs.readdir(other!.worktreePath!)).not.toContain("wrong-workspace.txt");
    await page.getByText(source!.name, { exact: true }).first().click();
    await expect(page.getByRole("button", { name: "RENAMED.txt", exact: true })).toBeVisible();
  } finally {
    for (const environment of environments) {
      await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
      await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
    }
  }
});

test("capped file tree retains source files and shows incomplete folders after reload", async ({
  page,
}) => {
  const status = await profileStatus();
  expect(status.status).toBe("ready");
  await page.route("**/__orkestrator/invoke", async (route) => {
    if (route.request().postDataJSON()?.command === "check_claude_cli") {
      await route.fulfill({ json: { result: false } });
    } else {
      await route.continue();
    }
  });
  const invoke = await authenticatedInvoke(page, status);
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === status.testProject,
  )!;
  expect(fixture).toBeTruthy();
  const environment = await invoke<Environment>("create_environment", {
    projectId: fixture.id,
    name: `capped-files-${Date.now()}`,
    environmentType: "local",
    networkAccessMode: "restricted",
  });
  try {
    await invoke("start_environment", { environmentId: environment.id });
    const hydrated = await invoke<Environment>("get_environment", {
      environmentId: environment.id,
    });
    const root = hydrated.worktreePath!;
    await fs.mkdir(path.join(root, "build"), { recursive: true });
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.mkdir(path.join(root, "build", "unopened-folder"));
    await fs.writeFile(path.join(root, "build", "unopened-folder", "hidden.o"), "");
    await fs.mkdir(path.join(root, "empty-folder"));
    await fs.writeFile(path.join(root, "src", "cap-source.ts"), "");
    for (let start = 0; start < 5_100; start += 100) {
      await Promise.all(
        Array.from({ length: 100 }, (_, offset) =>
          fs.writeFile(path.join(root, "build", `artifact-${start + offset}.o`), ""),
        ),
      );
    }
    const openFiles = async () => {
      const expand = page.getByRole("button", {
        name: `Expand project ${fixture.name}`,
        exact: true,
      });
      const entry = page.getByText(environment.name, { exact: true }).first();
      const projects = page.getByRole("button", {
        name: "Open projects and environments",
        exact: true,
      });
      if (await projects.isVisible()) await projects.click();
      await expect(expand.or(entry)).toBeVisible({ timeout: 30_000 });
      if (await expand.isVisible()) await expand.click();
      await entry.click();
      const allFiles = page.getByRole("tab", { name: "All files", exact: true });
      if (!(await allFiles.isVisible())) {
        const tools = page.getByRole("button", { name: "Open tools", exact: true });
        if (await tools.isVisible()) await tools.click();
        await page.getByRole("button", { name: "Show file panel", exact: true }).click();
      }
      await allFiles.click();
    };
    const expandFolder = async (name: string) => {
      const folder = page.getByRole("button", { name, exact: true });
      await expect(folder).toBeVisible();
      if ((await folder.getAttribute("aria-expanded")) !== "true") {
        await folder.focus();
        await page.keyboard.press("Enter");
      }
    };
    await page.reload();
    await openFiles();
    await expandFolder("src");
    await expect(page.getByRole("button", { name: "cap-source.ts", exact: true })).toBeVisible();
    await expandFolder("empty-folder");
    await expect(
      page.getByText("Some folder contents are not shown.", { exact: true }),
    ).toHaveCount(0);
    await expandFolder("build");
    await expect(
      page.getByText("Some folder contents are not shown.", { exact: true }).first(),
    ).toBeVisible();
    await expandFolder("unopened-folder");
    await expect(
      page.getByText("Some folder contents are not shown.", { exact: true }),
    ).toHaveCount(2);
    await expect(page.getByRole("button", { name: "hidden.o", exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await openFiles();
    await expandFolder("build");
    await expect(
      page.getByText("Some folder contents are not shown.", { exact: true }).first(),
    ).toBeVisible();
    await expandFolder("src");
    await expect(page.getByRole("button", { name: "cap-source.ts", exact: true })).toBeVisible();
  } finally {
    await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
  }
});

test("signed-out Codex recovery and account reads survive reload and environment switches", async ({
  page,
}) => {
  const status = await profileStatus();
  expect(status.status).toBe("ready");
  const invoke = await authenticatedInvoke(page, status);
  const projects = await invoke<Project[]>("get_projects");
  const fixture = projects.find((project) => project.localPath === status.testProject);
  expect(fixture).toBeTruthy();
  const environment = await invoke<Environment>("create_environment", {
    projectId: fixture!.id,
    name: `auth-recovery-${Date.now()}`,
    networkAccessMode: "restricted",
    environmentType: "local",
  });
  const other = await invoke<Environment>("create_environment", {
    projectId: fixture!.id,
    name: `auth-other-${Date.now()}`,
    networkAccessMode: "restricted",
    environmentType: "local",
  });
  try {
    await invoke("start_environment", { environmentId: environment.id });
    const identity = {
      environmentId: environment.id,
      agent: "codex",
      logicalSessionKey: `env-${environment.id}:tab-auth`,
    };
    await invoke("ensure_native_agent_session", identity);
    // A fresh tab creates its provider session lazily. Establish an account
    // snapshot without sending a model turn before testing the recovery banner.
    const auth = await invoke<{ state: string }>("get_native_agent_auth_status", identity);
    expect(["signed-out", "needs-auth"]).toContain(auth.state);
    const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
      environmentId: environment.id,
    });
    await invoke("save_pane_layout", {
      environmentId: environment.id,
      expectedRevision: layout?.revision ?? 0,
      layout: {
        version: PANE_LAYOUT_VERSION,
        containerId: null,
        activePaneId: "pane-auth",
        root: {
          kind: "leaf",
          id: "pane-auth",
          activeTabId: "tab-auth",
          tabs: [
            {
              id: "tab-auth",
              type: "agent-native",
              nativeAgentData: { environmentId: environment.id, platform: "codex", isLocal: true },
            },
          ],
        },
      },
    });
    await page.goto(status.browserUrl!);
    const openEnvironment = async (name: string) => {
      const expand = page.getByRole("button", { name: `Expand project ${fixture!.name}` });
      const entry = page.getByText(name, { exact: true }).first();
      await expect(expand.or(entry)).toBeVisible({ timeout: 30_000 });
      if (await expand.isVisible()) await expand.click();
      await page.mouse.move(0, 0);
      await page.keyboard.press("Escape");
      await entry.click();
    };
    await openEnvironment(environment.name);
    await expect(page.getByRole("button", { name: "Sign in to Codex", exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      page.getByRole("button", { name: "Open Codex settings", exact: true }),
    ).toHaveCount(0);
    const openAccount = async () => {
      await page.getByRole("button", { name: "Open agent information" }).click();
      await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await page.keyboard.press("Escape");
    };
    await openAccount();
    await openEnvironment(other.name);
    await openEnvironment(environment.name);
    await expect(page.getByRole("button", { name: "Sign in to Codex", exact: true })).toBeVisible();
    await openAccount();
    await page.reload();
    await openEnvironment(environment.name);
    await expect(page.getByRole("button", { name: "Sign in to Codex", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await openAccount();
  } finally {
    await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: other.id }).catch(() => undefined);
  }
});

test("queued native steering survives a lost gateway response, inactive environment and reload", async ({
  page,
}) => {
  test.skip(process.env.ORKESTRATOR_AGENT_TEST_REVIEW !== "1", "opt-in isolated Codex turn");
  test.setTimeout(240_000);
  page.setDefaultTimeout(20_000);
  const status = await profileStatus();
  expect(status.flavor).toBe("agent-test");
  const invoke = await authenticatedInvoke(page, status);
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === status.testProject,
  )!;
  const environments: Environment[] = [];
  let sessionIdentity:
    | { environmentId: string; agent: string; logicalSessionKey: string }
    | undefined;
  try {
    for (const name of ["queued-steer", "queued-other"])
      environments.push(
        await invoke<Environment>("create_environment", {
          projectId: fixture.id,
          name: `${name}-${Date.now()}`,
          environmentType: "local",
        }),
      );
    const [target, other] = environments;
    await invoke("start_environment", { environmentId: target!.id });
    const hydrated = await invoke<Environment>("get_environment", { environmentId: target!.id });
    const tabId = "queued-steer-tab";
    sessionIdentity = {
      environmentId: target!.id,
      agent: "codex",
      logicalSessionKey: `env-${target!.id}:${tabId}`,
    };
    const layout = await invoke<{ revision: number } | null>("get_pane_layout", {
      environmentId: target!.id,
    });
    await invoke("save_pane_layout", {
      environmentId: target!.id,
      expectedRevision: layout?.revision ?? 0,
      layout: {
        version: PANE_LAYOUT_VERSION,
        containerId: null,
        activePaneId: "queue-pane",
        root: {
          kind: "leaf",
          id: "queue-pane",
          tabs: [
            {
              id: tabId,
              type: "agent-native",
              nativeAgentData: { environmentId: target!.id, platform: "codex" },
            },
          ],
          activeTabId: tabId,
        },
      },
    });
    const readyFile = path.join(hydrated.worktreePath!, ".qa-queued-ready");
    const receivedFile = path.join(hydrated.worktreePath!, ".qa-queued-received");
    const marker = `queued-steer-${Date.now()}`;
    const dispatch = await invoke<{ outcome: string }>("dispatch_native_agent_intent", {
      ...sessionIdentity,
      model: process.env.ORKESTRATOR_AGENT_TEST_MODEL ?? "gpt-6.1-sol",
      reasoningEffort: "low",
      mode: "build",
      requestId: `ready-${marker}`,
      prompt:
        "This is a bounded QA task in a disposable fixture. Create .qa-queued-ready containing ready, then run sleep 45 repeatedly until steered or cancelled. Do not change other files, finish, or commit.",
    });
    expect(dispatch.outcome).toBe("accepted");
    await expect
      .poll(() => fs.readFile(readyFile, "utf8").catch(() => ""), { timeout: 120_000 })
      .toContain("ready");
    const queueKey = `codex\0${sessionIdentity.logicalSessionKey}`;
    const queued = {
      id: `source-${marker}`,
      text: `Append exactly ${marker} once to .qa-queued-received. Then run sleep 120 and wait for cancellation. Do not change other files or finish.`,
      model: "gpt-6.1-sol",
      mode: "build",
    };
    const tail = { id: `tail-${marker}`, text: "Wait for further instructions." };
    for (const message of [queued, tail])
      await invoke("enqueue_prompt_queue_message", {
        queueKey,
        environmentId: target!.id,
        message,
      });
    const openEnvironment = async (name: string) => {
      const expand = page.getByRole("button", { name: `Expand project ${fixture.name}` });
      const entry = page.getByText(name, { exact: true }).first();
      await expect(expand.or(entry)).toBeVisible({ timeout: 30_000 });
      for (const label of ["Continue Without Docker", "Continue Without GitHub CLI"]) {
        const button = page.getByRole("button", { name: label, exact: true });
        if (await button.isVisible()) await button.click();
      }
      if (await expand.isVisible()) await expand.click();
      const versionNotice = page.getByText("Orkestrator has been updated", { exact: true });
      if (await versionNotice.isVisible()) {
        await versionNotice.click({ timeout: 2_000 }).catch(() => undefined);
        await expect(versionNotice).toBeHidden();
      }
      await dismissSidebarTooltip(page, fixture.name);
      await entry.click();
    };
    await page.goto(status.browserUrl!);
    await openEnvironment(target!.name);
    const versionNotice = page.getByText("Orkestrator has been updated", { exact: true });
    if (await versionNotice.isVisible()) {
      await versionNotice.click({ timeout: 2_000 }).catch(() => undefined);
      await expect(versionNotice).toBeHidden();
    }
    await page.getByTitle("View queued prompts").click();
    const dialog = page.getByRole("dialog", { name: "Queued Prompts" });
    await expect(dialog.getByRole("button", { name: "Steer", exact: true })).toHaveCount(2);
    let dropped = false;
    await page.route("**/__orkestrator/invoke", async (route) => {
      if (route.request().postDataJSON()?.command !== "steer_native_agent_queued_prompt")
        return route.continue();
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      dropped = true;
      await route.abort("failed"); // execution succeeded; only the renderer's acknowledgement is lost
    });
    await dialog.getByRole("button", { name: "Steer", exact: true }).first().click();
    await expect.poll(() => dropped).toBe(true);
    await expect(dialog.getByRole("alert")).toBeVisible();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await openEnvironment(other!.name);
    await expect
      .poll(
        () =>
          fs
            .readFile(receivedFile, "utf8")
            .then((text) => text.trim())
            .catch(() => ""),
        { timeout: 120_000 },
      )
      .toBe(marker);
    const readQueue = () =>
      invoke<{ messages: unknown[]; inFlight?: unknown }>("get_prompt_queue", { queueKey });
    expect((await readQueue()).messages).toEqual([tail]);
    expect((await readQueue()).inFlight).toBeUndefined();
    await openEnvironment(target!.name);
    await page.getByTitle("View queued prompts").click();
    await expect(dialog.getByRole("button", { name: tail.text, exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: queued.text, exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.reload();
    await openEnvironment(target!.name);
    await page.getByTitle("View queued prompts").click();
    await expect(dialog.getByRole("button", { name: tail.text, exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: queued.text, exact: true })).toHaveCount(0);
    expect((await readQueue()).messages).toEqual([tail]);
  } finally {
    if (sessionIdentity)
      await invoke("stop_native_agent_session", sessionIdentity).catch(() => undefined);
    for (const environment of environments) {
      await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
      await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
    }
  }
});

test("build pipeline live steering persists while inactive and rehydrates after reload", async ({
  page,
}) => {
  test.skip(
    process.env.ORKESTRATOR_AGENT_TEST_REVIEW !== "1",
    "opt-in live pipeline turn against the isolated fixture with Codex credentials",
  );
  test.setTimeout(240_000);
  page.setDefaultTimeout(15_000);
  const status = await profileStatus();
  expect(status.status).toBe("ready");
  expect(status.flavor).toBe("agent-test");
  const runtime = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: profile,
    flavor: "agent-test",
  });
  expect(status.dataDir).toBe(runtime.dataDir);
  const onboardingFile = path.join(runtime.dataDir, "agent-credentials", "home", ".claude.json");
  let seededOnboarding = false;
  const invoke = await authenticatedInvoke(page, status);
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === status.testProject,
  );
  expect(fixture).toBeTruthy();
  const environments: Environment[] = [];
  let pipelineId: string | undefined;
  try {
    // The host-tool UI checks only this file's existence. The isolated HOME
    // deliberately lacks host onboarding metadata, even with Claude allowed.
    // Seed a content-free marker for this Codex-only scenario; no auth is faked.
    await fs.writeFile(onboardingFile, "{}", { flag: "wx", mode: 0o600 }).then(
      () => {
        seededOnboarding = true;
      },
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
    for (const name of ["steer-live", "steer-inactive"]) {
      environments.push(
        await invoke<Environment>("create_environment", {
          projectId: fixture!.id,
          name: `${name}-${Date.now()}`,
          environmentType: "local",
          networkAccessMode: "restricted",
        }),
      );
    }
    const [target, other] = environments;
    await invoke("start_environment", { environmentId: target!.id });
    const hydrated = await invoke<Environment>("get_environment", {
      environmentId: target!.id,
    });
    expect(hydrated.worktreePath).toBeTruthy();
    const worktree = hydrated.worktreePath!;
    const marker = `steer-received-${Date.now()}`;
    const readyFile = path.join(worktree, ".qa-steer-ready");
    const receivedFile = path.join(worktree, ".qa-steer-received");
    const pipeline = await invoke<BuildPipeline>("start_build_pipeline", {
      taskId: `qa-steer-${target!.id}`,
      projectId: fixture!.id,
      existingEnvironmentId: target!.id,
      environmentType: "local",
      agentType: "codex",
      steps: {
        build: {
          agent: "codex",
          model: process.env.ORKESTRATOR_AGENT_TEST_MODEL ?? "gpt-6.1-sol",
          reasoningEffort: "low",
        },
      },
      taskTitle: "Live steering fixture",
      taskSnapshot: {
        title: "Live steering fixture",
        description:
          "This is a bounded steering QA task. First create .qa-steer-ready containing ready. " +
          "Then run sleep 45 in the shell to keep this turn open for a steering instruction. " +
          "Do not change any other files, commit, open a PR or finish the build. " +
          "After sleeping, run sleep 45 again until cancelled or steered.",
        acceptanceCriteria: "The user will steer and cancel this QA turn.",
        comments: [],
        images: [],
      },
    });
    pipelineId = pipeline.id;
    const read = () =>
      invoke<{ snapshot: BuildPipeline; revision: number }>("get_build_pipeline", {
        pipelineId,
      });
    const fileValue = (file: string) => fs.readFile(file, "utf8").catch(() => "");
    await expect
      .poll(
        async () => {
          if ((await read()).snapshot.phase === "failed") {
            throw new Error("Live build failed before readiness; inspect the profile logs");
          }
          return fileValue(readyFile);
        },
        { timeout: 120_000 },
      )
      .toContain("ready");
    await expect
      .poll(async () => (await read()).snapshot.sessions.at(-1)?.status, { timeout: 30_000 })
      .toBe("running");
    const before = (await read()).snapshot;
    const sessionId = before.sessions.at(-1)!.sdkSessionId;
    expect(before.phase).toBe("building");

    await page.goto(status.browserUrl!);
    const openEnvironment = async (name: string) => {
      const expand = page.getByRole("button", { name: `Expand project ${fixture!.name}` });
      const entry = page.getByText(name, { exact: true }).first();
      await expect(expand.or(entry)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("Checking Docker availability...", { exact: true })).toBeHidden({
        timeout: 30_000,
      });
      for (const label of ["Continue Without Docker", "Continue Without GitHub CLI"]) {
        const continueButton = page.getByRole("button", { name: label, exact: true });
        if (await continueButton.isVisible()) await continueButton.click();
      }
      await expect(
        page.getByText("Checking CLI tools installation...", { exact: true }),
      ).toBeHidden({
        timeout: 30_000,
      });
      if (await expand.isVisible()) await expand.click();
      await page.keyboard.press("Escape");
      await entry.click();
    };
    const openBuild = async () => {
      await openEnvironment(target!.name);
      const tab = page.getByRole("button", { name: /^Build: Live steering fixture/ });
      await expect(tab).toBeVisible({ timeout: 30_000 });
      await tab.click();
    };
    await openBuild();
    const composer = page.getByLabel("Send a message to the agent", { exact: true });
    await expect(composer).toBeVisible({ timeout: 30_000 });
    const instruction =
      `Create .qa-steer-received containing exactly ${marker}. ` +
      `Then say ${marker} in your response and run sleep 120. ` +
      "Do not finish, commit, or change other files; wait for cancellation.";
    await composer.fill(`/steer ${instruction}`);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByText("Sent to the active turn", { exact: true })).toBeVisible();
    await expect(composer).toHaveValue("");
    const steered = (await read()).snapshot;
    expect(steered.sessions.at(-1)!.sdkSessionId).toBe(sessionId);
    expect(steered.pendingUserMessages ?? []).toHaveLength(0);

    await openEnvironment(other!.name);
    await expect(composer).toBeHidden();
    // Work and transcript checkpoints must progress with the build tab inactive.
    await expect.poll(() => fileValue(receivedFile), { timeout: 120_000 }).toBe(marker);
    await expect
      .poll(
        async () => {
          const result = await invoke<{ messagePatches: Array<{ messages: unknown[] }> }>(
            "get_build_pipeline",
            { pipelineId, knownSessions: {} },
          );
          return result.messagePatches.some((patch) =>
            JSON.stringify(patch.messages).includes(marker),
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    const inactive = (await read()).snapshot;
    expect(inactive.phase).toBe("building");
    expect(inactive.sessions.at(-1)!.status).toBe("running");
    expect(inactive.sessions.at(-1)!.sdkSessionId).toBe(sessionId);
    expect(inactive.pendingUserMessages ?? []).toHaveLength(0);

    await openBuild();
    await expect(page.getByText(marker, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await openBuild();
    await expect(page.getByText(marker, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
    await expect(composer).toHaveValue("");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.poll(async () => (await read()).snapshot.phase).toBe("failed");
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toHaveCount(0);
    await expect(page.getByText(marker, { exact: false }).first()).toBeVisible();
  } finally {
    if (pipelineId) {
      await invoke("cancel_build_pipeline", { pipelineId }).catch(() => undefined);
      await invoke("delete_build_pipeline", { pipelineId }).catch(() => undefined);
    }
    for (const environment of environments) {
      await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
      await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
    }
    if (seededOnboarding) await fs.rm(onboardingFile, { force: true });
  }
});

test("deletion during local setup clears worktree, bridge state, branch and ledger", async ({
  page,
}) => {
  const status = await profileStatus();
  expect(status.status).toBe("ready");
  const invoke = await authenticatedInvoke(page, status);
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === status.testProject,
  );
  expect(fixture).toBeTruthy();
  const runtime = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: profile,
    flavor: "agent-test",
  });
  // The fixture has no setup script. Start this environment from a dangling
  // commit that adds one, so the shared branch is untouched. The script keeps
  // writing a turbo log into the worktree by absolute path, as a build does:
  // if deletion left it running, it would re-create the worktree path.
  const git = (args: string[], env: NodeJS.ProcessEnv = {}, input?: string) => {
    const result = spawnSync("git", ["-C", fixture!.localPath!, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      input,
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  const baseBranch = "main";
  const name = `delete-during-setup-${Date.now()}`;
  // Not a substring of the worktree path, so it matches only the setup shell.
  const marker = `${name}-loop`;
  const index = path.join(runtime.profileRoot, `setup-index-${name}`);
  const setupConfig = git(
    ["hash-object", "-w", "--stdin"],
    {},
    `${JSON.stringify({
      // `: <marker>` lets cleanup find a survivor by its command line.
      setupLocal: `: ${marker}; while :; do mkdir -p "$PWD/.turbo" && date >> "$PWD/.turbo/turbo-setup.log"; sleep 0.2; done`,
    })}\n`,
  );
  git(["read-tree", baseBranch], { GIT_INDEX_FILE: index });
  git(["update-index", "--add", "--cacheinfo", `100644,${setupConfig},orkestrator-ai.json`], {
    GIT_INDEX_FILE: index,
  });
  const tree = git(["write-tree"], { GIT_INDEX_FILE: index });
  await fs.rm(index, { force: true });
  const setupCommit = git(["commit-tree", tree, "-p", baseBranch, "-m", "Long-running setup"], {
    GIT_AUTHOR_NAME: "Orkestrator QA",
    GIT_AUTHOR_EMAIL: "qa@orkestrator.invalid",
    GIT_COMMITTER_NAME: "Orkestrator QA",
    GIT_COMMITTER_EMAIL: "qa@orkestrator.invalid",
  });
  const environment = await invoke<Environment>("create_environment", {
    projectId: fixture!.id,
    name,
    networkAccessMode: "restricted",
    environmentType: "local",
    delegationBaseBranch: baseBranch,
    delegationBaseCommit: setupCommit,
  });
  try {
    await invoke("start_environment", { environmentId: environment.id });
    const active = await invoke<Environment>("get_environment", { environmentId: environment.id });
    expect(active.worktreePath).toBeTruthy();
    const setupLog = path.join(active.worktreePath!, ".turbo", "turbo-setup.log");
    await expect
      .poll(async () => (await fs.stat(setupLog).catch(() => null))?.size ?? 0, {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    expect(spawnSync("pgrep", ["-f", marker]).status, "setup is running").toBe(0);
    const branchRef = `refs/heads/${active.branch}`;
    const branchBefore = spawnSync(
      "git",
      ["-C", fixture!.localPath!, "show-ref", "--verify", branchRef],
      { encoding: "utf8" },
    );
    expect(branchBefore.status, branchBefore.stderr).toBe(0);
    for (const directory of environmentStateDirectories(runtime.dataDir, environment.id)) {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "state.json"), "{}\n");
    }
    await invoke("delete_environment", { environmentId: environment.id });
    expect(
      await invoke<Environment | null>("get_environment", { environmentId: environment.id }),
    ).toBeNull();
    await expect(fs.stat(active.worktreePath!)).rejects.toThrow();
    // Several loop iterations: a surviving setup would have re-created it.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await expect(fs.stat(active.worktreePath!)).rejects.toThrow();
    for (const directory of environmentStateDirectories(runtime.dataDir, environment.id)) {
      await expect(fs.stat(directory)).rejects.toThrow();
    }
    const branch = spawnSync(
      "git",
      ["-C", fixture!.localPath!, "show-ref", "--verify", branchRef],
      { encoding: "utf8" },
    );
    expect(branch.status).not.toBe(0);
    expect(pendingCleanupEnvironmentIds(runtime.dataDir)).not.toContain(environment.id);
    expect(spawnSync("pgrep", ["-f", marker]).status, "setup outlived deletion").toBe(1);
  } finally {
    await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
    // Never leave a failed run's loop writing on the host.
    spawnSync("pkill", ["-f", marker]);
  }
});

test("agent mail rehydrates after an inactive recipient is opened and the page reloads", async ({
  page,
}) => {
  const status = await profileStatus();
  expect(status.status).toBe("ready");
  expect(status.browserUrl).toBeTruthy();
  expect(status.testProject).toBeTruthy();
  const invoke = await authenticatedInvoke(page, status);
  const projects = await invoke<Project[]>("get_projects");
  const fixture = projects.find((project) => project.localPath === status.testProject);
  expect(fixture).toBeTruthy();
  const staleEnvironments = await invoke<Environment[]>("get_environments", {
    projectId: fixture!.id,
  });
  for (const stale of staleEnvironments.filter(({ name }) => name.startsWith("mail-"))) {
    await invoke("stop_environment", { environmentId: stale.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: stale.id }).catch(() => undefined);
  }
  const previousSettings = await invoke<AgentMessagingSettings>("get_agent_messaging_settings");
  const suffix = Date.now();
  const sender = await invoke<Environment>("create_environment", {
    projectId: fixture!.id,
    name: `mail-sender-${suffix}`,
    networkAccessMode: "restricted",
    environmentType: "local",
  });
  const recipient = await invoke<Environment>("create_environment", {
    projectId: fixture!.id,
    name: `mail-recipient-${suffix}`,
    networkAccessMode: "restricted",
    environmentType: "local",
  });
  const senderTabId = "mail-sender-agent";
  const recipientTabId = "mail-recipient-agent";
  try {
    await invoke("update_agent_messaging_settings", {
      settings: {
        ...previousSettings,
        enabled: true,
        paused: false,
        defaultInjectPolicy: "off",
      },
    });
    for (const [environment, tabId] of [
      [sender, senderTabId],
      [recipient, recipientTabId],
    ] as const) {
      await invoke("start_environment", { environmentId: environment.id });
      const currentLayout = await invoke<{ revision?: number } | null>("get_pane_layout", {
        environmentId: environment.id,
      });
      await invoke("save_pane_layout", {
        environmentId: environment.id,
        expectedRevision: currentLayout?.revision ?? 0,
        layout: {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "pane-mail",
          root: {
            kind: "leaf",
            id: "pane-mail",
            tabs: [
              {
                id: tabId,
                type: "agent-native",
                nativeAgentData: { environmentId: environment.id, platform: "claude" },
              },
            ],
            activeTabId: tabId,
          },
        },
      });
    }

    await page.goto(status.browserUrl!);
    const expandProject = page.getByRole("button", { name: `Expand project ${fixture!.name}` });
    await expect(expandProject).toBeVisible({ timeout: 30_000 });
    await expandProject.click();
    await page.getByText(sender.name, { exact: true }).first().click();
    await expect(page.getByText(sender.name, { exact: true }).first()).toBeVisible();
    await invoke("send_agent_mail", {
      requestId: `browser-mail-${suffix}`,
      toEnvironmentId: recipient.id,
      toTabId: recipientTabId,
      subject: "Inactive recipient",
      body: "This message arrived while the recipient environment was inactive.",
    });

    await page.getByText(recipient.name, { exact: true }).first().click();
    await expect(page.getByText("1 message in inbox · pull only")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("button", { name: "Agent messages", exact: true })).toBeVisible();

    await page.reload();
    const expandAfterReload = page.getByRole("button", {
      name: `Expand project ${fixture!.name}`,
    });
    await expect(expandAfterReload).toBeVisible({ timeout: 30_000 });
    await expandAfterReload.click();
    await page.getByText(recipient.name, { exact: true }).first().click();
    await expect(page.getByText("1 message in inbox · pull only")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("button", { name: "Agent messages", exact: true })).toBeVisible();
    // A committed send whose response is lost must retain its draft and retry
    // key across both list navigation and closing the panel.
    const openConversation = async () => {
      await page.getByRole("button", { name: "Agent messages", exact: true }).click();
      await page.getByTestId("agent-mail-conversation-row").first().click();
    };
    await openConversation();
    const panel = page.getByTestId("agent-mail-panel");
    await panel.getByPlaceholder("Subject (optional)").fill("Retry receipt");
    await panel.locator("textarea").fill("A draft retained across panel navigation.");
    await panel.getByRole("button", { name: "Back to conversations" }).click();
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await openConversation();
    await expect(panel.locator("textarea")).toHaveValue(
      "A draft retained across panel navigation.",
    );
    await expect(panel.getByPlaceholder("Subject (optional)")).toHaveValue("Retry receipt");
    let lost = false;
    const requestIds: string[] = [];
    await page.route("**/__orkestrator/invoke", async (route) => {
      const request = route.request().postDataJSON() as {
        command?: string;
        args?: { requestId?: string };
      };
      if (request.command !== "send_agent_mail") return route.continue();
      requestIds.push(request.args?.requestId ?? "");
      if (lost) return route.continue();
      lost = true;
      await route.fetch();
      await route.abort("failed");
    });
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Message was not sent", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByText(sender.name, { exact: true }).first().click();
    await page.getByText(recipient.name, { exact: true }).first().click();
    await page.setViewportSize({ width: 390, height: 844 });
    await openConversation();
    await expect(panel.locator("textarea")).toHaveValue(
      "A draft retained across panel navigation.",
    );
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await expect(panel.locator("textarea")).toHaveValue("");
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).toBeTruthy();
    expect(requestIds[1]).toBe(requestIds[0]);
    const sentMailbox = await invoke<{ messages: Array<{ subject?: string }> }>(
      "get_agent_mail_mailbox",
      {
        environmentId: recipient.id,
        tabId: recipientTabId,
      },
    );
    expect(sentMailbox.messages.filter(({ subject }) => subject === "Retry receipt")).toHaveLength(
      1,
    );
    await page.unroute("**/__orkestrator/invoke");
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    const deliverNow = page.getByRole("button", { name: "Deliver now", exact: true });
    await expect(deliverNow).toBeVisible();
    const bounds = await deliverNow.boundingBox();
    expect(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390).toBe(true);
    // Release only this message under inherited Off. Reload and switching
    // environments must preserve the authoritative per-tab policy.
    await page.getByRole("button", { name: "Deliver now", exact: true }).click();
    const mailbox = () =>
      invoke<{
        descriptor: { injectPolicy: string; injectOverride: string };
        messages: Array<{ userReleasedAt?: string }>;
      }>("get_agent_mail_mailbox", { environmentId: recipient.id, tabId: recipientTabId });
    await expect
      .poll(async () =>
        (await mailbox()).messages.some((message) => Boolean(message.userReleasedAt)),
      )
      .toBe(true);
    expect((await mailbox()).descriptor).toMatchObject({
      injectPolicy: "off",
      injectOverride: "inherit",
    });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByText(sender.name, { exact: true }).first().click();
    await page.getByText(recipient.name, { exact: true }).first().click();
    await page.reload();
    expect((await mailbox()).descriptor).toMatchObject({
      injectPolicy: "off",
      injectOverride: "inherit",
    });
  } finally {
    await invoke("update_agent_messaging_settings", { settings: previousSettings }).catch(
      () => undefined,
    );
    for (const environment of [sender, recipient]) {
      await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
      await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
    }
  }
});

test("coordinator Multi Review action reconciles a mounted renderer and survives inactive cancellation and reload", async ({
  page,
}) => {
  test.skip(
    process.env.ORKESTRATOR_AGENT_TEST_REVIEW !== "1",
    "opt-in live review against the isolated fixture",
  );
  test.setTimeout(180_000);
  const status = await profileStatus();
  expect(status.status).toBe("ready");
  const invoke = await authenticatedInvoke(page, status);
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === status.testProject,
  );
  expect(fixture).toBeTruthy();
  const coordinator = await invoke<{
    workspace: { id: string; conversations: Array<{ id: string }> };
  }>("ensure_project_coordinator", { projectId: fixture!.id });
  const scope = {
    projectId: fixture!.id,
    coordinatorId: coordinator.workspace.id,
    conversationId: coordinator.workspace.conversations[0]!.id,
  };
  const environments: Environment[] = [];
  try {
    for (const name of ["review-action", "review-inactive"]) {
      const environment = await invoke<Environment>("create_environment", {
        projectId: fixture!.id,
        name: `${name}-${Date.now()}`,
        environmentType: "local",
        networkAccessMode: "restricted",
      });
      environments.push(environment);
      await invoke("start_environment", { environmentId: environment.id });
    }
    const [target, other] = environments;
    await page.goto(status.browserUrl!);
    const expand = page.getByRole("button", { name: `Expand project ${fixture!.name}` });
    await expect(expand).toBeVisible({ timeout: 30_000 });
    await expand.click();
    await page.getByText(target!.name, { exact: true }).first().click();
    const input = {
      requestId: `browser-review-${target!.id}`,
      environmentId: target!.id,
      reviewers: [{ agent: "codex", model: "default" }],
      fixModel: { agent: "codex", model: "default" },
    };
    const launched = await invoke<MultiReviewActionResult>(
      "launch_coordinator_multi_review_action",
      { scope, input },
    );
    expect(launched.outcome).toBe("opened");
    await expect(page.getByRole("heading", { name: "Multi Review", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    const retried = await invoke<MultiReviewActionResult>(
      "launch_coordinator_multi_review_action",
      { scope, input },
    );
    expect(retried.workflow.id).toBe(launched.workflow.id);
    expect(retried.ui.tabId).toBe(launched.ui.tabId);
    await expect
      .poll(
        async () => {
          const saved = await invoke<{ snapshot: MultiReviewWorkflow }>(
            "get_multi_review_workflow",
            { workflowId: launched.workflow.id },
          );
          if (saved.snapshot.phase === "failed")
            throw new Error(saved.snapshot.error ?? "Preparation failed");
          return saved.snapshot.validationRun?.status;
        },
        { timeout: 90_000 },
      )
      .toBeDefined();
    await expect(page.getByRole("region", { name: "Review validation" })).toBeVisible();
    // Leave the previous row before crossing the sidebar's hover-detail card.
    await page.mouse.move(1100, 20);
    await page.getByText(other!.name, { exact: true }).first().click({ timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "Multi Review", exact: true })).toHaveCount(0);
    await expect
      .poll(
        async () => {
          const saved = await invoke<{ snapshot: MultiReviewWorkflow }>(
            "get_multi_review_workflow",
            { workflowId: launched.workflow.id },
          );
          return saved.snapshot.validationRun?.status;
        },
        { timeout: 30_000 },
      )
      .toBe("completed");
    await invoke("cancel_multi_review", { workflowId: launched.workflow.id });
    await expect
      .poll(
        async () => {
          const saved = await invoke<{ snapshot: MultiReviewWorkflow }>(
            "get_multi_review_workflow",
            { workflowId: launched.workflow.id },
          );
          return saved.snapshot.phase;
        },
        { timeout: 60_000 },
      )
      .toBe("cancelled");
    await page.mouse.move(1100, 20);
    await page.getByText(target!.name, { exact: true }).first().click({ timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "Multi Review", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/^Multi Review cancelled\b/).first()).toBeVisible();
    await page.reload();
    const expandAgain = page.getByRole("button", { name: `Expand project ${fixture!.name}` });
    await expect(expandAgain).toBeVisible({ timeout: 30_000 });
    await expandAgain.click();
    await page.getByText(target!.name, { exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "Multi Review", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/^Multi Review cancelled\b/).first()).toBeVisible();
    const opened = await invoke<MultiReviewActionResult>("open_coordinator_multi_review", {
      scope,
      workflowId: launched.workflow.id,
    });
    expect(opened.ui.tabId).toBe(launched.ui.tabId);
  } finally {
    for (const environment of environments) {
      await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
      await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
    }
  }
});

test("Docker fixture boots and restarts with access-only Codex and Grok imports", async () => {
  test.skip(process.env.ORKESTRATOR_AGENT_TEST_DOCKER !== "1", "requires a development image");
  const runtime = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: profile,
    flavor: "agent-test",
  });
  const root = await fs.mkdtemp(path.join(tmpdir(), "ork-access-only-boot-"));
  let containerId: string | undefined;
  const docker = (args: string[]) => {
    const result = spawnSync("docker", args, { encoding: "utf8", timeout: 30_000 });
    expect(result.error, "Docker command did not complete").toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  try {
    for (const provider of ["codex", "grok"]) await fs.mkdir(path.join(root, provider));
    const codex = JSON.stringify({ tokens: { access_token: "fixture-access", refresh_token: "" } });
    const grok = JSON.stringify({
      live: { key: "fixture-access", refresh_token: "", expires_at: "2099-01-01T00:00:00Z" },
    });
    await fs.writeFile(path.join(root, "codex/auth.json"), codex, { mode: 0o600 });
    await fs.writeFile(path.join(root, "grok/auth.json"), grok, { mode: 0o600 });
    containerId = docker([
      "create",
      "--network",
      "none",
      "--env",
      "NETWORK_MODE=full",
      "--label",
      "app=orkestrator-v2",
      "--label",
      `orkestrator-owner=access-only-${profile}`,
      "--mount",
      `type=bind,source=${root}/codex,target=/codex-home,readonly`,
      "--mount",
      `type=bind,source=${root}/grok,target=/grok-home,readonly`,
      runtime.dockerImage,
    ]);
    for (let boot = 0; boot < 2; boot++) {
      docker(["start", containerId]);
      await expect
        .poll(
          () =>
            docker([
              "exec",
              containerId!,
              "sh",
              "-c",
              "jq -r .phase /run/orkestrator/boot-status.json 2>/dev/null || true",
            ]),
          { timeout: 60_000 },
        )
        .toBe("ready");
      // Only content-free assertions leave the container; no login is printed.
      docker([
        "exec",
        containerId,
        "bash",
        "-euc",
        `
        test "$(stat -c %a "$HOME/.codex/auth.json")" = 600
        test "$(stat -c %a "$HOME/.grok/auth.json")" = 600
        jq -e '.tokens.access_token == "fixture-access" and .tokens.refresh_token == "" and (.last_refresh | type == "string")' "$HOME/.codex/auth.json" >/dev/null
        jq -e '.live.key == "fixture-access" and .live.refresh_token == ""' "$HOME/.grok/auth.json" >/dev/null
        test -f /tmp/.entrypoint-complete
      `,
      ]);
      docker(["stop", "--time", "1", containerId]);
    }
    expect(await fs.readFile(path.join(root, "codex/auth.json"), "utf8")).toBe(codex);
    expect(await fs.readFile(path.join(root, "grok/auth.json"), "utf8")).toBe(grok);
  } finally {
    if (containerId) docker(["rm", "--force", containerId]);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Docker fixture prepare-only trusts a differently owned origin before cloning as node", () => {
  test.skip(process.env.ORKESTRATOR_AGENT_TEST_DOCKER !== "1", "requires a development image");
  const runtime = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: profile,
    flavor: "agent-test",
  });
  const created = spawnSync(
    "docker",
    [
      "create",
      "--network",
      "none",
      "--label",
      "app=orkestrator-v2",
      "--label",
      `orkestrator-owner=prepare-only-${profile}`,
      "--user",
      "root",
      "--mount",
      `type=bind,source=${path.join(repositoryRoot, "docker")},target=/setup-under-test,readonly`,
      "--entrypoint",
      "bash",
      runtime.dockerImage,
      "-euc",
      `
# Build a committed root-owned origin and an empty workspace owned by node.
mkdir -p /tmp/fixture-seed /tmp/prepare-home /workspace /run/orkestrator
git -C /tmp/fixture-seed init --initial-branch=main
printf 'fixture contents\\n' > /tmp/fixture-seed/tracked.txt
printf '%s\\n' '{"setupContainer":"touch /workspace/setup-ran"}' > /tmp/fixture-seed/orkestrator-ai.json
git -C /tmp/fixture-seed add .
git -C /tmp/fixture-seed -c user.name=Fixture -c user.email=fixture@example.invalid commit -m fixture
git clone --bare /tmp/fixture-seed /orkestrator-agent-test-origin.git
chown -R node:node /workspace /tmp/prepare-home
touch /tmp/prepare-home/.claude.json
chown node:node /tmp/prepare-home/.claude.json
jq -n --arg start "$(awk '{print $22}' /proc/1/stat)" '{pid1Start:$start,phase:"ready"}' > /run/orkestrator/boot-status.json

as_node() {
    /usr/sbin/runuser -u node -- env -i HOME=/tmp/prepare-home PATH=/usr/local/bin:/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 "$@"
}
test "$(stat -c %u /orkestrator-agent-test-origin.git)" != "$(id -u node)"
# Prove ownership protection is active before exercising the real setup script.
if as_node git clone /orkestrator-agent-test-origin.git /tmp/untrusted-clone > /tmp/clone-denied.log 2>&1; then
    echo 'Expected the untrusted clone to be refused' >&2
    exit 1
fi
grep -q 'dubious ownership' /tmp/clone-denied.log

as_node env ORKESTRATOR_AGENT_TEST_GIT_REMOTE=/orkestrator-agent-test-origin.git GIT_URL=/orkestrator-agent-test-origin.git GIT_BRANCH=main bash /setup-under-test/workspace-setup.sh --prepare-only
test "$(as_node git config --global --get-all safe.directory)" = /orkestrator-agent-test-origin.git
test "$(as_node git -C /workspace rev-parse HEAD)" = "$(git -C /tmp/fixture-seed rev-parse HEAD)"
test "$(cat /workspace/tracked.txt)" = 'fixture contents'
test "$(stat -c %u /workspace/.git)" = "$(id -u node)"
test ! -e /workspace/setup-ran
test ! -e /tmp/.workspace-setup-complete
`,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  expect(created.status, created.stderr).toBe(0);
  const containerId = created.stdout.trim();
  expect(containerId).toBeTruthy();
  try {
    const prepared = spawnSync("docker", ["start", "--attach", containerId], {
      encoding: "utf8",
      timeout: 60_000,
      killSignal: "SIGKILL",
    });
    expect(prepared.error, prepared.stderr).toBeUndefined();
    expect(prepared.status, `${prepared.stdout}\n${prepared.stderr}`).toBe(0);
    const exited = spawnSync(
      "docker",
      ["inspect", "--format", "{{.State.ExitCode}}", containerId],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(exited.status, exited.stderr).toBe(0);
    expect(exited.stdout.trim(), `${prepared.stdout}\n${prepared.stderr}`).toBe("0");
    expect(prepared.stdout).toContain("Clone successful!");
    expect(prepared.stderr).not.toContain("dubious ownership");
    expect(prepared.stdout).toContain("ORKESTRATOR_PREPARE_OK");
    expect(prepared.stdout).not.toContain("=== Running Container Setup ===");
  } finally {
    const removed = spawnSync("docker", ["rm", "--force", containerId], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(removed.status, removed.stderr).toBe(0);
  }
});

test("Docker fixture rejects containers owned by another profile", async ({ page }) => {
  test.skip(
    process.env.ORKESTRATOR_AGENT_TEST_DOCKER !== "1",
    "requires an agent-test profile seeded with a container fixture",
  );

  const status = await profileStatus();
  expect(status.status).toBe("ready");
  expect(status.browserUrl).toBeTruthy();
  expect(status.authFile).toBeTruthy();
  expect(status.testProject).toBeTruthy();
  const invoke = await authenticatedInvoke(page, status);
  const projects = await invoke<Project[]>("get_projects");
  const fixture = projects.find((project) => project.localPath === status.testProject);
  expect(fixture).toBeTruthy();
  const environments = await invoke<Environment[]>("get_environments", { projectId: fixture!.id });
  const containerFixture = environments.find(
    (environment) => environment.name === "fixture-container",
  );
  expect(containerFixture?.containerId).toBeTruthy();
  expect(containerFixture?.status).toBe("running");

  const runtime = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: profile,
    flavor: "agent-test",
  });
  const foreign = spawnSync(
    "docker",
    [
      "create",
      "--label",
      "app=orkestrator-v2",
      "--label",
      "orkestrator-owner=foreign-agent-test-profile",
      runtime.dockerImage,
      "true",
    ],
    { encoding: "utf8" },
  );
  expect(foreign.status, foreign.stderr).toBe(0);
  const foreignContainerId = foreign.stdout.trim();
  expect(foreignContainerId).toBeTruthy();
  try {
    const response = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl!).href,
      {
        data: { command: "get_container_logs", args: { containerId: foreignContainerId } },
      },
    );
    expect(response.ok()).toBe(false);
    expect(await response.text()).toContain("not owned by this development profile");

    const ownedLogs = await invoke<string>("get_container_logs", {
      containerId: containerFixture!.containerId,
      tail: "1",
    });
    expect(typeof ownedLogs).toBe("string");

    const terminal = await invoke<{ sessionId: string }>("create_terminal_session", {
      containerId: containerFixture!.containerId,
      environmentId: containerFixture!.id,
      terminalKey: "agent-docker-history",
      cols: 80,
      rows: 24,
      trackEnvironmentActivity: true,
    });
    try {
      await invoke("start_terminal_session", { sessionId: terminal.sessionId });
      await invoke("terminal_write", {
        sessionId: terminal.sessionId,
        data: "sleep 1; printf 'docker-background-done\\n'\n",
      });
      await invoke("get_projects");
      await expect
        .poll(
          async () => {
            const snapshot = await invoke<{ output: string } | null>(
              "get_terminal_state_snapshot",
              { sessionId: terminal.sessionId },
            );
            return snapshot?.output.includes("docker-background-done") ?? false;
          },
          { timeout: 30_000 },
        )
        .toBe(true);
    } finally {
      await invoke("detach_terminal", { sessionId: terminal.sessionId }).catch(() => undefined);
    }
  } finally {
    spawnSync("docker", ["rm", "-f", foreignContainerId], { encoding: "utf8" });
  }
});

test("Docker fixture deletion removes only the target container, volumes, network and ledger entry", async ({
  page,
}) => {
  test.skip(
    process.env.ORKESTRATOR_AGENT_TEST_DOCKER !== "1",
    "requires an agent-test profile seeded with a container fixture",
  );
  test.setTimeout(300_000);

  const status = await profileStatus();
  expect(status.status).toBe("ready");
  const invoke = await authenticatedInvoke(page, status);
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === status.testProject,
  );
  expect(fixture).toBeTruthy();
  const runtime = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: profile,
    flavor: "agent-test",
  });
  const owned = (kind: "container" | "volume" | "network", environmentId: string) => {
    const filter = `label=environment-id=${environmentId}`;
    const args =
      kind === "container"
        ? ["ps", "-aq", "--filter", filter]
        : [kind, "ls", "-q", "--filter", filter];
    const result = spawnSync("docker", args, { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.split("\n").filter(Boolean).sort();
  };
  const containerFixture = (
    await invoke<Environment[]>("get_environments", {
      projectId: fixture!.id,
    })
  ).find((environment) => environment.name === "fixture-container");
  expect(containerFixture?.containerId).toBeTruthy();
  expect(containerFixture?.status).toBe("running");
  const fixtureResources = {
    containers: owned("container", containerFixture!.id),
    volumes: owned("volume", containerFixture!.id),
    networks: owned("network", containerFixture!.id),
  };
  for (const resources of Object.values(fixtureResources)) {
    expect(resources).not.toHaveLength(0);
  }
  const environment = await invoke<Environment>("create_environment", {
    projectId: fixture!.id,
    name: `delete-container-${Date.now()}`,
    networkAccessMode: "restricted",
    environmentType: "containerized",
  });
  try {
    await invoke("start_environment", { environmentId: environment.id });
    const active = await invoke<Environment>("get_environment", { environmentId: environment.id });
    expect(active.containerId).toBeTruthy();
    expect(owned("container", environment.id)).not.toHaveLength(0);
    expect(owned("volume", environment.id)).not.toHaveLength(0);
    expect(owned("network", environment.id)).not.toHaveLength(0);

    await invoke("delete_environment", { environmentId: environment.id });
    expect(
      await invoke<Environment | null>("get_environment", { environmentId: environment.id }),
    ).toBeNull();
    expect(owned("container", environment.id)).toEqual([]);
    expect(owned("volume", environment.id)).toEqual([]);
    expect(owned("network", environment.id)).toEqual([]);
    expect(pendingCleanupEnvironmentIds(runtime.dataDir)).not.toContain(environment.id);

    const retainedFixture = await invoke<Environment>("get_environment", {
      environmentId: containerFixture!.id,
    });
    expect(retainedFixture.containerId).toBe(containerFixture!.containerId);
    expect(retainedFixture.status).toBe("running");
    expect(owned("container", containerFixture!.id)).toEqual(fixtureResources.containers);
    expect(owned("volume", containerFixture!.id)).toEqual(fixtureResources.volumes);
    expect(owned("network", containerFixture!.id)).toEqual(fixtureResources.networks);
    const running = spawnSync(
      "docker",
      ["inspect", "--format", "{{.State.Running}}", containerFixture!.containerId!],
      { encoding: "utf8" },
    );
    expect(running.status, running.stderr).toBe(0);
    expect(running.stdout.trim()).toBe("true");
  } finally {
    await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
  }
});

test("Docker fixture ships a Playwright browser that launches for both container users", async ({
  page,
}) => {
  test.skip(
    process.env.ORKESTRATOR_AGENT_TEST_DOCKER !== "1",
    "requires an agent-test profile seeded with a container fixture",
  );
  // Chromium's first launch pays for process startup in a cold container.
  test.setTimeout(180_000);

  const status = await profileStatus();
  expect(status.status).toBe("ready");
  const invoke = await authenticatedInvoke(page, status);
  const projects = await invoke<Project[]>("get_projects");
  const fixture = projects.find((project) => project.localPath === status.testProject);
  expect(fixture).toBeTruthy();
  const environments = await invoke<Environment[]>("get_environments", { projectId: fixture!.id });
  const containerFixture = environments.find(
    (environment) => environment.name === "fixture-container",
  );
  expect(containerFixture?.containerId).toBeTruthy();
  expect(containerFixture?.status).toBe("running");
  const containerId = containerFixture!.containerId!;

  // Chromium puts renderer shared memory in /dev/shm. Docker's 64MB default is
  // well under what a real page needs and fails as a mid-run renderer crash, so
  // assert the mount the container was actually created with rather than the
  // argv that asked for it.
  const shm = spawnSync(
    "docker",
    ["exec", containerId, "sh", "-c", "df -k /dev/shm | awk 'NR==2 {print $2}'"],
    { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" },
  );
  expect(shm.error, shm.stderr).toBeUndefined();
  expect(shm.status, shm.stderr).toBe(0);
  const shmMegabytes = Number(shm.stdout.trim()) / 1024;
  expect(shmMegabytes).toBeGreaterThanOrEqual(512);

  // The image build proves the browser starts at build time; this proves it in a
  // running container, where the firewall is up and the workspace is mounted —
  // and for both identities, because Chromium refuses to run as uid 0 unless
  // Playwright's default `chromiumSandbox: false` supplies --no-sandbox.
  for (const user of ["node", "orkroot"]) {
    const launch = spawnSync(
      "docker",
      [
        "exec",
        "-u",
        user,
        "-e",
        "NODE_PATH=/usr/local/share/npm-global/lib/node_modules",
        containerId,
        "node",
        "/usr/local/share/verify-playwright.cjs",
      ],
      { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" },
    );
    expect(launch.error, `${user}: ${launch.stderr}`).toBeUndefined();
    expect(launch.status, `${user}: ${launch.stderr}`).toBe(0);
    expect(launch.stdout).toContain("chromium launch verified");
  }
});

test("review validation queues across worktrees and runs while its environment is inactive", async ({
  page,
}) => {
  // The weight-2 blocker only fills a two-slot host. The one-shot runner gives
  // its profile that simulated scheduler; a manually started profile uses the
  // real host, where the second run starts at once instead of queueing.
  test.skip(
    !process.env.ORKESTRATOR_TEST_SCHEDULER_DIR ||
      process.env.ORKESTRATOR_TEST_HOST_WORKERS !== "2",
    "requires the simulated two-slot scheduler: use mise run test:agent:browser:isolated, or start dev:test and run this suite with ORKESTRATOR_TEST_SCHEDULER_DIR, ORKESTRATOR_TEST_HOST_WORKERS=2 and ORKESTRATOR_TEST_HOST_MEMORY_MIB=2048",
  );
  const status = await profileStatus();
  const invoke = await authenticatedInvoke(page, status);
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === status.testProject,
  )!;
  const environments: Environment[] = [];
  let run: ReviewValidationRun | undefined;
  let blocker: ReviewValidationRun | undefined;
  try {
    for (const name of ["validation-active", "validation-other"]) {
      const environment = await invoke<Environment>("create_environment", {
        projectId: fixture.id,
        name: `${name}-${Date.now()}`,
        environmentType: "local",
        networkAccessMode: "restricted",
      });
      environments.push(environment);
      await invoke("start_environment", { environmentId: environment.id });
    }
    const [target, other] = environments;
    await page.goto(status.browserUrl!);
    await page.getByRole("button", { name: `Expand project ${fixture.name}` }).click();
    await page.getByText(target!.name, { exact: true }).first().click();
    const snapshot = await invoke<{ head: string; paths: string[] }>(
      "get_environment_uncommitted_paths",
      { environmentId: target!.id },
    );
    expect(snapshot.paths).toEqual([]);
    const otherSnapshot = await invoke<{ head: string; paths: string[] }>(
      "get_environment_uncommitted_paths",
      { environmentId: other!.id },
    );
    blocker = newReviewValidationRun(`review-validation-blocker-${Date.now()}`, {
      headRef: otherSnapshot.head,
      limitations: [],
      commands: [
        {
          id: "host-capacity",
          command: "sleep 6",
          cwd: ".",
          dependsOn: [],
          resources: [],
          weight: 2,
          timeoutMs: 10000,
        },
      ],
    });
    blocker = await invoke<ReviewValidationRun>("start_review_validation", {
      environmentId: other!.id,
      run: blocker,
    });
    await expect
      .poll(async () => {
        blocker = await invoke<ReviewValidationRun>("status_review_validation", {
          environmentId: other!.id,
          run: blocker,
        });
        return blocker.results[0]!.status;
      })
      .toBe("running");
    run = newReviewValidationRun(`review-validation-browser-${Date.now()}`, {
      headRef: snapshot.head,
      limitations: [],
      commands: [
        {
          id: "first",
          command: "sleep 2; printf validated",
          cwd: ".",
          dependsOn: [],
          resources: [],
          weight: 1,
          timeoutMs: 10000,
        },
        {
          id: "second",
          command: "printf independent",
          cwd: ".",
          dependsOn: [],
          resources: [],
          weight: 1,
          timeoutMs: 10000,
        },
      ],
    });
    run = await invoke<ReviewValidationRun>("start_review_validation", {
      environmentId: target!.id,
      run,
    });
    await expect
      .poll(async () => {
        run = await invoke<ReviewValidationRun>("status_review_validation", {
          environmentId: target!.id,
          run,
        });
        return run.results[0]!.status;
      })
      .toBe("queued");
    await expect
      .poll(async () => {
        run = await invoke<ReviewValidationRun>("status_review_validation", {
          environmentId: target!.id,
          run,
        });
        return run.results[0]!.queueReason;
      })
      .toContain("slots");
    await page.mouse.move(1100, 20);
    await page.getByText(other!.name, { exact: true }).first().click();
    await expect
      .poll(
        async () => {
          run = await invoke<ReviewValidationRun>("status_review_validation", {
            environmentId: target!.id,
            run,
          });
          return run.status;
        },
        { timeout: 15000 },
      )
      .toBe("completed");
    expect(run.results.map((result) => result.status)).toEqual(["passed", "passed"]);
    expect(run.results[0]!.queuedMs).toBeGreaterThan(0);
    expect(run.results[0]!.queueReason).toBeUndefined();
    const completed = run;
    await page.reload();
    await page.getByRole("button", { name: `Expand project ${fixture.name}` }).click();
    await page.getByText(target!.name, { exact: true }).first().click();
    const restored = await invoke<ReviewValidationRun>("status_review_validation", {
      environmentId: target!.id,
      run,
    });
    expect(restored).toEqual(completed);
    expect(restored.results.every((result) => result.stdoutSha256?.length === 64)).toBe(true);
  } finally {
    if (blocker)
      await invoke("cancel_review_validation", {
        environmentId: environments[1]!.id,
        run: blocker,
      }).catch(() => undefined);
    if (run)
      await invoke("cancel_review_validation", { environmentId: environments[0]!.id, run }).catch(
        () => undefined,
      );
    for (const environment of environments) {
      await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
      await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
    }
  }
});

test("local environment move survives inactive navigation and reload", async ({ page }) => {
  const status = await profileStatus();
  const invoke = await authenticatedInvoke(page, status);
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === status.testProject,
  )!;
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(path.dirname(status.testProject!), "move-qa-")),
  );
  const environments: Environment[] = [];
  const accountHome = path.join(
    status.dataDir!,
    "agent-accounts",
    "codex",
    `move-fixture-${Date.now()}`,
  );
  try {
    for (const label of ["move-source", "move-other"]) {
      const environment = await invoke<Environment>("create_environment", {
        projectId: fixture.id,
        name: `${label}-${Date.now()}`,
        environmentType: "local",
        networkAccessMode: "restricted",
      });
      environments.push(environment);
      await invoke("start_environment", { environmentId: environment.id });
    }
    const [source, other] = environments;
    const original = (await invoke<Environment>("get_environment", { environmentId: source!.id }))
      .worktreePath!;
    await fs.writeFile(path.join(original, "move-preserved.txt"), "uncommitted fixture");
    const openSettings = async () => {
      const expand = page.getByRole("button", {
        name: `Expand project ${fixture.name}`,
        exact: true,
      });
      const entry = page.getByText(source!.name, { exact: true }).first();
      await expect(expand.or(entry)).toBeVisible({ timeout: 30_000 });
      if (await expand.isVisible()) await expand.click();
      await entry.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Destination folder" })).toBeVisible();
    };
    await page.reload();
    await openSettings();
    const destination = path.join(root, "first");
    await page.getByRole("textbox", { name: "Destination folder" }).fill(destination);
    await page.getByRole("button", { name: "Move…", exact: true }).click();
    await page.getByRole("button", { name: "Move", exact: true }).click();
    const firstPath = path.join(destination, path.basename(original));
    await expect
      .poll(
        async () =>
          (await invoke<Environment>("get_environment", { environmentId: source!.id }))
            .worktreePath,
      )
      .toBe(firstPath);
    await expect(page.getByRole("textbox", { name: "Destination folder" })).toHaveValue(
      destination,
    );
    await page.getByRole("textbox", { name: "Destination folder" }).fill(path.join(root, "third"));
    await expect(page.getByRole("button", { name: "Move…", exact: true })).toBeEnabled();
    await page.keyboard.press("Escape");
    // A corrupt record in this disposable profile's own account home forces
    // a real provider migration failure without involving any host credentials.
    const records = path.join(
      accountHome,
      "orkestrator-bridge",
      `bridge-sessions-${createHash("sha256").update(firstPath).digest("hex").slice(0, 16)}`,
    );
    await fs.mkdir(records, { recursive: true });
    await fs.writeFile(path.join(records, "corrupt.json"), "invalid fixture");
    await page.getByText(other!.name, { exact: true }).first().click();
    const nextDestination = path.join(root, "second");
    const moving = invoke<Environment>("move_environment", {
      environmentId: source!.id,
      destinationDir: nextDestination,
    });
    await page.reload();
    const moved = await moving;
    expect(moved.worktreePath).toBe(path.join(nextDestination, path.basename(original)));
    expect(await fs.readFile(path.join(moved.worktreePath!, "move-preserved.txt"), "utf8")).toBe(
      "uncommitted fixture",
    );
    await openSettings();
    await expect(page.getByRole("textbox", { name: "Destination folder" })).toHaveValue(
      nextDestination,
    );
    await expect(page.getByRole("button", { name: "Move…", exact: true })).toBeDisabled();
    await expect(
      page.getByRole("alert").filter({ hasText: "Codex conversations could not be relocated" }),
    ).toBeVisible();
    await page.getByRole("textbox", { name: "Destination folder" }).fill(path.join(root, "third"));
    await expect(page.getByRole("button", { name: "Move…", exact: true })).toBeDisabled();
  } finally {
    for (const environment of environments)
      await invoke("delete_environment", { environmentId: environment.id });
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(accountHome, { recursive: true, force: true });
  }
});

for (const width of [1280, 390]) {
  test(`host maintenance rehydrates task completion while Settings is closed (${width}px)`, async ({
    page,
  }) => {
    page.setDefaultTimeout(15_000);
    const status = await profileStatus();
    expect(status.status).toBe("ready");
    const invoke = await authenticatedInvoke(page, status);
    const projects = await invoke<Project[]>("get_projects");
    const fixture = projects.find((project) => project.localPath === status.testProject)!;
    expect(fixture).toBeTruthy();
    await page.setViewportSize({ width, height: 900 });
    const openUpdates = async () => {
      const globalSettings = page.getByRole("button", { name: "Global settings", exact: true });
      if (width < 768 && !(await globalSettings.isVisible())) {
        const openDrawer = page.getByRole("button", { name: "Open projects and environments" });
        const closeDrawer = page
          .getByRole("button", { name: "Close projects and environments" })
          .first();
        await expect(openDrawer.or(closeDrawer).first()).toBeVisible();
        const drawer = page.getByRole("dialog", { name: "Projects and environments", exact: true });
        if (await drawer.isVisible()) {
          await drawer.getByRole("button", { name: fixture.name, exact: true }).click();
          if (await drawer.isVisible())
            await drawer
              .getByRole("button", { name: "Close projects and environments" })
              .first()
              .click();
          await expect(drawer).toBeHidden();
        }
        // Selecting the project rehydrates its context and closes the tools
        // popover. Open it after that reconciliation has finished.
        await expect(async () => {
          if (!(await globalSettings.isVisible())) {
            await page.getByRole("button", { name: "Open tools", exact: true }).click();
          }
          await globalSettings.click({ timeout: 1_000 });
          await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
        }).toPass({ timeout: 15_000 });
      } else {
        await globalSettings.click();
      }
      const settings = page.getByRole("dialog", { name: "Settings", exact: true });
      const section = settings.getByRole("combobox", { name: "Settings section", exact: true });
      if (await section.isVisible()) {
        await section.click();
        await page.getByRole("option", { name: "Updates", exact: true }).click();
      } else {
        await settings.getByRole("button", { name: "Updates", exact: true }).click();
      }
      await expect(
        settings.getByRole("heading", { name: "Agent tools", exact: true }),
      ).toBeVisible();
      return settings;
    };
    let settings = await openUpdates();
    await settings.getByRole("button", { name: "Close settings" }).click();
    const task = await invoke<{ id: string }>("set_host_gh_channel", { channel: "pinned" });
    await expect
      .poll(async () => {
        const snapshot = await invoke<{ tasks: Record<string, { id: string; state: string }> }>(
          "get_host_maintenance",
          { detail: true },
        );
        return snapshot.tasks["gh-update"]?.id === task.id
          ? snapshot.tasks["gh-update"].state
          : "missing";
      })
      .toBe("succeeded");
    settings = await openUpdates();
    await expect(settings.getByRole("status").filter({ hasText: /^Done/ })).toBeVisible();
    await settings.getByRole("button", { name: "Close settings" }).click();
    await page.reload();
    settings = await openUpdates();
    await expect(settings.getByRole("status").filter({ hasText: /^Done/ })).toBeVisible();
    await expect(settings.getByRole("button", { name: "Repair agent tools" })).toBeEnabled();
  });
}

test("persisted diff baselines keep Files, the badge and diff tabs aligned after background changes and reload", async ({
  page,
}) => {
  page.setDefaultTimeout(15_000);
  const status = await profileStatus();
  expect(status.status).toBe("ready");
  await page.route("**/__orkestrator/invoke", async (route) => {
    if (route.request().postDataJSON()?.command === "check_claude_cli") {
      await route.fulfill({ json: { result: false } });
    } else await route.continue();
  });
  const invoke = await authenticatedInvoke(page, status);
  const projects = await invoke<Project[]>("get_projects");
  const fixture = projects.find((project) => project.localPath === status.testProject)!;
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync(
      "git",
      ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=t@e.invalid", ...args],
      { encoding: "utf8" },
    );
    if (result.status !== 0) throw new Error(result.stderr || "fixture git command failed");
    return result.stdout.trim();
  };
  const created = git(fixture.localPath!, "rev-parse", "HEAD");
  const branch = `baseline-target-${Date.now()}`;
  const target = await fs.mkdtemp(path.join(path.dirname(status.testProject!), "baseline-target-"));
  const environments: Environment[] = [];
  try {
    git(fixture.localPath!, "worktree", "add", "-b", branch, target, created);
    for (const suffix of ["worker", "other"]) {
      const environment = await invoke<Environment>("create_environment", {
        projectId: fixture.id,
        name: `${branch}-${suffix}`,
        environmentType: "local",
        networkAccessMode: "restricted",
        delegationBaseBranch: branch,
        delegationBaseCommit: created,
      });
      environments.push(environment);
      await invoke("start_environment", { environmentId: environment.id });
      Object.assign(
        environment,
        await invoke<Environment>("get_environment", { environmentId: environment.id }),
      );
    }
    const [worker, other] = environments as [Environment, Environment];
    const checkout = worker.worktreePath!;
    await fs.writeFile(path.join(checkout, "baseline-own.txt"), "worker\n");
    git(checkout, "add", "baseline-own.txt");
    git(checkout, "commit", "-m", "worker changes");
    await page.reload();
    const openWorker = async () => {
      const expand = page.getByRole("button", {
        name: `Expand project ${fixture.name}`,
        exact: true,
      });
      const entry = page.getByText(worker.name, { exact: true }).first();
      await expect(expand.or(entry)).toBeVisible({ timeout: 30_000 });
      if (await expand.isVisible()) await expand.click();
      await entry.click();
      const showFiles = page.getByRole("button", { name: "Show file panel", exact: true });
      if (await showFiles.isVisible()) await showFiles.click();
      await page.getByRole("tab", { name: /^Changes(?: \d+)?$/ }).click();
    };
    const own = page.locator('button[title="baseline-own.txt"]');
    const imported = page.locator('button[title="baseline-imported.txt"]');
    await openWorker();
    await expect(own).toBeVisible();
    await page.getByText(other.name, { exact: true }).first().click();
    await fs.writeFile(path.join(target, "baseline-imported.txt"), "upstream\n");
    git(target, "add", "baseline-imported.txt");
    git(target, "commit", "-m", "imported history");
    const tip = git(target, "rev-parse", "HEAD");
    git(checkout, "merge", "--no-edit", branch);
    type BaselineEnvironment = Environment & { diffBaseline?: { commit: string } | null };
    await expect
      .poll(
        async () =>
          (await invoke<BaselineEnvironment>("get_environment", { environmentId: worker.id }))
            .diffBaseline?.commit,
        { timeout: 15_000 },
      )
      .toBe(tip);
    await openWorker();
    await expect(own).toBeVisible();
    await expect(imported).toHaveCount(0);
    const row = page
      .getByRole("button")
      .filter({ has: page.getByText(worker.name, { exact: true }) });
    await expect(row.getByText("+1", { exact: true })).toBeVisible();
    await own.click();
    await expect(page.getByTestId("diff-viewer-endpoints")).toHaveAttribute(
      "title",
      `${tip}@${tip} → Current workspace file`,
    );
    await page.reload();
    await openWorker();
    await expect(own).toBeVisible();
    await expect(imported).toHaveCount(0);
    await own.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Revert", exact: true }).click();
    const confirm = page.getByRole("alertdialog", { name: "Revert file?" });
    await expect(confirm).toContainText(tip);
    await confirm.getByRole("button", { name: "Revert", exact: true }).click();
    await expect(page.getByText("No changes", { exact: true })).toBeVisible();
    expect(await fs.readFile(path.join(checkout, "baseline-imported.txt"), "utf8")).toBe(
      "upstream\n",
    );
    await expect(row.getByText("+1", { exact: true })).toHaveCount(0);
    git(checkout, "reset", "--hard", created);
    await expect
      .poll(
        async () =>
          (await invoke<BaselineEnvironment>("get_environment", { environmentId: worker.id }))
            .diffBaseline,
        { timeout: 15_000 },
      )
      .toBeNull();
    await page.reload();
    await openWorker();
    await expect(page.getByText("No changes", { exact: true })).toBeVisible();
  } finally {
    for (const environment of environments) {
      await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
      await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
    }
    git(fixture.localPath!, "worktree", "remove", "--force", target);
    git(fixture.localPath!, "branch", "-D", branch);
    await fs.rm(target, { recursive: true, force: true });
  }
});

test("Docker fixture consumes command-only seed files and deletes secret staging", async ({
  page,
}) => {
  test.skip(
    process.env.ORKESTRATOR_AGENT_TEST_DOCKER !== "1",
    "requires a disposable container fixture",
  );
  test.setTimeout(300_000);
  const status = await profileStatus();
  expect(status.status).toBe("ready");
  const invoke = await authenticatedInvoke(page, status);
  const project = (await invoke<Project[]>("get_projects")).find(
    (entry) => entry.localPath === status.testProject,
  )!;
  const environment = await invoke<Environment>("create_environment", {
    projectId: project.id,
    name: `seed-regression-${Date.now()}`,
    environmentType: "containerized",
  });
  const runtime = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: profile,
    flavor: "agent-test",
  });
  const staging = path.join(runtime.dataDir, "node-seed", environment.id);
  const relativePath = ".env.review-seed";
  const content = "REVIEW_SEED=fixture-only\n";
  try {
    const upload = await invoke<{ uploadId: string }>("begin_node_file_write", {
      scope: { seedEnvironmentId: environment.id },
      path: relativePath,
      size: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
      overwrite: false,
    });
    await invoke("append_node_file_write", {
      uploadId: upload.uploadId,
      contentBase64: Buffer.from(content).toString("base64"),
    });
    await invoke("commit_node_file_write", { uploadId: upload.uploadId });
    await invoke("start_environment", { environmentId: environment.id });
    // Start returns once setup is launched; the workspace consumes seeds later.
    await expect
      .poll(
        async () => {
          const current = await invoke<Environment & { setupScriptsComplete?: boolean }>(
            "get_environment",
            { environmentId: environment.id },
          );
          return current.setupScriptsComplete === true;
        },
        { timeout: 120_000 },
      )
      .toBe(true);
    const active = await invoke<Environment>("get_environment", { environmentId: environment.id });
    expect(active.containerId).toBeTruthy();
    const copied = spawnSync(
      "docker",
      ["exec", "--user", "node", active.containerId!, "cat", `/workspace/${relativePath}`],
      { encoding: "utf8" },
    );
    expect(copied.status).toBe(0);
    expect(createHash("sha256").update(copied.stdout).digest("hex")).toBe(
      createHash("sha256").update(content).digest("hex"),
    );
    expect(
      await fs.stat(staging).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    // Deletion also clears staging that was never consumed by setup.
    await fs.mkdir(staging, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(staging, ".env"), content, { mode: 0o600 });
    await invoke("delete_environment", { environmentId: environment.id });
    expect(
      await fs.stat(staging).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
  }
});
