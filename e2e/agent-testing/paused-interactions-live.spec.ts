// Live qualification of a paused question and approval on each provider's real
// CLI: every case raises a real request, the user pauses its countdown from the
// card, the request is left waiting past ten minutes, then answered from the
// card, and the turn must carry on with that answer. Nothing may time out,
// deny or approve on its own while it waits.
//
// Run only in a disposable `dev:test --fixture` profile that authorizes the
// providers under test. Opt-in: `ORKESTRATOR_AGENT_TEST_LIVE_PAUSED_INTERACTIONS=1`,
// because every case is a real, billed provider turn. Narrow the providers with
// `ORKESTRATOR_AGENT_TEST_PAUSE_PROVIDERS=claude,codex`, the wait with
// `ORKESTRATOR_AGENT_TEST_PAUSE_WAIT_MS` (default: just past ten minutes) and
// pick models with `ORKESTRATOR_AGENT_TEST_PAUSE_MODELS=pi=openai/gpt-6-sol,…`.
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { withDesignLiveHeartbeat } from "./design-live-heartbeat";
import {
  approvalOption,
  raiseAndProtect,
  withEnvironmentCleanup,
} from "./paused-interactions-live-support";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import type { AgentInteractionRequest } from "@orkestrator/protocol/agent-interactions";
import type { NativeAgentSessionProjection } from "@orkestrator/protocol/native-agent";

type Platform = "claude" | "codex" | "grok" | "opencode" | "pi";
type Environment = { id: string; name: string; worktreePath?: string };
type Projection = NativeAgentSessionProjection | null;

const root = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const ENABLED = process.env.ORKESTRATOR_AGENT_TEST_LIVE_PAUSED_INTERACTIONS === "1";
const PROVIDERS = new Set(
  (process.env.ORKESTRATOR_AGENT_TEST_PAUSE_PROVIDERS ?? "claude,codex,grok,opencode,pi")
    .split(",")
    .map((provider) => provider.trim())
    .filter(Boolean),
);
/** Past the old five-minute default and Claude's 600 s hook limit. */
const WAIT_MS = Number(process.env.ORKESTRATOR_AGENT_TEST_PAUSE_WAIT_MS ?? 10.5 * 60_000);
/**
 * A profile shares only Pi's `auth.json`, not the host's default model, and
 * Pi's own fallback (`gpt-4`) is refused by a ChatGPT-backed OpenAI login.
 */
const MODELS: Partial<Record<string, string>> = Object.fromEntries(
  (process.env.ORKESTRATOR_AGENT_TEST_PAUSE_MODELS ?? "pi=openai/gpt-6-sol")
    .split(",")
    .map((pair) => pair.split("=").map((part) => part.trim()))
    .filter((pair): pair is [string, string] => pair.length === 2 && !!pair[0] && !!pair[1]),
);
const APPROVAL_KINDS = new Set(["command-approval", "file-approval", "permission"]);
const CODEWORD = "PAUSE_BETA";

interface Case {
  id: string;
  agent: Platform;
  kind: "question" | "approval";
  approvalMode?: string;
  /** OpenCode publishes no deadline, so there is no countdown to pause. */
  pausable: boolean;
}

const CASES: Case[] = [
  { id: "claude-question", agent: "claude", kind: "question", pausable: true },
  {
    id: "claude-approval",
    agent: "claude",
    kind: "approval",
    approvalMode: "default",
    pausable: true,
  },
  // No Codex question: the bridge runs every turn in Codex's Default
  // collaboration mode, where Codex refuses `request_user_input` ("unavailable
  // in Default mode"), so no real Codex turn can raise one today.
  {
    id: "codex-approval",
    agent: "codex",
    kind: "approval",
    approvalMode: "untrusted",
    pausable: true,
  },
  { id: "grok-question", agent: "grok", kind: "question", pausable: true },
  { id: "grok-approval", agent: "grok", kind: "approval", pausable: true },
  { id: "opencode-question", agent: "opencode", kind: "question", pausable: false },
  { id: "opencode-approval", agent: "opencode", kind: "approval", pausable: false },
  // Pi raises approvals only; it has no question tool.
  { id: "pi-approval", agent: "pi", kind: "approval", pausable: true },
];

const QUESTION_TOOL: Partial<Record<Platform, string>> = {
  claude: "AskUserQuestion tool",
  grok: "ask_user_question tool",
  opencode: "question tool",
};

