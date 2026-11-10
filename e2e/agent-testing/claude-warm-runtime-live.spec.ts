/**
 * One warm Claude CLI through the app (todo 0005 task 8,
 * docs/todo/agent-engines/0005-mid-turn-steer-and-interrupt.md).
 *
 * The bridge numbers every Claude CLI it launches and serves that number as
 * `runtimeGeneration` in `/session/:id/runtime-health`; the backend carries it
 * into the session projection, which is what this spec reads. With the
 * profile's real Claude CLI, bridge and backend sent to the scripted loopback
 * model (`mcp-fake-model.ts`), one Claude tab takes, in order:
 *
 * 1. a first turn, then a follow-up;
 * 2. plan mode switched on through the composer's controls, then off again,
 *    each confirmed by what the CLI told the model (its plan-mode reminder);
 * 3. a Bash call parked for approval, left parked for a while, then approved;
 * 4. the approval mode changed to accept edits, after which a file write runs
 *    without asking;
 * 5. a stdio MCP server added with "save and apply" and called, then removed
 *    and refused;
 * 6. the approval mode changed to bypass, which is launch-only, so the CLI is
 *    replaced and the generation must advance.
 *
 * The asking approval mode is chosen before the first prompt, because a
 * session starts in bypass mode and leaving it is launch-only too. After
 * steps 1 to 5 it waits out the backend's runtime-metadata cache and requires
 * the same generation as after the first turn. Each effect is read
 * from where it happened (the file on disk, the probe server's log, the
 * interaction list), never from the model's wording.
 *
 * Opt-in (`ORKESTRATOR_AGENT_TEST_LIVE_WARM_CLAUDE=1`) against a credential-free
 * agent-test profile of its own, local environments only:
 *
 *   mise run dev:test --profile wrm8 --fixture --no-agent-credentials --agent-platforms claude --headless
 *   ORKESTRATOR_AGENT_TEST_PROFILE=wrm8 ORKESTRATOR_AGENT_TEST_LIVE_WARM_CLAUDE=1 \
 *     mise run test:logged -- --name warm-claude -- \
 *     bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts \
 *     claude-warm-runtime-live.spec.ts --workers=1
 *
 * No login is used and nothing is billed. Evidence (generations, outcomes,
 * interaction kinds, apply states) goes to
 * `output/agent-testing/<run>/claude-warm-runtime/summary.json`; prompts,
 * replies and file contents are fixture strings and are not written there.
 */
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { expect, test, type Page } from "./browser-test";
import {
  dispatchProbeTurn,
  invokeCommand,
  parseProbeLog,
  PROBE_SERVER_NAME,
  probePrompt,
  TRANSIENT_APPLY_STATES,
} from "./mcp-apply-live-support";
import { startMcpFakeModel, type McpFakeModelHandle } from "./mcp-fake-model-wiring";

type Status = {
  status: string;
  profile?: string;
  flavor?: string;
  dataDir?: string;
  browserUrl?: string;
  testProject?: string;
};
type Project = { id: string; localPath: string | null };
type Environment = { id: string; name: string; worktreePath?: string | null };
type Message = { id: string; role: string; content?: unknown; parts?: unknown };
type Interaction = { id: string; sessionId: string; kind: string; state: string };
type Projection = {
  sessionId?: string;
  turn: { phase: string; error?: string };
  runtime?: { state?: string; runtimeGeneration?: number };
  runtimeHealthAuthoritative?: boolean;
  composer?: { approvalModes?: Array<{ id: string; label?: string }> };
  messages: Message[];
  interactions?: Interaction[];
};
type Source = { sourceId: string; scope: string; writable: boolean; revision: string | null };
type Definition = { entryId: string; sourceId: string; name: string };
type Target = { targetId: string; provider: string; context: { environmentId?: string } };
type Snapshot = { sources: Source[]; definitions: Definition[] };
type Operation = {
  operationId: string;
  phase: string;
  apply: { state: string; runtimes: Array<{ label: string; state: string; reason?: string }> };
};
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

