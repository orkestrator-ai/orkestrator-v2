/**
 * A bulk restore driven through the restore dialog of a real `dev:test`
 * profile (todo 7555 task 2, retired; results in
 * docs/architecture/change-tracking.md, "Restore").
 *
 * One Claude turn on the profile's real CLI and bridge, answered by the
 * loopback model (`fake-anthropic-model.ts`, no billed turn), is held while
 * this process writes `ORKESTRATOR_AGENT_TEST_BULK_RESTORE_FILES` (default
 * 10,000) small files under `generated/` in the environment's worktree. Once
 * the turn ends, the spec opens "Turn changes", presses the turn's restore
 * button, waits for the preview, presses Restore and times until the dialog
 * reports the outcome. It then checks that no generated file is left.
 *
 * Opt-in (`ORKESTRATOR_AGENT_TEST_LIVE_BULK_RESTORE=1`), against a
 * credential-free profile of its own started with the host reachability check
 * off:
 *
 *   ORKESTRATOR_HOST_REACHABILITY_CHECK=off mise run dev:test --profile restore7555 \
 *     --fixture --no-agent-credentials --agent-platforms claude --headless
 *   ORKESTRATOR_AGENT_TEST_PROFILE=restore7555 ORKESTRATOR_AGENT_TEST_LIVE_BULK_RESTORE=1 \
 *     mise run test:logged -- --name bulk-restore -- \
 *     bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts \
 *     restore-apply-bulk-live.spec.ts --workers=1
 *
 * The fake model's settings are written into the profile's isolated Claude
 * home before the environment is created, so the environment's first Claude
 * process reads them; the previous file is put back afterwards. Timings,
 * counts and load averages go to `evidence-bulk-restore-*.json`; no token,
 * prompt or file content reaches output.
 */
import { spawnSync } from "node:child_process";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { expect, fetchModulesOutsideChromium, test, type Page } from "./browser-test";
import {
  answerFor,
  fakeModelClaudeSettings,
  startFakeAnthropicModel,
  type FakeAnthropicModel,
} from "./fake-anthropic-model";
import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";

type Status = {
  status: string;
  profile?: string;
  flavor?: string;
  browserUrl?: string;
  testProject?: string;
};
type Project = { id: string; name: string; localPath: string | null };
type Environment = { id: string; name: string; worktreePath?: string | null };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "restore7555";
const LIVE = process.env.ORKESTRATOR_AGENT_TEST_LIVE_BULK_RESTORE === "1";
const FILES = Math.max(1, Number(process.env.ORKESTRATOR_AGENT_TEST_BULK_RESTORE_FILES ?? "10000"));
const TAB_ID = "bulk-restore-claude";

test.skip(!LIVE, "Opt-in: ORKESTRATOR_AGENT_TEST_LIVE_BULK_RESTORE=1");

const evidence: Record<string, unknown> = { files: FILES };
const load = () => Math.round(loadavg()[0]! * 10) / 10;

function runtime() {
  return resolveRuntimeProfile({ repositoryRoot, requestedId: profile, flavor: "agent-test" });
}

function readyStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const status = JSON.parse(command.stdout || "{}") as Status;
  expect(status.profile, "dev:status answered for a different profile").toBe(profile);
  expect(status.status, `profile "${profile}" is not running`).toBe("ready");
  expect(status.flavor).toBe("agent-test");
  return status;
}

function mintLoginUrl(): string {
  // The one-shot login URL is parsed in memory and never copied into output.
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(command.stderr || "dev:login failed");
  const login = JSON.parse(command.stdout) as { loginUrl?: unknown };
  if (typeof login.loginUrl !== "string") throw new Error("dev:login returned no login URL");
  return login.loginUrl;
}

function invokeThrough(page: Page, gatewayUrl: string): Invoke {
  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await page.request.post(new URL("/__orkestrator/invoke", gatewayUrl).href, {
      data: { command, args },
      timeout: 0,
    });
    expect(response.ok(), `${command}: HTTP ${response.status()}`).toBe(true);
    return ((await response.json()) as { result: T }).result;
  };
}