function promptFor(testCase: Case, marker: string, done: string): string {
  if (testCase.kind === "question") {
    return (
      `Use the ${QUESTION_TOOL[testCase.agent] ?? "question tool"} exactly once to ask me which codeword to use, ` +
      "offering exactly two options labelled PAUSE_ALPHA and PAUSE_BETA. Do not use any other " +
      "tool and do not guess. After I answer, reply with one line: CODEWORD_CHOSEN= followed " +
      "immediately by the codeword I picked."
    );
  }
  return (
    // A bare name in the worktree: the profile's absolute path contains a
    // space, and an agent that drops the quotes would touch a file outside it.
    `Use your shell tool to run exactly this command once, in the current working directory, ` +
    `and nothing else: touch ${path.basename(marker)}\n` +
    `Do not use any other tool and do not retry if it is refused. After it succeeds, reply ` +
    `exactly ${done}.`
  );
}

function assistantText(projection: Projection): string {
  return JSON.stringify(
    (projection?.messages ?? []).filter(
      (message) => (message as { role?: string }).role === "assistant",
    ),
  );
}

function pendingOf(projection: Projection, testCase: Case): AgentInteractionRequest | undefined {
  return projection?.interactions.find(
    (interaction) =>
      interaction.state === "pending" &&
      (testCase.kind === "question"
        ? interaction.kind === "question"
        : APPROVAL_KINDS.has(interaction.kind)),
  );
}

async function connect(page: Page) {
  const run = (task: string) => {
    const result = spawnSync("mise", ["run", task, "--profile", profile, "--json"], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    });
    if (result.status !== 0) throw new Error(`${task} failed`);
    return JSON.parse(result.stdout);
  };
  const status = run("dev:status") as {
    status: string;
    flavor: string;
    testProject: string;
    browserUrl: string;
  };
  expect(status.status).toBe("ready");
  expect(status.flavor).toBe("agent-test");
  // The one-shot login URL is parsed in memory and never copied into output.
  const signIn = async () => {
    const { loginUrl } = run("dev:login") as { loginUrl: string };
    await page.goto(loginUrl);
  };
  await signIn();
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl).href,
      { data: { command, args } },
    );
    expect(response.ok(), `${command}: ${(await response.text()).slice(0, 500)}`).toBe(true);
    return ((await response.json()) as { result: T }).result;
  };
  const projects =
    await invoke<Array<{ id: string; name: string; localPath: string }>>("get_projects");
  const fixture = projects.find((project) => project.localPath === status.testProject);
  expect(fixture).toBeTruthy();
  return { invoke, fixture: fixture!, status, signIn };
}

interface Running {
  testCase: Case;
  environment: Environment;
  identity: { environmentId: string; agent: Platform; logicalSessionKey: string };
  marker: string;
  done: string;
  request?: AgentInteractionRequest;
  pausedExpiresAt?: number;
  observed: string[];
  outcome?: string;
}

