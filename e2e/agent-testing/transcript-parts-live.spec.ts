/**
 * Transcript part coverage on Claude (to-do 0031 task 2): the image, retry,
 * status, compaction and long-running tool parts render from the backend's
 * snapshot after the last turn finished while its environment was inactive,
 * and again after a reload.
 *
 * One native Claude tab on the profile's real CLI and bridge:
 *
 * 1. an image round trip: a saved compose draft with a PNG attachment is sent
 *    from the composer; the model call carries the image block and the user
 *    row shows it;
 * 2. a retry: the model answers the first two calls with HTTP 500, so the CLI
 *    retries and the bridge writes a retry row that settles;
 * 3. a status row: a held turn is stopped from the composer ("Interrupted by
 *    user");
 * 4. a compaction, through the session's compact action ("Context
 *    compacted");
 * 5. a long-running tool: one `Bash` call that sleeps. Once the call is
 *    running the spec switches to a second environment, waits until the
 *    backend reports the turn idle with nothing mounted for it, returns,
 *    checks every part, reloads and checks them again.
 *
 * Opt-in (`ORKESTRATOR_AGENT_TEST_LIVE_TRANSCRIPT_PARTS=1`). The default model
 * is scripted: the loopback Anthropic endpoint (`fake-anthropic-model.ts`)
 * answers every call, so the run needs no credential and bills nothing:
 *
 *   ORKESTRATOR_HOST_REACHABILITY_CHECK=off mise run dev:test --profile parts0031 \
 *     --fixture --no-agent-credentials --no-host-seed --agent-platforms claude --headless
 *   ORKESTRATOR_AGENT_TEST_PROFILE=parts0031 ORKESTRATOR_AGENT_TEST_LIVE_TRANSCRIPT_PARTS=1 \
 *     mise run test:logged -- --name transcript-parts -- \
 *     bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts \
 *     transcript-parts-live.spec.ts --workers=1
 *
 * `ORKESTRATOR_AGENT_TEST_TRANSCRIPT_PARTS_MODEL=live` runs the same cases on
 * a profile started with `--credential-source claude` instead (real turns,
 * billed; the manual-test checklist's 0031 task 2 item). A real model cannot
 * be made to fail a request, so the live run records the retry case as not
 * exercised rather than passing it.
 *
 * The profile's isolated Claude `settings.json` gets the fake endpoint (scripted
 * runs only) and an allow rule for the two fixture commands, so the sleeping
 * call does not park an approval; the previous file is put back afterwards.
 * Counts and part kinds go to `evidence-transcript-parts-*.json`; no token,
 * prompt or transcript text reaches output.
 */
import { spawnSync } from "node:child_process";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import type { BrowserContext } from "@playwright/test";
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
type Environment = { id: string; name: string; worktreePath?: string | null; status?: string };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Part = { type?: string; toolState?: string; name?: string; content?: unknown };
type Projection = {
  turn: { phase: string };
  messages?: Array<{ id?: string; role?: string; parts?: Part[] }>;
};

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "parts0031";
const ENABLED = process.env.ORKESTRATOR_AGENT_TEST_LIVE_TRANSCRIPT_PARTS === "1";
const LIVE_MODEL = process.env.ORKESTRATOR_AGENT_TEST_TRANSCRIPT_PARTS_MODEL === "live";
const TAB_ID = "transcript-parts-claude";
const TURN_TIMEOUT_MS = LIVE_MODEL ? 5 * 60_000 : 2 * 60_000;
/** How long the scripted tool sleeps: long enough to switch away while it runs. */
const SLEEP_SECONDS = 15;
const TOOL_COMMAND = `sleep ${SLEEP_SECONDS} && printf parts-done`;
const LONG_TOOL_SCRIPT = "parts-long";
const HOLD_ID = "parts-stop";

// 1x1 transparent PNG: a harmless, valid image.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const IMAGE_NAME = "parts-image.png";

const PROMPTS = LIVE_MODEL
  ? {
      image: "Describe the attached image in one short sentence. Use no tools.",
      retry: undefined,
      hold: `Use the Bash tool to run exactly: sleep 120 && printf parts-held. Do nothing else.`,
      long: `Use the Bash tool to run exactly: ${TOOL_COMMAND}. Then reply with the single word done.`,
    }
  : {
      image: "Describe the attached fixture image",
      retry: "Answer after two failed requests [retry:parts-retry:2]",
      hold: `Wait until the spec stops this turn [hold:${HOLD_ID}]`,
      long: `Run the slow fixture command [script:${LONG_TOOL_SCRIPT}]`,
    };