async function seedClaudeTab(invoke: Invoke, environmentId: string): Promise<void> {
  const layout = await invoke<{ revision?: number } | null>("get_pane_layout", { environmentId });
  await invoke("save_pane_layout", {
    environmentId,
    expectedRevision: layout?.revision ?? 0,
    layout: {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "bulk-pane",
      root: {
        kind: "leaf",
        id: "bulk-pane",
        activeTabId: TAB_ID,
        tabs: [
          {
            id: TAB_ID,
            type: "agent-native",
            displayTitle: "Bulk restore qualification",
            nativeAgentData: { environmentId, platform: "claude", isLocal: true },
            initialAgentModel: "haiku",
          },
        ],
      },
    },
  });
}

function composer(page: Page) {
  return page
    .getByTestId("shared-native-compose-bar")
    .getByRole("textbox", { name: /^Message Claude/ });
}

/** Dismisses the startup notices a credential-free profile shows, then opens the row. */
async function openEnvironment(page: Page, fixtureName: string, environmentName: string) {
  const expand = page.getByRole("button", { name: `Expand project ${fixtureName}` });
  const entry = page.getByText(environmentName, { exact: true }).first();
  const dialog = page.getByRole("alertdialog");
  let quietSince = Date.now();
  for (const deadline = Date.now() + 90_000; Date.now() < deadline;) {
    for (const label of [
      "Continue Without Docker",
      "Continue Without GitHub CLI",
      "Continue Without Claude",
    ]) {
      const button = page.getByRole("button", { name: label, exact: true });
      if (await button.isVisible()) await button.click({ timeout: 5_000 }).catch(() => undefined);
    }
    if (await dialog.first().isVisible()) quietSince = Date.now();
    else if (!(await expand.or(entry).first().isVisible())) quietSince = Date.now();
    else if (Date.now() - quietSince >= 2_000) break;
    await page.waitForTimeout(200);
  }
  await expect(expand.or(entry).first()).toBeVisible({ timeout: 5_000 });
  if (await expand.isVisible()) await expand.click();
  await page.mouse.move(1100, 20);
  await entry.click({ timeout: 15_000 });
  await expect(composer(page)).toBeVisible({ timeout: 90_000 });
}

async function rowsWith(page: Page, needle: string): Promise<number> {
  return page
    .evaluate((wanted) => {
      let count = 0;
      for (const row of Array.from(document.querySelectorAll("[data-chat-message-index]"))) {
        if ((row.textContent ?? "").includes(wanted)) count += 1;
      }
      return count;
    }, needle)
    .catch(() => -1);
}

let model: FakeAnthropicModel;
let settingsPath: string;
let priorSettings: string | null = null;
let environment: Environment | undefined;
let invoke: Invoke | undefined;