test("a paused question and approval wait past ten minutes on every provider, then resume", async ({
  page,
}, testInfo) => {
  test.skip(!ENABLED, "requires ORKESTRATOR_AGENT_TEST_LIVE_PAUSED_INTERACTIONS=1");
  const cases = CASES.filter((testCase) => PROVIDERS.has(testCase.agent));
  expect(cases.length, "no provider selected").toBeGreaterThan(0);
  page.setDefaultTimeout(20_000);
  await withDesignLiveHeartbeat("paused-interactions", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const { invoke, fixture, status, signIn } = await connect(page);
    const suffix = Date.now();
    const runs: Running[] = [];
    const log = (line: string) => console.log(`[paused-interactions] ${line}`);
    const read = (run: Running) =>
      invoke<Projection>("get_native_agent_projection", { ...run.identity, messageLimit: 50 });
    const open = async (name: string) => {
      const expand = page.getByRole("button", { name: `Expand project ${fixture.name}` });
      const entry = page.getByText(name, { exact: true }).first();
      await expect(expand.or(entry)).toBeVisible({ timeout: 90_000 });
      for (const label of ["Continue Without Docker", "Continue Without GitHub CLI"]) {
        const button = page.getByRole("button", { name: label, exact: true });
        if (await button.isVisible()) await button.click();
      }
      if (await expand.isVisible()) await expand.click();
      await page.mouse.move(0, 0);
      await entry.click();
    };

    await withEnvironmentCleanup(invoke, async (register) => {
      try {
        await test.step("one environment per case, under an Ask policy", async () => {
          for (const testCase of cases) {
            const environment = await invoke<Environment>("create_environment", {
              projectId: fixture.id,
              name: `pause-${testCase.id}-${suffix}`,
              environmentType: "local",
            });
            register(environment.id);
            await invoke("update_environment_agent_settings", {
              environmentId: environment.id,
              agentSettings: { executionPolicy: { approvals: "ask" } },
            });
            await invoke("start_environment", { environmentId: environment.id });
            const started = await invoke<Environment>("get_environment", {
              environmentId: environment.id,
            });
            expect(started.worktreePath).toBeTruthy();
            const tabId = `pause-${testCase.id}`;
            const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
              environmentId: environment.id,
            });
            await invoke("save_pane_layout", {
              environmentId: environment.id,
              expectedRevision: layout?.revision ?? 0,
              layout: {
                version: PANE_LAYOUT_VERSION,
                containerId: null,
                activePaneId: "pause-pane",
                root: {
                  kind: "leaf",
                  id: "pause-pane",
                  activeTabId: tabId,
                  tabs: [
                    {
                      id: tabId,
                      type: "agent-native",
                      nativeAgentData: {
                        environmentId: environment.id,
                        platform: testCase.agent,
                        isLocal: true,
                      },
                    },
                  ],
                },
              },
            });
            runs.push({
              testCase,
              environment: started,
              identity: {
                environmentId: environment.id,
                agent: testCase.agent,
                logicalSessionKey: `env-${environment.id}:${tabId}`,
              },
              marker: path.join(started.worktreePath!, `pause-${testCase.id}.txt`),
              done: `${testCase.id.toUpperCase().replace("-", "_")}_DONE`,
              observed: [],
            });
          }
        });

        await test.step("every case raises its request", async () => {
          // Providers run in parallel. A provider's own cases go one after the
          // other: two OpenCode servers starting at once can fail on OpenCode's
          // shared database ("database is locked"), which is not what this
          // qualifies.
          const raise = async (run: Running) => {
            // A refused dispatch never starts a turn, so polling for one would
            // wait out the whole timeout; the outcome already says why.
            const dispatched = await invoke<{ outcome: string; error?: string }>(
              "dispatch_native_agent_intent",
              {
                ...run.identity,
                requestId: `pause-${run.testCase.id}-${suffix}`,
                mode: "build",
                ...(run.testCase.approvalMode ? { approvalMode: run.testCase.approvalMode } : {}),
                ...(MODELS[run.testCase.agent] ? { model: MODELS[run.testCase.agent] } : {}),
                prompt: promptFor(run.testCase, run.marker, run.done),
              },
            );
            if (dispatched.outcome === "rejected") {
              throw new Error(`${run.testCase.id}: dispatch refused: ${dispatched.error ?? ""}`);
            }
            let last = null as Projection;
            await expect
              .poll(
                async () => {
                  last = await read(run).catch(() => null);
                  if (last?.turn.phase === "error") {
                    throw new Error(`${run.testCase.id}: turn error ${last.turn.error ?? ""}`);
                  }
                  if (last?.turn.phase === "idle" && last.messages.length > 1) {
                    throw new Error(`${run.testCase.id}: turn ended without asking`);
                  }
                  run.request = pendingOf(last, run.testCase);
                  return run.request !== undefined;
                },
                {
                  timeout: 300_000,
                  intervals: [2_000],
                  message: `${run.testCase.id} never asked (turn ${last?.turn.phase ?? "none"})`,
                },
              )
              .toBe(true);
            run.observed.push(`raised ${run.request!.kind}`);
            if (run.testCase.kind === "approval") expect(existsSync(run.marker)).toBe(false);
            log(
              `${run.testCase.id}: ${run.request!.kind} pending, expiresAt=${run.request!.expiresAt}`,
            );
          };
          const byAgent = new Map<Platform, Running[]>();
          for (const run of runs) {
            byAgent.set(run.testCase.agent, [...(byAgent.get(run.testCase.agent) ?? []), run]);
          }
          await raiseAndProtect([...byAgent.values()], raise, async (run) => {
            // Protect this request before waiting for any other provider or case.
            // The UI phase below still exercises resume/pause on the actual card.
            if (run.testCase.pausable) {
              await invoke("hold_native_agent_interaction", {
                ...run.identity,
                interactionId: run.request!.id,
                held: true,
              });
              const held = pendingOf(await read(run), run.testCase);
              expect(held?.id).toBe(run.request!.id);
              expect(held?.hold?.heldAt).toBeTruthy();
              expect(held?.expiresAt).toBeGreaterThan(Date.now() + WAIT_MS + 60_000);
            }
          });
        });

        await test.step("pause each countdown from its card", async () => {
          await page.goto(status.browserUrl);
          for (const run of runs) {
            await open(run.environment.name);
            const card =
              run.testCase.kind === "question"
                ? page.getByTestId("agent-question-card")
                : page.getByRole("group", { name: run.request!.presentation.title, exact: true });
            await expect(card).toBeVisible({ timeout: 90_000 });
            if (!run.testCase.pausable) {
              // No deadline published, so the card shows no countdown at all.
              expect(run.request!.expiresAt).toBeUndefined();
              await expect(card.getByTestId("prompt-deadline-toggle")).toHaveCount(0, {
                timeout: 30_000,
              });
              run.observed.push("no countdown");
              continue;
            }
            const resume = card.getByRole("button", { name: "Resume countdown", exact: true });
            await expect(resume).toBeVisible();
            await expect(resume).toBeEnabled();
            await resume.press("Enter");
            await expect
              .poll(async () => pendingOf(await read(run), run.testCase)?.hold?.heldAt)
              .toBeUndefined();
            const pause = card.getByRole("button", { name: /^Pause countdown,/ });
            await expect(pause).toBeVisible({ timeout: 90_000 });
            // The label changes optimistically while the resume is still in
            // flight. Keyboard activation does not wait for enabledness.
            await expect(pause).toBeEnabled();
            await pause.press("Enter");
            await expect(
              page.getByRole("button", { name: "Resume countdown", exact: true }),
            ).toBeVisible();
            await expect
              .poll(async () => pendingOf(await read(run), run.testCase)?.hold?.heldAt)
              .toBeTruthy();
            const paused = pendingOf(await read(run), run.testCase)!;
            expect(paused.id).toBe(run.request!.id);
            run.pausedExpiresAt = paused.expiresAt;
            run.observed.push(
              `paused until +${Math.round(((paused.expiresAt ?? 0) - Date.now()) / 60_000)} min` +
                (paused.hold?.reason ? ` (${paused.hold.reason})` : ""),
            );
            log(`${run.testCase.id}: paused, expiresAt=${paused.expiresAt}`);
            // The pause must outlast the wait, or this run cannot prove anything.
            expect(paused.expiresAt!).toBeGreaterThan(Date.now() + WAIT_MS + 60_000);
          }
        });

        await test.step("every request is still waiting past ten minutes", async () => {
          const waitUntil = Date.now() + WAIT_MS;
          log(`waiting until ${new Date(waitUntil).toISOString()}`);
          while (Date.now() < waitUntil) {
            await page.waitForTimeout(Math.min(60_000, Math.max(0, waitUntil - Date.now())));
            // Pointer activity keeps the gateway session from lapsing.
            await page.mouse.move(10 + (Date.now() % 50), 10);
            for (const run of runs) {
              const projection = await read(run);
              const pending = pendingOf(projection, run.testCase);
              expect(
                pending?.id,
                `${run.testCase.id}: request left pending state (turn ${projection?.turn.phase})`,
              ).toBe(run.request!.id);
              expect(projection?.turn.phase, `${run.testCase.id}: turn phase`).not.toMatch(
                /^(idle|error)$/,
              );
              if (run.testCase.kind === "approval") {
                expect(existsSync(run.marker), `${run.testCase.id}: approved on its own`).toBe(
                  false,
                );
              }
            }
            // A heartbeat, too: `test:logged` ends a run that is silent for 5 min.
            log(
              `all ${runs.length} still pending, ${Math.ceil((waitUntil - Date.now()) / 60_000)} min left`,
            );
          }
          for (const run of runs) {
            const pending = pendingOf(await read(run), run.testCase)!;
            run.observed.push(
              `pending after ${Math.round((Date.now() - pending.createdAt) / 60_000)} min, turn waiting`,
            );
          }
        });

        await test.step("answer each card after a reload; the turn carries on", async () => {
          // A fresh sign-in and reload: the cards must rehydrate from the backend.
          await signIn();
          await page.goto(status.browserUrl);
          for (const run of runs) {
            await open(run.environment.name);
            const request = pendingOf(await read(run), run.testCase)!;
            expect(request.id).toBe(run.request!.id);
            if (run.testCase.pausable) {
              await expect(
                page.getByRole("button", { name: "Resume countdown", exact: true }),
              ).toBeVisible({ timeout: 90_000 });
            }
            await answer(page, request, run.testCase);
            run.observed.push("answered");
            log(`${run.testCase.id}: answered`);
          }
          const finished = await Promise.allSettled(
            runs.map(async (run) => {
              await expect
                .poll(
                  async () => {
                    const projection = await read(run);
                    if (projection?.turn.phase === "error") {
                      throw new Error(
                        `${run.testCase.id}: turn error ${projection.turn.error ?? ""}`,
                      );
                    }
                    const text = assistantText(projection);
                    const finished =
                      run.testCase.kind === "question"
                        ? text.includes(`CODEWORD_CHOSEN=${CODEWORD}`)
                        : existsSync(run.marker) && text.includes(run.done);
                    return projection?.turn.phase === "idle" && finished;
                  },
                  { timeout: 300_000, intervals: [3_000] },
                )
                .toBe(true)
                .catch(async (error: unknown) => {
                  const projection = await read(run).catch(() => null);
                  throw new Error(
                    `${run.testCase.id} did not finish after the answer: turn ` +
                      `${projection?.turn.phase ?? "none"}, marker ${existsSync(run.marker)}, ` +
                      `interactions ${JSON.stringify(
                        projection?.interactions.map((item) => `${item.kind}:${item.state}`) ?? [],
                      )}, reply …${assistantText(projection).slice(-600)}`,
                    { cause: error },
                  );
                });
              const settled = await read(run);
              expect(
                settled?.interactions.filter((item) => item.state === "pending") ?? [],
              ).toEqual([]);
              run.outcome = "resumed with the answer";
              run.observed.push("turn finished with the answer");
            }),
          );
          const failures = finished.filter((result) => result.status === "rejected");
          if (failures.length) throw new AggregateError(failures.map((result) => result.reason));
        });
      } catch (error) {
        await page
          .screenshot({ path: testInfo.outputPath("before-cleanup.png"), fullPage: true })
          .catch(() => undefined);
        throw error;
      } finally {
        const summary = runs.map((run) => ({
          case: run.testCase.id,
          outcome: run.outcome ?? "incomplete",
          observed: run.observed,
        }));
        log(JSON.stringify(summary));
        await testInfo.attach("paused-interactions", {
          body: JSON.stringify(summary, null, 2),
          contentType: "application/json",
        });
        await page.goto("about:blank").catch(() => undefined);
      }
    });
  });
});