type StepRecord = {
  step: string;
  generation?: number;
  state?: string;
  passed: boolean;
  checks: Record<string, unknown>;
  failure?: string;
};

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "wrm8";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const LIVE = process.env.ORKESTRATOR_AGENT_TEST_LIVE_WARM_CLAUDE === "1";
const TURN_TIMEOUT_MS = 180_000;
/** The backend keeps a runtime-health read this long (`INTERACTIVE_RUNTIME_METADATA_TTL_MS`). */
const METADATA_TTL_MS = 30_000;
/** How long the approval stays parked before it is answered. */
const APPROVAL_PAUSE_MS = 20_000;
const APPLY_SETTLE_MS = 120_000;
const PROBE_SERVER = path.join(import.meta.dirname, "mcp-probe-server.mjs");
/** Matches `PROBE_SERVER_NAME`, so an interrupted run's entry is cleaned up by either spec. */
const SERVER = "mqu8_warm";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function profileStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) {
    throw new Error(`dev:status for "${profile}" returned no manifest: ${command.stderr.trim()}`);
  }
  return JSON.parse(command.stdout) as Status;
}

async function signIn(page: Page, status: Status): Promise<Invoke> {
  // The one-shot login URL is parsed in memory and never copied into output.
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(command.stderr || "dev:login failed");
  const login = JSON.parse(command.stdout) as { loginUrl?: unknown };
  if (typeof login.loginUrl !== "string") throw new Error("dev:login returned no login URL");
  const response = await page.goto(login.loginUrl, { waitUntil: "domcontentloaded" });
  expect(response?.ok() ?? false).toBe(true);
  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const invokeResponse = await invokeCommand(
      command,
      () =>
        page.request.post(new URL("/__orkestrator/invoke", status.browserUrl!).href, {
          data: { command, args },
          timeout: 240_000,
        }),
      () => sleep(1_000),
    );
    if (!invokeResponse.ok()) {
      throw new Error(`${command}: ${(await invokeResponse.text()).slice(0, 1_000)}`);
    }
    return ((await invokeResponse.json()) as { result: T }).result;
  };
}

function textOf(message: Message): string {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const fromParts = parts
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("\n");
  if (fromParts.trim()) return fromParts;
  return typeof message.content === "string" ? message.content : "";
}

