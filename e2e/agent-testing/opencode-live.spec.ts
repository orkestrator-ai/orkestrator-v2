/**
 * Live OpenCode against a real `dev:test --fixture` profile, end to end.
 *
 * Opt-in only: real OpenCode turns use the host's OpenCode credentials and may
 * cost money, so every case is skipped unless
 * `ORKESTRATOR_AGENT_TEST_LIVE_OPENCODE=1`. The model is pinned through
 * `ORKESTRATOR_AGENT_TEST_OPENCODE_MODEL` (required with the opt-in): the
 * shipped default `opencode/claude-sonnet-5` is rejected when its provider is
 * not connected (docs/todo/cross-cutting/0031-live-provider-and-platform-qualification.md),
 * so pin a model from a provider the host login has connected until that is
 * fixed. The build-pipeline case also needs a model that emits reasoning.
 *
 * Nothing at module scope or in a hook spawns `mise` or reads profile state:
 * with the opt-in unset every case is skipped before any of that runs, so the
 * file stays inert in profile-free runs.
 *
 * Prompts are tiny and deterministic. Only disposable environments are created
 * in the fixture project, and every case removes them (and its pipeline) in
 * `finally`. This spec deliberately does not use the `agent-browser` CLI.
 */
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { dismissSidebarTooltip } from "./sidebar-tooltip";
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";

import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";

type Status = {
  status: string;
  profile?: string;
  flavor?: string;
  browserUrl?: string;
  dataDir?: string;
  testProject?: string;
};
type Project = { id: string; name: string; localPath: string | null };
type Environment = { id: string; name: string; worktreePath?: string | null };
type TranscriptPart = { type?: unknown; toolDurationMs?: unknown };
type TranscriptMessage = {
  role?: unknown;
  content?: unknown;
  modelId?: unknown;
  parts?: unknown;
  info?: unknown;
};
type Projection = {
  sessionId?: string;
  turn: { phase: string; error?: string };
  messages: TranscriptMessage[];
  composer?: { selectedModelId?: string };
} | null;
type LayoutTab = {
  id: string;
  type: string;
  nativeAgentData?: { platform?: string; sessionId?: string };
};
type LayoutNode =
  | { kind: "leaf"; id: string; tabs: LayoutTab[]; activeTabId: string | null }
  | { kind: "split"; children: LayoutNode[] };
/** `list_build_pipelines` record: control state only, transcript bodies stripped. */
type PipelineRecord = { id: string; revision: number; snapshot: BuildPipeline };

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const LIVE_OPT_IN = process.env.ORKESTRATOR_AGENT_TEST_LIVE_OPENCODE === "1";

/**
 * Agent Info actions this spec may press, by exact accessible name.
 *
 * NEVER add "Share…": it publishes the conversation to a public OpenCode link.
 * Every Agent Info click goes through this allowlist with `exact: true`, so no
 * broad pattern can reach that button either.
 */
const SAFE_AGENT_INFO_ACTIONS = new Set(["Undo turn", "Redo turn", "Compact", "Fork session"]);

function requirePinnedModel(): string {
  const model = process.env.ORKESTRATOR_AGENT_TEST_OPENCODE_MODEL?.trim();
  if (!model || !model.includes("/")) {
    throw new Error(
      "ORKESTRATOR_AGENT_TEST_LIVE_OPENCODE=1 requires ORKESTRATOR_AGENT_TEST_OPENCODE_MODEL " +
        "as <provider>/<model> from a provider your OpenCode login has connected, for example " +
        "opencode-go/deepseek-v4.1-flash. The default opencode/claude-sonnet-5 fails when its " +
        "provider is not connected (docs/todo/cross-cutting/0031-live-provider-and-platform-qualification.md).",
    );
  }
  return model;
}

function profileStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) {
    throw new Error(
      `dev:status for profile "${profile}" returned no manifest: ${command.stderr.trim()}`,
    );
  }
  return JSON.parse(command.stdout) as Status;
}