// Exercise the ownership boundary with real environments, without a provider turn.
for (const stage of ["after creation", "before layout persistence"] as const) {
  test(`setup failure ${stage} cleans up its environment`, async ({ page }) => {
    test.skip(!ENABLED, "requires the disposable paused-interactions profile");
    const { invoke, fixture } = await connect(page);
    const cleanup: string[] = [];
    let created: Environment | undefined;
    const injected = new Error(`injected failure ${stage}`);
    let caught: unknown;
    try {
      await withEnvironmentCleanup(
        async (command, args) => {
          cleanup.push(command);
          return invoke(command, args);
        },
        async (register) => {
          created = await invoke<Environment>("create_environment", {
            projectId: fixture.id,
            name: `pause-cleanup-${Date.now()}`,
            environmentType: "local",
          });
          register(created.id);
          if (stage === "before layout persistence") {
            await invoke("start_environment", { environmentId: created.id });
            created = await invoke<Environment>("get_environment", { environmentId: created.id });
            expect(created.worktreePath).toBeTruthy();
          }
          throw injected;
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([injected]);
    expect(cleanup).toEqual(["stop_environment", "delete_environment"]);
    const remaining = await invoke<Environment[]>("get_environments", { projectId: fixture.id });
    expect(remaining.some((environment) => environment.id === created!.id)).toBe(false);
    if (created!.worktreePath) expect(existsSync(created!.worktreePath)).toBe(false);
  });
}

/** An option button's name is its label followed by its description. */
function startsWith(label: string): RegExp {
  return new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
}

/** Answer the card the way a user would: the codeword, or allow once. */
async function answer(page: Page, request: AgentInteractionRequest, testCase: Case) {
  const question = request.presentation.questions[0];
  if (testCase.kind === "question") {
    const card = page.getByTestId("agent-question-card");
    await expect(card).toBeVisible({ timeout: 60_000 });
    const option = question?.options.find((item) => item.label.includes(CODEWORD));
    if (option) {
      await card
        .getByRole("button", { name: startsWith(option.label) })
        .first()
        .click();
    } else {
      await card.getByRole("textbox").first().fill(CODEWORD);
    }
    await card
      .getByRole("button", { name: request.presentation.confirmLabel ?? "Submit", exact: true })
      .click();
    return;
  }
  // Only a required choice (an agent's own options) needs a pick. An optional
  // question is a broader grant: Codex's "Approve with command policy" writes
  // a durable execpolicy rule into the provider home, which allow-once must
  // never do, so neither it nor any option carrying an amendment is chosen.
  const allow = approvalOption(question);
  if (allow) {
    await page
      .getByRole("button", { name: startsWith(allow.label) })
      .first()
      .click();
  }
  await page
    .getByRole("button", { name: request.presentation.confirmLabel ?? "Continue", exact: true })
    .click();
}