test.afterAll(async () => {
  if (environment && invoke) {
    await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
  }
  await fs.writeFile(
    path.join(test.info().outputDir, "..", `evidence-bulk-restore-${Date.now()}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  if (settingsPath) {
    if (priorSettings === null) await fs.rm(settingsPath, { force: true });
    else await fs.writeFile(settingsPath, priorSettings);
  }
  await model?.stop();
});

test(`a ${FILES}-file restore answers in the restore dialog`, async ({ browser }) => {
  test.setTimeout(30 * 60_000);
  const status = readyStatus();
  model = await startFakeAnthropicModel(0);
  const claudeDir = path.join(runtime().dataDir, "agent-credentials", "claude");
  // The profile's own isolated Claude home, never a real one.
  expect(claudeDir.startsWith(runtime().profileRoot)).toBe(true);
  await fs.mkdir(claudeDir, { recursive: true });
  settingsPath = path.join(claudeDir, "settings.json");
  priorSettings = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null;
  await fs.writeFile(settingsPath, JSON.stringify(fakeModelClaudeSettings(model.origin)));

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await fetchModulesOutsideChromium(context);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const login = new URL(mintLoginUrl());
  const signedIn = await page.goto(
    new URL(`${login.pathname}${login.search}`, status.browserUrl!).href,
    { waitUntil: "domcontentloaded" },
  );
  expect(signedIn?.ok() ?? false, "sign-in").toBe(true);
  invoke = invokeThrough(page, status.browserUrl!);

  const testProject = status.testProject ?? path.join(runtime().fixtureDir, "test-project");
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === testProject,
  );
  expect(fixture, "the profile has no seeded fixture project").toBeTruthy();
  const created = await invoke<Environment>("create_environment", {
    projectId: fixture!.id,
    name: `bulk-restore-${Date.now()}`,
    environmentType: "local",
    networkAccessMode: "restricted",
  });
  environment = created;
  await invoke("start_environment", { environmentId: created.id });
  await expect
    .poll(
      async () =>
        (
          await invoke!<Environment & { status?: string }>("get_environment", {
            environmentId: created.id,
          })
        ).status,
      { timeout: 120_000 },
    )
    .toBe("running");
  environment = await invoke<Environment>("get_environment", { environmentId: created.id });
  const worktree = environment.worktreePath!;
  expect(worktree).toBeTruthy();
  await seedClaudeTab(invoke, created.id);

  await page.goto(status.browserUrl!, { waitUntil: "domcontentloaded" });
  await openEnvironment(page, fixture!.name, environment.name);

  // Hold the turn at "the provider is working" while the files appear.
  const prompt = "Write the bulk fixture [hold:bulk7555]";
  await composer(page).fill(prompt);
  await composer(page).press("Enter");
  await expect.poll(() => model.held(), { timeout: 120_000 }).toContain("bulk7555");
  const generated = path.join(worktree, "generated");
  await fs.mkdir(generated, { recursive: true });
  const writeStarted = Date.now();
  for (let index = 0; index < FILES; index += 500) {
    await Promise.all(
      Array.from({ length: Math.min(500, FILES - index) }, (_, offset) =>
        fs.writeFile(
          path.join(generated, `file${index + offset}.txt`),
          `generated ${index + offset}\n`,
        ),
      ),
    );
  }
  evidence.writeFilesMs = Date.now() - writeStarted;
  evidence.loadAtTurnEnd = load();
  const releasedAt = Date.now();
  model.release("bulk7555");
  await expect
    .poll(() => rowsWith(page, answerFor(prompt)), { timeout: 300_000 })
    .toBeGreaterThan(0);
  evidence.answerVisibleMs = Date.now() - releasedAt;

  // The turn's restore action appears once its final measurement is selected.
  const toggle = page.getByTestId("turn-changes-toggle");
  await expect(toggle).toBeVisible({ timeout: 300_000 });
  await toggle.click();
  const restoreButton = page
    .getByTestId("turn-changes-entry")
    .first()
    .getByTestId("restore-changes-button");
  const offeredAt = Date.now();
  await expect
    .poll(
      async () => {
        if (await restoreButton.isEnabled().catch(() => false)) return true;
        // Re-open the history so it re-reads a measurement finalized since.
        await toggle.click();
        await toggle.click();
        return false;
      },
      { timeout: 300_000, intervals: [2_000] },
    )
    .toBe(true);
  evidence.restoreOfferedMs = Date.now() - offeredAt;

  evidence.loadAtPreview = load();
  const previewStarted = Date.now();
  await restoreButton.click();
  const dialog = page.getByTestId("restore-preview");
  await expect(dialog).toBeVisible({ timeout: 600_000 });
  evidence.previewMs = Date.now() - previewStarted;
  const rows = dialog.locator("li");
  evidence.previewRows = await rows.count();
  evidence.previewDeletes = await dialog.locator("li", { hasText: /^delete/ }).count();
  await page.screenshot({ path: test.info().outputPath("restore-preview.png") });

  evidence.loadAtApply = load();
  const applyStarted = Date.now();
  await dialog.getByRole("button", { name: "Restore", exact: true }).click();
  const outcome = page
    .getByRole("status")
    .filter({ hasText: /^Restored|restore result is unknown/ });
  await expect(outcome.first()).toBeVisible({ timeout: 30 * 60_000 });
  evidence.applyMs = Date.now() - applyStarted;
  evidence.loadAfterApply = load();
  evidence.outcomeText = (await outcome.first().textContent()) ?? null;
  await expect(dialog).toBeHidden();
  await page.screenshot({ path: test.info().outputPath("restore-applied.png") });

  const left = existsSync(generated) ? (await fs.readdir(generated)).length : 0;
  evidence.generatedFilesLeft = left;
  expect(evidence.outcomeText).toBe(`Restored ${FILES} files.`);
  expect(left).toBe(0);
  await context.close();
});