async function authenticatedInvoke(page: Page, status: Status) {
  // The one-shot login URL is parsed in memory and never copied into output.
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
  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const invokeResponse = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl!).href,
      { data: { command, args } },
    );
    expect(invokeResponse.ok(), `${command}: ${await invokeResponse.text()}`).toBe(true);
    return ((await invokeResponse.json()) as { result: T }).result;
  };
}

/** Ready agent-test profile, signed in, with its seeded fixture project. */
async function openProfile(page: Page) {
  const status = profileStatus();
  expect(status.profile, "dev:status answered for a different profile").toBe(profile);
  expect(
    status.status,
    `profile "${profile}" is not running; start it with mise run dev:test --fixture`,
  ).toBe("ready");
  expect(status.flavor).toBe("agent-test");
  const runtime = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: profile,
    flavor: "agent-test",
  });
  expect(status.dataDir).toBe(runtime.dataDir);
  const invoke = await authenticatedInvoke(page, status);
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === status.testProject,
  );
  expect(fixture, `the ${profile} fixture project is missing`).toBeTruthy();
  return { status, invoke, fixture: fixture! };
}

/** Dismisses every browser dialog and counts any that would create a share link. */
function guardAgainstShare(page: Page) {
  let shareDialogs = 0;
  page.on("dialog", async (dialog) => {
    // "Share…" asks window.confirm before publishing. Dismissing (never
    // accepting) is a second line of defence behind the allowlist above.
    if (/share link/i.test(dialog.message())) shareDialogs += 1;
    await dialog.dismiss();
  });
  return () => shareDialogs;
}

function sidebarNavigator(page: Page, projectName: string) {
  return async (name: string) => {
    const expand = page.getByRole("button", { name: `Expand project ${projectName}` });
    const entry = page.getByText(name, { exact: true }).first();
    await expect(expand.or(entry)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Checking Docker availability...", { exact: true })).toBeHidden({
      timeout: 30_000,
    });
    for (const label of ["Continue Without Docker", "Continue Without GitHub CLI"]) {
      const continueButton = page.getByRole("button", { name: label, exact: true });
      if (await continueButton.isVisible()) await continueButton.click();
    }
    await expect(page.getByText("Checking CLI tools installation...", { exact: true })).toBeHidden({
      timeout: 30_000,
    });
    if (await expand.isVisible()) await expand.click();
    // A sidebar tooltip from the previous hover can sit over the entry.
    await dismissSidebarTooltip(page, projectName);
    await entry.click();
  };
}

function collectLeaves(node: LayoutNode | undefined): Extract<LayoutNode, { kind: "leaf" }>[] {
  if (!node) return [];
  return node.kind === "leaf" ? [node] : node.children.flatMap(collectLeaves);
}

function assistantText(messages: TranscriptMessage[]): string {
  return messages
    .filter((message) => message.role === "assistant" && typeof message.content === "string")
    .map((message) => message.content as string)
    .join("\n");
}

/** A reply token the prompt never contains verbatim, so only the reply can match it. */
function replyToken(word: string) {
  const digits = String(Math.floor(100_000 + Math.random() * 900_000));
  return {
    prompt:
      `Reply with exactly the word ${word} and the number ${digits} joined by a single ` +
      "hyphen, and nothing else. Do not use any tools.",
    expected: `${word}-${digits}`,
  };
}