function token(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

// Twenty minutes of polling makes a trace past the artifact sanitiser's 64 MiB
// bound, which fails the run's teardown; the summary is the evidence.
test.use({ trace: "off" });

test.describe("warm Claude CLI app path", () => {
  test.skip(
    !LIVE,
    "opt-in loopback-model turns against an isolated profile; set ORKESTRATOR_AGENT_TEST_LIVE_WARM_CLAUDE=1",
  );

  test("follow-up, plan mode, approval, approval mode and MCP changes keep one CLI", async ({
    page,
  }, testInfo) => {
    test.setTimeout(30 * 60_000);
    const steps: StepRecord[] = [];
    const failures: string[] = [];
    const summary: Record<string, unknown> = {
      profile,
      startedAt: new Date().toISOString(),
      fakeModel: "scripted loopback Anthropic endpoint; no login, nothing billed",
      steps,
      failures,
    };
    const outputDir = path.join(repositoryRoot, "output", "agent-testing", runId);
    const scratch = mkdtempSync(path.join(os.tmpdir(), "wrm8-"));
    let fake: McpFakeModelHandle | null = null;
    let invoke: Invoke | null = null;
    let environmentId: string | null = null;
    try {
      const status = profileStatus();
      expect(status.profile).toBe(profile);
      expect(status.status, `profile "${profile}" is not running`).toBe("ready");
      expect(status.flavor, "runs only in an agent-test profile").toBe("agent-test");
      // Before the environment exists, so its bridge's first CLI reads it.
      fake = await startMcpFakeModel("claude", status.dataDir!);
      summary.fakeModelFiles = fake.files;
      invoke = await signIn(page, status);
      const call = invoke;
      const fixture = (await call<Project[]>("get_projects")).find(
        (project) => project.localPath === status.testProject,
      );
      expect(fixture, `the ${profile} fixture project is missing`).toBeTruthy();
      for (const stale of await call<Environment[]>("get_environments", {
        projectId: fixture!.id,
      })) {
        if (!stale.name.startsWith("wrm8-")) continue;
        await call("stop_environment", { environmentId: stale.id }).catch(() => undefined);
        await call("delete_environment", { environmentId: stale.id }).catch(() => undefined);
      }
      const created = await call<Environment>("create_environment", {
        projectId: fixture!.id,
        name: `wrm8-${Date.now()}`,
        networkAccessMode: "restricted",
        environmentType: "local",
      });
      environmentId = created.id;
      await call("start_environment", { environmentId });
      const environment = await call<Environment>("get_environment", { environmentId });
      const worktree = environment.worktreePath;
      expect(worktree, "the environment has a worktree").toBeTruthy();

      const tab = "wrm8-claude";
      const layout = await call<{ revision?: number } | null>("get_pane_layout", {
        environmentId,
      });
      await call("save_pane_layout", {
        environmentId,
        expectedRevision: layout?.revision ?? 0,
        layout: {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "pane-wrm8",
          root: {
            kind: "leaf",
            id: "pane-wrm8",
            activeTabId: tab,
            tabs: [
              {
                id: tab,
                type: "agent-native",
                displayTitle: "Warm Claude",
                nativeAgentData: { environmentId, platform: "claude", isLocal: true },
              },
            ],
          },
        },
      });
      const identity = {
        environmentId,
        agent: "claude",
        logicalSessionKey: `env-${environmentId}:${tab}`,
      };
      const projection = () =>
        call<Projection | null>("get_native_agent_projection", { ...identity, messageLimit: 200 });
      await call("ensure_native_agent_session", identity);

      // The composer's own route for a control change.
      const controls = (update: Record<string, unknown>) =>
        call<Projection | null>("update_native_agent_controls", { ...identity, update });

      /** The card's Approve button; answers the apply result. */
      const approve = async (request: Interaction) => {
        const outcome = await call<{ result?: string }>("resolve_native_agent_interaction", {
          ...identity,
          interactionId: request.id,
          resolution: {
            version: 1,
            interactionId: request.id,
            sessionId: request.sessionId,
            action: "answer",
            // What the card sends: Claude approvals ask no questions.
            answer: {
              version: 1,
              interactionId: request.id,
              sessionId: request.sessionId,
              answers: [],
            },
            resolvedAt: Date.now(),
          },
        });
        return outcome?.result ?? "no result";
      };

      let mode: "build" | "plan" = "build";
      /** Dispatch one prompt as the composer does and wait for it to settle. */
      const runTurn = async (
        prompt: string,
        options: { onInteraction?: (request: Interaction) => Promise<void> } = {},
      ) => {
        const before = await projection();
        const previous = new Set((before?.messages ?? []).map((message) => message.id));
        const dispatch = await dispatchProbeTurn(
          (requestId) =>
            call<{ outcome: string; error?: string }>("dispatch_native_agent_intent", {
              ...identity,
              prompt,
              requestId,
              mode,
            }),
          randomUUID,
          () => sleep(3_000),
        );
        if (dispatch.outcome !== "accepted") {
          return { reply: "", error: `dispatch ${dispatch.outcome}`, interactions: [] as string[] };
        }
        const deadline = Date.now() + TURN_TIMEOUT_MS;
        const handled = new Set<string>();
        const interactions: string[] = [];
        let idleReads = 0;
        for (;;) {
          const current = await projection();
          for (const request of current?.interactions ?? []) {
            if (request.state !== "pending" || handled.has(request.id)) continue;
            handled.add(request.id);
            interactions.push(request.kind);
            if (options.onInteraction) await options.onInteraction(request);
            else {
              await call("resolve_native_agent_interaction", {
                ...identity,
                interactionId: request.id,
                resolution: {
                  version: 1,
                  interactionId: request.id,
                  sessionId: request.sessionId,
                  action: "deny",
                  resolvedAt: Date.now(),
                },
              }).catch(() => undefined);
            }
          }
          const fresh = (current?.messages ?? []).filter((message) => !previous.has(message.id));
          const reply = fresh
            .filter((message) => message.role === "assistant")
            .map(textOf)
            .join("\n")
            .trim();
          const phase = current?.turn.phase ?? "idle";
          idleReads = phase === "idle" ? idleReads + 1 : 0;
          if (phase === "error") {
            return { reply, error: current?.turn.error ?? "turn error", interactions };
          }
          if (idleReads >= 2 && reply) return { reply, interactions };
          if (Date.now() > deadline) {
            return { reply, error: `no settled reply (phase ${phase})`, interactions };
          }
          await sleep(1_000);
        }
      };

      /**
       * The generation as the app shows it, read after the backend's cache of
       * the previous read has expired, so a changed CLI cannot hide behind it.
       */
      const freshGeneration = async () => {
        await sleep(METADATA_TTL_MS + 2_000);
        // A read past the cache's expiry answers with the cached value and
        // refreshes it in the background, so only a second, later read is
        // fresh. Two agreeing reads after that are the answer.
        await projection();
        const deadline = Date.now() + 30_000;
        let last: { generation?: number; state?: string } | undefined;
        for (;;) {
          await sleep(2_000);
          const current = await projection();
          const read = {
            generation: current?.runtime?.runtimeGeneration,
            state: current?.runtime?.state,
          };
          const usable =
            current?.runtimeHealthAuthoritative !== false && read.generation !== undefined;
          if (usable && last?.generation === read.generation && last?.state === read.state) {
            return read;
          }
          last = usable ? read : undefined;
          if (Date.now() > deadline) return read;
        }
      };

      let baseline: number | undefined;
      const record = async (step: string, checks: Record<string, unknown>, failure?: string) => {
        const { generation, state } = await freshGeneration();
        const problems = [
          ...(failure ? [failure] : []),
          ...(generation === undefined ? ["the projection carried no runtime generation"] : []),
          ...(state !== "attached" ? [`the CLI was ${state ?? "unreported"}, not attached`] : []),
          ...(baseline !== undefined && generation !== baseline
            ? [`generation ${generation} after the step, ${baseline} after the first turn`]
            : []),
        ];
        const entry: StepRecord = {
          step,
          ...(generation !== undefined ? { generation } : {}),
          ...(state ? { state } : {}),
          passed: problems.length === 0,
          checks,
          ...(problems.length ? { failure: problems.join("; ") } : {}),
        };
        steps.push(entry);
        if (problems.length) failures.push(`${step}: ${problems.join("; ")}`);
        console.log(`[warm-claude] ${step}: ${entry.passed ? "passed" : entry.failure}`);
        return generation;
      };

      // The approval modes the composer offers. A session starts in bypass
      // mode, and leaving bypass is launch-only (the CLI's
      // `allowDangerouslySkipPermissions`), so the asking mode is chosen in the
      // composer before the first prompt, as a user would.
      const offered = (await projection())?.composer?.approvalModes?.map((entry) => entry.id) ?? [];
      summary.approvalModes = offered;
      const asks = offered.includes("default") ? "default" : undefined;
      if (asks) await controls({ approvalMode: asks });
      else failures.push("approval: the composer offers no `default` approval mode");

      // 1. First turn, then a follow-up into the same CLI.
      const first = await runTurn("Reply with exactly READY. Do not use any tools.");
      baseline = await record(
        "first turn",
        { reply: first.reply === "READY" },
        first.error ?? (first.reply === "READY" ? undefined : "unexpected reply"),
      );
      expect(baseline, "the app shows a runtime generation after the first turn").toBeDefined();
      const follow = await runTurn("Reply with exactly AGAIN. Do not use any tools.");
      await record(
        "follow-up",
        { reply: follow.reply === "AGAIN" },
        follow.error ?? (follow.reply === "AGAIN" ? undefined : "unexpected reply"),
      );

      // 2. Plan mode on, then off, through the composer's controls.
      const planCheck = async (step: string, expected: "on" | "off") => {
        const marker = token("WRM");
        const result = await runTurn(`Report the plan mode marker ${marker} and nothing else.`);
        const seen = new RegExp(`${marker} plan-mode=(on|off)`).exec(result.reply)?.[1];
        await record(
          step,
          { mode, cliSawPlanMode: seen ?? "no marker" },
          result.error ?? (seen === expected ? undefined : `the CLI reported plan mode ${seen}`),
        );
      };
      await controls({ mode: "plan" });
      mode = "plan";
      await planCheck("plan mode on", "on");
      await controls({ mode: "build" });
      mode = "build";
      await planCheck("plan mode off", "off");

      // 3. A Bash call parked for approval, answered after a pause.
      if (asks) {
        const approvedFile = path.join(worktree!, `${token("wrm-approved").toLowerCase()}.txt`);
        let parkedGeneration: number | undefined;
        let parkedFor = 0;
        let answered: string | undefined;
        const result = await runTurn(
          `Use your shell tool to run the command \`printf ok > '${approvedFile}'\` once, in the foreground (not as a background task), and wait for it to finish. Then reply with exactly BUSY-DONE.`,
          {
            onInteraction: async (request) => {
              const parkedAt = Date.now();
              // Still parked, and still the same CLI, while nobody answers.
              await sleep(APPROVAL_PAUSE_MS);
              parkedGeneration = (await freshGeneration()).generation;
              const still = (await projection())?.interactions?.some(
                (entry) => entry.id === request.id && entry.state === "pending",
              );
              parkedFor = Date.now() - parkedAt;
              if (!still)
                failures.push("approval: the request was no longer pending after the pause");
              answered = await approve(request);
            },
          },
        );
        const ran = existsSync(approvedFile);
        await record(
          "parked approval answered after a pause",
          {
            approvalMode: asks,
            interactions: result.interactions,
            parkedForSeconds: Math.round(parkedFor / 1000),
            resolution: answered ?? "not answered",
            generationWhileParked: parkedGeneration ?? null,
            commandRan: ran,
          },
          result.error ??
            (answered !== "applied"
              ? `the approval answered ${answered ?? "nothing"}`
              : result.interactions.length !== 1
                ? `expected one approval, saw ${result.interactions.length}`
                : !ran
                  ? "the approved command did not run"
                  : parkedGeneration !== baseline
                    ? `generation ${parkedGeneration} while parked`
                    : undefined),
        );
      }

      // 4. Accept edits: a file write now runs without asking.
      const edits = offered.includes("acceptEdits") ? "acceptEdits" : undefined;
      if (!edits) failures.push("approval mode: the composer offers no `acceptEdits` mode");
      else {
        await controls({ approvalMode: edits });
        const writtenFile = path.join(worktree!, `${token("wrm-written").toLowerCase()}.txt`);
        const content = token("WRM");
        const result = await runTurn(
          `Use your file write tool to create the file \`${writtenFile}\` containing exactly \`${content}\`, then reply with exactly WRITE-DONE.`,
        );
        const written = existsSync(writtenFile) && readFileSync(writtenFile, "utf8") === content;
        await record(
          "approval mode changed to accept edits",
          { approvalMode: edits, interactions: result.interactions, fileWritten: written },
          result.error ??
            (result.interactions.length > 0
              ? `the write asked for approval (${result.interactions.join(",")})`
              : !written
                ? "the file was not written"
                : undefined),
        );
      }

      // 5. An MCP server added and removed between turns.
      const target = (
        await call<{ targets: Target[] }>("list_mcp_management_targets", { environmentId })
      ).targets.find(
        (entry) => entry.provider === "claude" && entry.context.environmentId === environmentId,
      );
      const snapshot = () =>
        call<Snapshot>("get_mcp_management_snapshot", { targetId: target!.targetId });
      const source = target
        ? (await snapshot()).sources.find(
            (entry) => entry.scope === "backend-user" && entry.writable,
          )
        : undefined;
      summary.mcpSource = source ? source.scope : "none";
      if (!target || !source) {
        failures.push("mcp: no writable Orkestrator user MCP source for the Claude target");
      } else {
        const logFile = path.join(scratch, "probe-log.jsonl");
        writeFileSync(logFile, "");
        const entryNamed = async () => {
          const current = await snapshot();
          return {
            revision: current.sources.find((entry) => entry.sourceId === source.sourceId)!.revision,
            definition: current.definitions.find(
              (entry) => entry.sourceId === source.sourceId && entry.name === SERVER,
            ),
          };
        };
        // An interrupted run's entry would shadow this one.
        const leftover = await entryNamed();
        if (leftover.definition && PROBE_SERVER_NAME.test(SERVER)) {
          await call("mutate_mcp_definition", {
            mutation: {
              requestId: randomUUID(),
              targetId: target.targetId,
              applyIntent: "save",
              operation: {
                kind: "remove",
                entryId: leftover.definition.entryId,
                expectedRevision: leftover.revision,
              },
            },
          });
        }
        const apply = async (operation: Record<string, unknown>) => {
          const result = await call<{ operation: Operation }>("mutate_mcp_definition", {
            mutation: {
              requestId: randomUUID(),
              targetId: target.targetId,
              applyIntent: "save-and-apply",
              operation,
            },
          });
          const deadline = Date.now() + APPLY_SETTLE_MS;
          let settled = result.operation;
          while (
            Date.now() < deadline &&
            settled.apply.runtimes.some((runtime) => TRANSIENT_APPLY_STATES.has(runtime.state))
          ) {
            await sleep(2_000);
            settled = await call<Operation>("get_mcp_operation", {
              operationId: result.operation.operationId,
            });
          }
          return settled.apply.runtimes.map((runtime) => runtime.state);
        };
        const probe = async (reach: boolean) => {
          const nonce = token("MQ");
          // Accept edits still asks before an MCP tool runs; approve it as a
          // user would, and record that it asked.
          const answers: string[] = [];
          const result = await runTurn(probePrompt(SERVER, nonce), {
            onInteraction: async (request) => {
              answers.push(await approve(request));
            },
          });
          await sleep(500);
          const called = parseProbeLog(readFileSync(logFile, "utf8")).some(
            (event) => event.event === "call" && event.nonce === nonce,
          );
          return {
            called,
            interactions: result.interactions,
            answers,
            failure:
              result.error ??
              (called === reach
                ? undefined
                : reach
                  ? "the added server's tool was not called"
                  : "the removed server's tool was still called"),
          };
        };

        const added = await apply({
          kind: "add",
          sourceId: source.sourceId,
          expectedRevision: (await entryNamed()).revision,
          definition: {
            name: SERVER,
            transport: "stdio",
            command: process.execPath,
            args: [PROBE_SERVER, "--label", SERVER, "--tag", "v1", "--log", logFile],
          },
        });
        const reached = await probe(true);
        await record(
          "MCP server added between turns",
          {
            applyStates: added,
            toolCalled: reached.called,
            interactions: reached.interactions,
            answers: reached.answers,
          },
          reached.failure,
        );
        const current = await entryNamed();
        const removed = current.definition
          ? await apply({
              kind: "remove",
              entryId: current.definition.entryId,
              expectedRevision: current.revision,
            })
          : [];
        const refused = await probe(false);
        await record(
          "MCP server removed between turns",
          {
            applyStates: removed,
            toolCalled: refused.called,
            interactions: refused.interactions,
            answers: refused.answers,
          },
          refused.failure ?? (current.definition ? undefined : "the added entry was not found"),
        );
      }

      // 6. A launch-only change: switching to bypass mode needs a CLI started
      // with it, so the idle CLI is retired and the generation must advance.
      if (offered.includes("bypassPermissions") && baseline !== undefined) {
        await controls({ approvalMode: "bypassPermissions" });
        const result = await runTurn("Reply with exactly BYPASS. Do not use any tools.");
        const before = baseline;
        baseline = undefined;
        const after = await record(
          "launch-only change (bypass mode) starts a new CLI",
          { reply: result.reply === "BYPASS", previousGeneration: before },
          result.error ?? (result.reply === "BYPASS" ? undefined : "unexpected reply"),
        );
        if (after === undefined || after <= before) {
          failures.push(`launch-only change: generation ${after} did not advance past ${before}`);
          steps.at(-1)!.passed = false;
        }
      }

      // What a user sees: the generation beside the CLI's state in Agent Info.
      try {
        await page.goto(status.browserUrl!, { waitUntil: "domcontentloaded" });
        // A credential-free profile reports no Claude login, and a host
        // without Docker access says so too; each dialog offers to carry on.
        await page.waitForTimeout(4_000);
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const carryOn = page.getByRole("button", { name: /^Continue Without/ }).first();
          if (!(await carryOn.isVisible().catch(() => false))) break;
          await carryOn.click();
          await page.waitForTimeout(1_000);
        }
        await page.getByText(environment.name, { exact: true }).first().click({ timeout: 30_000 });
        await page
          .getByRole("button", { name: "Open agent information" })
          .click({ timeout: 30_000 });
        await page.getByTestId("agent-runtime-generation").waitFor({ timeout: 30_000 });
        const previews = path.join(repositoryRoot, "output", "visual-previews");
        mkdirSync(previews, { recursive: true });
        const shot = path.join(previews, "agent-info-runtime-generation.png");
        await page.screenshot({ path: shot });
        summary.screenshot = path.relative(repositoryRoot, shot);
      } catch (error) {
        summary.screenshot = `not captured: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200)}`;
      }
    } finally {
      summary.finishedAt = new Date().toISOString();
      summary.verdict = failures.length === 0 && steps.length > 0 ? "passed" : "failed";
      mkdirSync(path.join(outputDir, "claude-warm-runtime"), { recursive: true });
      writeFileSync(
        path.join(outputDir, "claude-warm-runtime", "summary.json"),
        `${JSON.stringify(summary, null, 2)}\n`,
      );
      await testInfo.attach("summary", {
        body: JSON.stringify(summary, null, 2),
        contentType: "application/json",
      });
      if (invoke && environmentId) {
        await invoke("stop_environment", { environmentId }).catch(() => undefined);
        await invoke("delete_environment", { environmentId }).catch(() => undefined);
      }
      if (fake) await fake.stop();
      rmSync(scratch, { recursive: true, force: true });
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});
