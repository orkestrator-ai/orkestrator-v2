import {
  newReviewValidationRun,
  type ReviewValidationRun,
} from "@orkestrator/protocol/review-workflow";
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createServer } from "node:net";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import { environmentCleanupLedger } from "../../apps/backend/src/core/environment-cleanup-ledger";
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
  const environment = await invoke<Environment>("create_environment", {
    projectId: fixture!.id,
    name: `delete-during-setup-${Date.now()}`,
    networkAccessMode: "restricted",
    environmentType: "local",
  });
  try {
    await invoke("start_environment", { environmentId: environment.id });
    const active = await invoke<Environment>("get_environment", { environmentId: environment.id });
    expect(active.worktreePath).toBeTruthy();
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
    for (const directory of environmentStateDirectories(runtime.dataDir, environment.id)) {
      await expect(fs.stat(directory)).rejects.toThrow();
    }
    const branch = spawnSync(
      "git",
      ["-C", fixture!.localPath!, "show-ref", "--verify", branchRef],
      { encoding: "utf8" },
    );
    expect(branch.status).not.toBe(0);
    expect(
      (await environmentCleanupLedger(runtime.dataDir).list()).some(
        (entry) => entry.environmentId === environment.id,
      ),
    ).toBe(false);
  } finally {
    await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
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
    await expect(
      page.getByRole("button", { name: "Agent inbox, 1 unseen", exact: true }),
    ).toBeVisible();

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
    await expect(
      page.getByRole("button", { name: "Agent inbox, 1 unseen", exact: true }),
    ).toBeVisible();
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
    await expect(page.getByText("Cancelled", { exact: true }).first()).toBeVisible();
    await page.reload();
    const expandAgain = page.getByRole("button", { name: `Expand project ${fixture!.name}` });
    await expect(expandAgain).toBeVisible({ timeout: 30_000 });
    await expandAgain.click();
    await page.getByText(target!.name, { exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "Multi Review", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("Cancelled", { exact: true }).first()).toBeVisible();
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