test.describe("live OpenCode", () => {
  test.skip(
    !LIVE_OPT_IN,
    "opt-in live OpenCode turns against the isolated fixture with host OpenCode credentials",
  );

  test("native tab turn rehydrates while inactive and after reload, with Agent Info, undo, redo, compact and fork", async ({
    page,
  }) => {
    test.setTimeout(600_000);
    page.setDefaultTimeout(15_000);
    const model = requirePinnedModel();
    // Tall enough that the short transcript stays inside the virtualized window.
    await page.setViewportSize({ width: 1440, height: 2000 });
    const shareDialogs = guardAgainstShare(page);
    const { status, invoke, fixture } = await openProfile(page);
    const environments: Environment[] = [];
    try {
      for (const name of ["oc-live", "oc-inactive"]) {
        environments.push(
          await invoke<Environment>("create_environment", {
            projectId: fixture.id,
            name: `${name}-${Date.now()}`,
            networkAccessMode: "restricted",
            environmentType: "local",
          }),
        );
      }
      const [target, other] = environments as [Environment, Environment];
      await invoke("start_environment", { environmentId: target.id });

      // An assigned OpenCode tab with the pinned model as its one-shot launch
      // model, so the session is created on that model rather than the default.
      const tabId = "oc-live-tab";
      const sessionKey = `env-${target.id}:${tabId}`;
      const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
        environmentId: target.id,
      });
      await invoke("save_pane_layout", {
        environmentId: target.id,
        expectedRevision: layout?.revision ?? 0,
        layout: {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "pane-oc-live",
          root: {
            kind: "leaf",
            id: "pane-oc-live",
            activeTabId: tabId,
            tabs: [
              {
                id: tabId,
                type: "agent-native",
                nativeAgentData: { environmentId: target.id, platform: "opencode", isLocal: true },
                initialAgentModel: model,
              },
            ],
          },
        },
      });

      const projection = (logicalSessionKey: string) =>
        invoke<Projection>("get_native_agent_projection", {
          environmentId: target.id,
          agent: "opencode",
          logicalSessionKey,
        });
      /** Backend truth: the reply landed and the turn settled, read with no UI mounted. */
      const waitForReply = async (logicalSessionKey: string, expected: string) => {
        await expect
          .poll(
            async () => {
              const current = await projection(logicalSessionKey);
              if (current?.turn.phase === "error") {
                throw new Error(
                  `OpenCode turn failed (${current.turn.error ?? "no error text"}); check that ` +
                    "ORKESTRATOR_AGENT_TEST_OPENCODE_MODEL belongs to a connected provider",
                );
              }
              return (
                current?.turn.phase === "idle" && assistantText(current.messages).includes(expected)
              );
            },
            { timeout: 180_000, message: `OpenCode never replied ${expected}` },
          )
          .toBe(true);
      };
      const waitForIdle = (logicalSessionKey: string) =>
        expect
          .poll(async () => (await projection(logicalSessionKey))?.turn.phase, {
            timeout: 180_000,
          })
          .toBe("idle");

      const openEnvironment = sidebarNavigator(page, fixture.name);
      const composeBar = page.getByTestId("shared-native-compose-bar");
      const input = composeBar.getByRole("textbox", { name: "Message OpenCode", exact: true });
      // The native composer's send button is named "Send" (its title), not the
      // "Send message" of the build-pipeline composer.
      const send = composeBar.getByRole("button", { name: "Send", exact: true });
      const sendPrompt = async (prompt: string) => {
        await expect(input).toBeVisible({ timeout: 90_000 });
        await input.fill(prompt);
        await expect(send).toBeEnabled({ timeout: 60_000 });
        await send.click();
        await expect(input).toHaveText("", { timeout: 30_000 });
      };
      const infoDialog = page.getByRole("dialog", { name: "Agent information", exact: true });
      const openAgentInfo = async () => {
        if (!(await infoDialog.isVisible())) {
          await page.getByRole("button", { name: "Open agent information", exact: true }).click();
        }
        await expect(infoDialog).toBeVisible();
        return infoDialog;
      };
      const closeAgentInfo = async () => {
        if (await infoDialog.isVisible()) {
          await infoDialog.getByRole("button", { name: "Close agent information" }).click();
        }
        await expect(infoDialog).toBeHidden();
      };
      const agentInfoAction = async (name: string) => {
        if (!SAFE_AGENT_INFO_ACTIONS.has(name)) {
          throw new Error(`Refusing Agent Info action "${name}"; Share… must never be clicked`);
        }
        const dialog = await openAgentInfo();
        const button = dialog.getByRole("button", { name, exact: true });
        await expect(button).toBeEnabled({ timeout: 30_000 });
        await button.click();
      };

      const first = replyToken("OCLIVE");
      const second = replyToken("OCREDO");

      await page.goto(status.browserUrl!);
      await test.step("a live turn completes while its environment is inactive", async () => {
        await openEnvironment(target.name);
        await sendPrompt(first.prompt);
        await openEnvironment(other.name);
        await expect(input).toBeHidden();
        await waitForReply(sessionKey, first.expected);
        const settled = await projection(sessionKey);
        expect(settled?.composer?.selectedModelId).toBe(model);
        const reply = settled!.messages.find(
          (message) =>
            message.role === "assistant" &&
            typeof message.content === "string" &&
            message.content.includes(first.expected),
        );
        expect(reply?.modelId).toBe(model);
        await openEnvironment(target.name);
        await expect(page.getByText(first.expected).first()).toBeVisible({ timeout: 30_000 });
      });

      await test.step("the transcript rehydrates after a hard reload", async () => {
        await page.reload();
        await openEnvironment(target.name);
        await expect(page.getByText(first.expected).first()).toBeVisible({ timeout: 30_000 });
      });

      await test.step("Agent Info shows usage metrics for the session", async () => {
        const dialog = await openAgentInfo();
        await expect(dialog.getByRole("heading", { name: "OpenCode", exact: true })).toBeVisible();
        await expect(
          dialog.getByText(
            "Usage will appear after this session reports its first token snapshot.",
          ),
        ).toBeHidden({ timeout: 30_000 });
        await expect(dialog.getByText(/^(Input|Output|Session)$/).first()).toBeVisible({
          timeout: 30_000,
        });
        await expect(dialog.getByText(/^(Provider reported|Estimated)$/)).toBeVisible();
        await closeAgentInfo();
      });

      await test.step("undo and redo round-trip the latest turn", async () => {
        await sendPrompt(second.prompt);
        await waitForReply(sessionKey, second.expected);
        await expect(page.getByText(second.expected).first()).toBeVisible({ timeout: 30_000 });
        await agentInfoAction("Undo turn");
        await expect(page.getByText("OpenCode session reverted", { exact: true })).toBeVisible({
          timeout: 60_000,
        });
        await waitForIdle(sessionKey);
        await expect
          .poll(
            async () => {
              const text = assistantText((await projection(sessionKey))?.messages ?? []);
              return text.includes(first.expected) && !text.includes(second.expected);
            },
            {
              timeout: 30_000,
              message: "Undo must remove the latest reply and retain earlier history",
            },
          )
          .toBe(true);
        await closeAgentInfo();
        await expect(page.getByText(second.expected).first()).toBeHidden({ timeout: 30_000 });
        await expect(page.getByText(first.expected).first()).toBeVisible();
        await agentInfoAction("Redo turn");
        await expect(page.getByText("OpenCode revert undone", { exact: true })).toBeVisible({
          timeout: 60_000,
        });
        await waitForReply(sessionKey, second.expected);
        expect(assistantText((await projection(sessionKey))?.messages ?? [])).toContain(
          first.expected,
        );
        await closeAgentInfo();
        await expect(page.getByText(second.expected).first()).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText(first.expected).first()).toBeVisible();
      });

      await test.step("compact summarizes the session", async () => {
        await agentInfoAction("Compact");
        await expect(page.getByText("Context compaction started", { exact: true })).toBeVisible({
          timeout: 60_000,
        });
        await closeAgentInfo();
        await expect(page.getByText("Context compacted", { exact: true }).first()).toBeVisible({
          timeout: 180_000,
        });
        await waitForIdle(sessionKey);
      });

      await test.step("fork opens a new tab with the transcript", async () => {
        const sourceSessionId = (await projection(sessionKey))?.sessionId;
        expect(sourceSessionId).toBeTruthy();
        // Fork closes the panel and activates the new tab itself.
        await agentInfoAction("Fork session");
        await expect(infoDialog).toBeHidden({ timeout: 60_000 });
        let forkTabId: string | undefined;
        await expect
          .poll(
            async () => {
              const saved = await invoke<{ root?: LayoutNode } | null>("get_pane_layout", {
                environmentId: target.id,
              });
              const leaves = collectLeaves(saved?.root);
              const fork = leaves
                .flatMap((leaf) => leaf.tabs)
                .find(
                  (tab) =>
                    tab.id !== tabId &&
                    tab.type === "agent-native" &&
                    tab.nativeAgentData?.platform === "opencode" &&
                    Boolean(tab.nativeAgentData.sessionId) &&
                    tab.nativeAgentData.sessionId !== sourceSessionId,
                );
              forkTabId = fork?.id;
              return Boolean(fork && leaves.some((leaf) => leaf.activeTabId === fork.id));
            },
            { timeout: 60_000, message: "the fork tab was not persisted as the active tab" },
          )
          .toBe(true);
        const forkKey = `env-${target.id}:${forkTabId!}`;
        // The model is deliberately not asserted on the fork: forks currently
        // lose it (docs/todo/cross-cutting/0031-live-provider-and-platform-qualification.md).
        await expect
          .poll(async () => assistantText((await projection(forkKey))?.messages ?? []), {
            timeout: 60_000,
          })
          .toMatch(new RegExp(`${first.expected}[\\s\\S]*${second.expected}`));
        // The compaction summary now ends the transcript; the later reply is
        // the row least likely to be outside the virtualized window.
        await expect(page.getByText(second.expected).first()).toBeVisible({ timeout: 30_000 });
        await page.reload();
        await openEnvironment(target.name);
        await expect(page.getByText(second.expected).first()).toBeVisible({ timeout: 30_000 });
      });

      expect(shareDialogs(), "a Share… confirmation was opened").toBe(0);
    } finally {
      for (const environment of environments) {
        await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
        await invoke("delete_environment", { environmentId: environment.id }).catch(
          () => undefined,
        );
      }
    }
  });

  test("build pipeline transcript shows thinking and timed tool rows without raw envelopes and survives reload", async ({
    page,
  }) => {
    test.setTimeout(600_000);
    page.setDefaultTimeout(15_000);
    const model = requirePinnedModel();
    await page.setViewportSize({ width: 1440, height: 2000 });
    const shareDialogs = guardAgainstShare(page);
    const { status, invoke, fixture } = await openProfile(page);
    const environments: Environment[] = [];
    let pipelineId: string | undefined;
    try {
      const target = await invoke<Environment>("create_environment", {
        projectId: fixture.id,
        name: `oc-build-${Date.now()}`,
        networkAccessMode: "restricted",
        environmentType: "local",
      });
      environments.push(target);
      await invoke("start_environment", { environmentId: target.id });
      const title = "OpenCode live transcript fixture";
      // start_build_pipeline adds the Build tab to this environment's layout.
      // (create_feature_build would instead write its own layout — a Build tab
      // plus a terminal — so either way the spec must activate "Build: <title>".)
      const pipeline = await invoke<BuildPipeline>("start_build_pipeline", {
        taskId: `qa-opencode-build-${target.id}`,
        projectId: fixture.id,
        existingEnvironmentId: target.id,
        environmentType: "local",
        agentType: "opencode",
        // Pinned on every step: the default model may belong to a provider
        // that is not connected (doc 01), which fails the first turn.
        steps: { build: { agent: "opencode", model } },
        reviewers: [{ agent: "opencode", model }],
        maxIterations: 1,
        taskTitle: title,
        taskSnapshot: {
          title,
          description:
            "This is a bounded transcript QA task. Run the shell command `ls` exactly once with " +
            "your shell tool, then reply with the single word DONE. Do not create, modify or " +
            "delete any files, do not commit and do not open a pull request.",
          acceptanceCriteria: "The QA harness cancels this build after the first turn.",
          comments: [],
          images: [],
        },
      });
      pipelineId = pipeline.id;

      // `list_build_pipelines` requires `projectId` and returns
      // `{ id, snapshot: { phase, environmentId, sessions[].messageRevision, … } }`.
      const readRecord = async () => {
        const records = await invoke<PipelineRecord[]>("list_build_pipelines", {
          projectId: fixture.id,
        });
        const record = records.find((candidate) => candidate.id === pipelineId);
        if (!record) throw new Error("the started pipeline is not listed for the fixture project");
        if (record.snapshot.phase === "failed") {
          throw new Error(
            `OpenCode build failed: ${record.snapshot.error ?? "no error text"}; check that ` +
              "ORKESTRATOR_AGENT_TEST_OPENCODE_MODEL belongs to a connected provider",
          );
        }
        return record;
      };
      // Wait for the build session's transcript revision to grow. A phase that
      // has merely left "building" can still be setup, and cancelling then
      // leaves nothing to inspect.
      await expect
        .poll(async () => (await readRecord()).snapshot.sessions[0]?.messageRevision ?? 0, {
          timeout: 180_000,
          message: "the OpenCode build session never committed a transcript",
        })
        .toBeGreaterThan(0);

      // Backend truth first: the served transcript is normalized (no raw
      // `{ info, parts }` envelope) and carries reasoning and a settled tool
      // call with its duration.
      const transcriptShape = async () => {
        const record = await readRecord();
        const session = record.snapshot.sessions[0]!;
        const read = await invoke<{
          messagePatches?: Array<{ sessionKey: string; messages: TranscriptMessage[] }>;
        }>("get_build_pipeline", { pipelineId, knownSessions: {} });
        const messages = (read.messagePatches ?? [])
          .filter((patch) => patch.sessionKey === session.sessionKey)
          .flatMap((patch) => patch.messages);
        const parts = messages.flatMap((message) =>
          Array.isArray(message.parts) ? (message.parts as TranscriptPart[]) : [],
        );
        return {
          envelopes: messages.filter(
            (message) => typeof message.info === "object" && message.info !== null,
          ).length,
          thinking: parts.some((part) => part.type === "thinking"),
          timedTool: parts.some(
            (part) => part.type === "tool-invocation" && typeof part.toolDurationMs === "number",
          ),
        };
      };
      await expect
        .poll(transcriptShape, {
          timeout: 240_000,
          message: "the build transcript never showed reasoning and a settled tool call",
        })
        .toEqual({ envelopes: 0, thinking: true, timedTool: true });
      // Stop before review or PR stages; this spec only needs the build turn.
      await invoke("cancel_build_pipeline", { pipelineId }).catch(() => undefined);

      const openEnvironment = sidebarNavigator(page, fixture.name);
      const openBuild = async () => {
        await openEnvironment(target.name);
        const tab = page.getByRole("button", { name: new RegExp(`^Build: ${title}`) });
        await expect(tab).toBeVisible({ timeout: 30_000 });
        await tab.click();
      };
      const expectRenderedTranscript = async () => {
        await expect(page.getByText("Thinking", { exact: true }).first()).toBeVisible({
          timeout: 30_000,
        });
        // A settled tool row carries its runtime as "Ran for <duration>".
        await expect(page.getByTitle(/^Ran for /).first()).toBeVisible();
        // A raw envelope would render as JSON-ish rows; none may be visible.
        await expect(page.getByText('"info":')).toHaveCount(0);
        await expect(page.getByText('"parts":')).toHaveCount(0);
      };
      await page.goto(status.browserUrl!);
      await openBuild();
      await expectRenderedTranscript();
      await page.reload();
      await openBuild();
      await expectRenderedTranscript();
      expect(shareDialogs(), "a Share… confirmation was opened").toBe(0);
    } finally {
      if (pipelineId) {
        await invoke("cancel_build_pipeline", { pipelineId }).catch(() => undefined);
        await invoke("delete_build_pipeline", { pipelineId }).catch(() => undefined);
      }
      for (const environment of environments) {
        await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
        await invoke("delete_environment", { environmentId: environment.id }).catch(
          () => undefined,
        );
      }
    }
  });
});