test.skip(!ENABLED, "Opt-in: ORKESTRATOR_AGENT_TEST_LIVE_TRANSCRIPT_PARTS=1");

const evidence: Record<string, unknown> = { model: LIVE_MODEL ? "live" : "scripted" };

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
      activePaneId: "parts-pane",
      root: {
        kind: "leaf",
        id: "parts-pane",
        activeTabId: TAB_ID,
        tabs: [
          {
            id: TAB_ID,
            type: "agent-native",
            displayTitle: "Transcript part coverage",
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
async function openEnvironment(
  page: Page,
  fixtureName: string,
  environmentName: string,
  expectComposer = true,
) {
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
  if (expectComposer) await expect(composer(page)).toBeVisible({ timeout: 90_000 });
}

/** Part kinds in the projection, in transcript order, with their settled state. */
function partKinds(projection: Projection): string[] {
  return (projection.messages ?? []).flatMap((message) =>
    (message.parts ?? []).map((part) => `${message.role ?? "?"}:${part.type ?? "?"}`),
  );
}

function partsOf(projection: Projection, type: string): Part[] {
  return (projection.messages ?? []).flatMap((message) =>
    (message.parts ?? []).filter((part) => part.type === type),
  );
}

/**
 * A user row carries the image: an `image` or `file` part naming the PNG, or
 * the `<attached-files>` block the composer appends to the prompt text, which
 * the renderer shows as the attachment.
 */
function userImageParts(projection: Projection): Part[] {
  return (projection.messages ?? [])
    .filter((message) => message.role === "user")
    .flatMap((message) => message.parts ?? [])
    .filter((part) => {
      const content = String(part.content ?? "");
      if (part.type === "image" || part.type === "file") return content.includes(IMAGE_NAME);
      return (
        part.type === "text" && content.includes("<attached-files>") && content.includes(IMAGE_NAME)
      );
    });
}

let model: FakeAnthropicModel | undefined;
let settingsPath: string | undefined;
let priorSettings: string | null = null;
const environments: Environment[] = [];
let invoke: Invoke | undefined;
let browserContext: BrowserContext | undefined;

test.afterAll(async () => {
  // The gateway calls go through the context, so it closes only afterwards.
  for (const environment of environments) {
    await invoke?.("stop_environment", { environmentId: environment.id }).catch(() => undefined);
    await invoke?.("delete_environment", { environmentId: environment.id }).catch(() => undefined);
  }
  await browserContext?.close().catch(() => undefined);
  await fs.writeFile(
    path.join(test.info().outputDir, "..", `evidence-transcript-parts-${Date.now()}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  if (settingsPath) {
    if (priorSettings === null) await fs.rm(settingsPath, { force: true });
    else await fs.writeFile(settingsPath, priorSettings);
  }
  await model?.stop();
});

test("compaction, retry, status, image and long-tool parts render from the snapshot after an inactive finish and a reload", async ({
  browser,
}) => {
  test.setTimeout(30 * 60_000);
  const status = readyStatus();
  if (!LIVE_MODEL) {
    model = await startFakeAnthropicModel(0, {
      toolScripts: {
        [LONG_TOOL_SCRIPT]: [
          {
            tool: "Bash",
            input: { command: TOOL_COMMAND, description: "Wait, then print a fixture word" },
          },
        ],
      },
    });
  }
  const claudeDir = path.join(runtime().dataDir, "agent-credentials", "claude");
  // The profile's own isolated Claude home, never a real one.
  expect(claudeDir.startsWith(runtime().profileRoot)).toBe(true);
  await fs.mkdir(claudeDir, { recursive: true });
  settingsPath = path.join(claudeDir, "settings.json");
  priorSettings = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null;
  const prior = priorSettings ? (JSON.parse(priorSettings) as Record<string, unknown>) : {};
  await fs.writeFile(
    settingsPath,
    JSON.stringify({
      ...prior,
      ...(model ? fakeModelClaudeSettings(model.origin) : {}),
      permissions: { allow: ["Bash(sleep:*)", "Bash(printf:*)"] },
    }),
  );

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  browserContext = context;
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
  const stamp = Date.now();
  for (const name of [`parts-${stamp}`, `parts-away-${stamp}`]) {
    const created = await invoke<Environment>("create_environment", {
      projectId: fixture!.id,
      name,
      environmentType: "local",
      networkAccessMode: "restricted",
    });
    environments.push(created);
    await invoke("start_environment", { environmentId: created.id });
  }
  for (const created of environments) {
    await expect
      .poll(
        async () =>
          (await invoke!<Environment>("get_environment", { environmentId: created.id })).status,
        { timeout: 120_000 },
      )
      .toBe("running");
  }
  const main = await invoke<Environment>("get_environment", {
    environmentId: environments[0]!.id,
  });
  const away = environments[1]!;
  const worktree = main.worktreePath!;
  expect(worktree).toBeTruthy();
  await seedClaudeTab(invoke, main.id);
  const logicalSessionKey = `env-${main.id}:${TAB_ID}`;
  const identity = { environmentId: main.id, agent: "claude", logicalSessionKey };
  const projection = () => invoke!<Projection>("get_native_agent_projection", identity);

  // The image goes in as a saved draft, which the composer restores and sends.
  await fs.mkdir(path.join(worktree, ".qa"), { recursive: true });
  const imagePath = path.join(worktree, ".qa", IMAGE_NAME);
  await fs.writeFile(imagePath, PNG);
  await invoke("save_compose_draft", {
    draftKey: `claude:${main.id}:${encodeURIComponent(logicalSessionKey)}`,
    ownerType: "environment",
    ownerId: main.id,
    value: {
      text: PROMPTS.image,
      mentions: [],
      attachments: [
        { id: `parts-image-${stamp}`, type: "image", name: IMAGE_NAME, path: imagePath },
      ],
      annotations: [],
    },
  });

  await page.goto(status.browserUrl!, { waitUntil: "domcontentloaded" });
  await openEnvironment(page, fixture!.name, main.name);

  /** Sends from the composer and waits until the backend reports the turn over. */
  const settleTurn = async (label: string) => {
    await expect
      .poll(async () => (await projection()).turn.phase, {
        timeout: TURN_TIMEOUT_MS,
        intervals: [500, 1_000],
        message: `${label}: the turn never settled`,
      })
      .toMatch(/^(idle|error)$/);
  };
  const send = async (prompt: string, label: string) => {
    const before = (await projection()).messages?.length ?? 0;
    await composer(page).fill(prompt);
    await composer(page).press("Enter");
    await expect
      .poll(async () => (await projection()).messages?.length ?? 0, {
        timeout: TURN_TIMEOUT_MS,
        message: `${label}: the prompt never reached the transcript`,
      })
      .toBeGreaterThan(before);
  };

  // 1. Image round trip.
  await expect(page.getByText(IMAGE_NAME).first()).toBeVisible({ timeout: 30_000 });
  await composer(page).press("Enter");
  await expect.poll(async () => userImageParts(await projection()).length).toBeGreaterThan(0);
  await settleTurn("image");
  if (model) {
    const withImage = model.calls().filter((call) => call.images > 0).length;
    evidence.imageCalls = withImage;
    expect(withImage, "no model call carried the image block").toBeGreaterThan(0);
  }

  // 2. Retry: two failed requests, then the answer; the row settles.
  if (PROMPTS.retry) {
    await send(PROMPTS.retry, "retry");
    await settleTurn("retry");
    const failed = model!.calls().filter((call) => call.failedWith === 500).length;
    evidence.failedRequests = failed;
    expect(failed).toBe(2);
    await expect(page.getByText(answerFor(PROMPTS.retry)).first()).toBeVisible();
  } else {
    evidence.retry = "not exercised: a real model cannot be made to fail a request";
  }

  // 3. Status: a turn held at "provider is working", stopped from the composer.
  await send(PROMPTS.hold, "hold");
  if (model)
    await expect.poll(() => model!.held(), { timeout: TURN_TIMEOUT_MS }).toContain(HOLD_ID);
  else await page.waitForTimeout(10_000);
  await page.getByRole("button", { name: "Stop current query" }).click();
  await settleTurn("stop");
  model?.release(HOLD_ID);
  await expect(page.getByText("Interrupted by user").first()).toBeVisible({ timeout: 30_000 });

  // 4. Compaction, as the session's compact action.
  const compacted = await invoke<{ outcome?: string }>("perform_native_agent_session_action", {
    ...identity,
    action: { kind: "compact" },
  });
  evidence.compactOutcome = compacted?.outcome ?? null;
  await expect
    .poll(async () => partsOf(await projection(), "compaction").length, {
      timeout: TURN_TIMEOUT_MS,
      message: "no compaction row",
    })
    .toBeGreaterThan(0);
  await settleTurn("compact");

  // 5. A long-running tool that finishes while the environment is inactive.
  await send(PROMPTS.long, "long tool");
  await expect
    .poll(
      async () =>
        model
          ? model
              .calls()
              .some(
                (call) => call.script?.id === LONG_TOOL_SCRIPT && call.script.tool !== undefined,
              )
          : partsOf(await projection(), "tool-invocation").some(
              (part) => part.toolState === "pending",
            ),
      { timeout: TURN_TIMEOUT_MS, message: "the long tool call never started" },
    )
    .toBe(true);
  const switchedAt = Date.now();
  await openEnvironment(page, fixture!.name, away.name, false);
  await expect(composer(page)).toHaveCount(0, { timeout: 30_000 });
  await settleTurn("long tool, inactive");
  evidence.inactiveFinishMs = Date.now() - switchedAt;
  expect(
    Date.now() - switchedAt,
    "the tool did not run while the environment was away",
  ).toBeGreaterThan(LIVE_MODEL ? 0 : 5_000);

  const snapshot = await projection();
  evidence.partKinds = [...new Set(partKinds(snapshot))].sort();
  const expectParts = (view: Projection) => {
    expect(userImageParts(view).length, "image part").toBeGreaterThan(0);
    if (PROMPTS.retry) {
      const retries = partsOf(view, "retry");
      expect(retries.length, "retry part").toBeGreaterThan(0);
      expect(
        retries.every((part) => part.toolState === "success" || part.toolState === "failure"),
        "a retry row never settled",
      ).toBe(true);
    }
    expect(partsOf(view, "status").length, "status part").toBeGreaterThan(0);
    expect(partsOf(view, "compaction").length, "compaction part").toBeGreaterThan(0);
    const tools = partsOf(view, "tool-invocation");
    expect(tools.length, "tool part").toBeGreaterThan(0);
    expect(tools.at(-1)!.toolState, "the long tool call did not settle").toBe("success");
  };
  expectParts(snapshot);

  const rows = page.locator("[data-chat-message-index]");
  /** Back to the newest row: the tab restores the scroll position it was left at. */
  const scrollToBottom = async () => {
    const down = page.getByRole("button", { name: "Scroll down" });
    for (
      let attempt = 0;
      attempt < 10 && (await down.isVisible().catch(() => false));
      attempt += 1
    ) {
      await down.click().catch(() => undefined);
      await page.waitForTimeout(300);
    }
  };
  /**
   * Scrolls the transcript up until `target` is on screen: rows far from the
   * bottom are not mounted, so a part above the viewport cannot be seen yet.
   */
  const reveal = async (target: ReturnType<Page["locator"]>, what: string, stage: string) => {
    await scrollToBottom();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (
        await target
          .first()
          .isVisible()
          .catch(() => false)
      )
        break;
      const box = await rows
        .first()
        .boundingBox()
        .catch(() => null);
      await page.mouse.move(box ? box.x + box.width / 2 : 900, box ? box.y + 40 : 400);
      await page.mouse.wheel(0, -600);
      await page.waitForTimeout(150);
    }
    await expect(target.first(), `${stage}: ${what}`).toBeVisible();
  };
  const expectRendered = async (stage: string) => {
    await expect(
      page.getByRole("button", { name: "Stop current query" }),
      `${stage}: the turn still looks busy`,
    ).toHaveCount(0);
    if (PROMPTS.retry) {
      await reveal(page.getByText(answerFor(PROMPTS.long)), "final answer", stage);
    }
    await reveal(page.getByText("Context compacted"), "compaction", stage);
    await page.screenshot({
      path: test.info().outputPath(`transcript-parts-${stage}-compaction.png`),
    });
    await reveal(page.getByText("Interrupted by user"), "status", stage);
    if (PROMPTS.retry) {
      await reveal(page.getByText("The API answered 500"), "retry", stage);
      await expect(
        page.getByText("Retried", { exact: true }).first(),
        `${stage}: retry settled`,
      ).toBeVisible();
      await expect(page.getByText(/^Retrying/), `${stage}: a retry row still spins`).toHaveCount(0);
    }
    await reveal(
      rows.filter({ hasText: PROMPTS.image }).filter({ has: page.locator("img") }),
      "the user row's image",
      stage,
    );
  };

  // Return: the tab mounts from the snapshot, then once more after a reload.
  await openEnvironment(page, fixture!.name, main.name);
  await expectRendered("return");
  await page.screenshot({ path: test.info().outputPath("transcript-parts-return.png") });
  await page.reload({ waitUntil: "domcontentloaded" });
  await openEnvironment(page, fixture!.name, main.name);
  await expectRendered("reload");
  expectParts(await projection());
  await page.screenshot({ path: test.info().outputPath("transcript-parts-reload.png") });
  if (model) evidence.modelCalls = model.calls().length;
});
