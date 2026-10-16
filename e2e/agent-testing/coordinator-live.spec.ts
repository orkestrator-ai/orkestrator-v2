/**
 * Live coordinator read-only scenario against a real `dev:test --fixture`
 * profile, one case per platform on the live suite's list.
 *
 * Opt-in only: each case runs a real coordinator turn on the host's
 * credentials, so every case is skipped unless
 * `ORKESTRATOR_AGENT_TEST_LIVE_COORDINATOR=1`. Run it through
 * `mise run test:agent:coordinator`, which starts one disposable profile per
 * platform. Nothing at module scope spawns `mise` or reads profile state.
 *
 * Each case assigns the platform to a fresh main coordinator conversation on
 * the fixture project, through the same backend commands the Coordinator page
 * uses, so the real coordinator policy, bridge and Control MCP credential are
 * in play. The turn is sent in build mode (see the dispatch below). It digests
 * the checkout, asks the agent to attempt one mutation of
 * each class (file write, edit, writing shell command, commit, an Orkestrator
 * tool aimed at the checkout, a network fetch) and then to read a canary file
 * and a canary ticket, and asserts that the checkout is unchanged, that no
 * attempt is reported to have succeeded or been skipped, and that both canary
 * values came back. A platform without a usable credential is skipped with the
 * reason recorded, never passed.
 *
 * The case writes a content-free summary to
 * `output/agent-testing/<run>/coordinator/<platform>.json`, which the runner
 * aggregates. It never records prompts, file contents or tool output.
 */
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  type AgentInteractionKind,
  type AgentInteractionRequest,
} from "@orkestrator/protocol/agent-interactions";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  coordinatorMainConversation,
  coordinatorRuntimeId,
  type CoordinatorSnapshot,
} from "@orkestrator/protocol/coordinator";
import type { NativeAgentAuthState, NativeAgentNotice } from "@orkestrator/protocol/native-agent";

import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import {
  COORDINATOR_LIVE_OPT_IN_ENV,
  COORDINATOR_LIVE_PLATFORMS_ENV,
  READ_ONLY_REPORT_MARKER,
  coordinatorLivePlatformsFromEnv,
  coordinatorLiveSummaryFile,
  describeDigestChanges,
  evaluateReadOnlyRun,
  fixtureTreeDigest,
  parseReadOnlyReport,
  readOnlyScenarioPrompt,
  type CoordinatorLivePlatformSummary,
  type ReadOnlyProbe,
  type ReadOnlyToolCall,
} from "../../apps/desktop/scripts/dev/coordinator-live";

type Status = {
  status: string;
  profile?: string;
  flavor?: string;
  browserUrl?: string;
  dataDir?: string;
  testProject?: string;
};
type Project = { id: string; name: string; localPath: string | null };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type TranscriptMessage = { role?: unknown; content?: unknown; parts?: unknown };
type Projection = {
  turn: { phase: string; error?: string };
  messages: TranscriptMessage[];
  interactions?: AgentInteractionRequest[];
  notices?: NativeAgentNotice[];
};
type SessionIdentity = { environmentId: string; agent: AgentPlatform; logicalSessionKey: string };

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const LIVE = process.env[COORDINATOR_LIVE_OPT_IN_ENV] === "1";
const TURN_TIMEOUT_MS =
  Number(process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_TURN_TIMEOUT_MS) || 600_000;
const POLL_INTERVAL_MS = 2_000;
/**
 * A live turn prints nothing for minutes. `test:logged` kills a command after
 * five minutes without output, so the wait reports progress well inside that.
 */
const HEARTBEAT_MS = 60_000;
const SIGNED_OUT: ReadonlySet<NativeAgentAuthState> = new Set([
  "signed-out",
  "needs-auth",
  "expired",
]);
/**
 * Provider errors that mean "no usable login", which is a skip rather than a
 * failure. Deliberately narrow: an unrecognised error fails visibly instead of
 * being mistaken for a missing credential.
 */
const SIGN_IN_ERROR =
  /\b(not (signed|logged) in|sign[ -]?in required|signed[ -]out|log[ -]?in required|unauthori[sz]ed|authentication (failed|required)|invalid api key|no api key|credentials? (missing|not found|expired))\b/i;
/** Kinds that ask to be allowed to act; anything else (a question) is cancelled. */
const APPROVAL_KINDS: ReadonlySet<AgentInteractionKind> = new Set([
  "command-approval",
  "file-approval",
  "permission",
  "plan-approval",
]);
const CANARY_FILE = "coordinator-live-canary.txt";

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

async function authenticatedInvoke(page: Page, status: Status): Promise<Invoke> {
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
    const result = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl!).href,
      { data: { command, args } },
    );
    const text = await result.text();
    if (!result.ok()) throw new Error(`${command}: ${text.slice(0, 500)}`);
    return (JSON.parse(text) as { result: T }).result;
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
  return { checkout: status.testProject!, invoke, fixture: fixture! };
}

function assistantText(messages: readonly TranscriptMessage[]): string {
  const texts: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string" && message.content) {
      texts.push(message.content);
      continue;
    }
    for (const part of Array.isArray(message.parts) ? message.parts : []) {
      const record = part as { type?: unknown; content?: unknown };
      if (record.type === "text" && typeof record.content === "string") texts.push(record.content);
    }
  }
  return texts.join("\n");
}

type ToolCall = ReadOnlyToolCall & { state: string };

/**
 * Every tool call, including sub-agent and grouped tools. Arguments are kept
 * for the evaluation only and never written to the summary.
 */
function toolCalls(messages: readonly TranscriptMessage[]): ToolCall[] {
  const calls: ToolCall[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 8 || calls.length >= 200) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.toolName === "string") {
      calls.push({
        name: record.toolName.slice(0, 120),
        state: typeof record.toolState === "string" ? record.toolState : "unknown",
        args: (JSON.stringify(record.toolArgs ?? record.title ?? null) ?? "").slice(0, 4_000),
      });
    }
    for (const field of ["childTools", "subagentActions"]) visit(record[field], depth + 1);
  };
  for (const message of messages) visit(message.parts, 0);
  return calls;
}

function authProblem(projection: Projection | null): string | undefined {
  const notice = projection?.notices?.find(
    (item): item is Extract<NativeAgentNotice, { kind: "auth" }> =>
      item.kind === "auth" && SIGNED_OUT.has(item.state),
  );
  return notice ? notice.state : undefined;
}

/**
 * Wait for the coordinator's turn to end, answering nothing on its behalf.
 *
 * A coordinator's approvals are denied by its policy, so a request that does
 * reach the session is denied here (or cancelled, for a question) rather than
 * left to hold the turn open until the deadline.
 */
async function settleTurn(
  invoke: Invoke,
  identity: SessionIdentity,
  summary: CoordinatorLivePlatformSummary,
): Promise<Projection> {
  const started = Date.now();
  const deadline = started + TURN_TIMEOUT_MS;
  let nextHeartbeat = started + HEARTBEAT_MS;
  let sawActive = false;
  let idleReads = 0;
  const answered = new Set<string>();
  for (;;) {
    const projection = await invoke<Projection | null>("get_native_agent_projection", {
      ...identity,
      messageLimit: 200,
    });
    const phase = projection?.turn.phase ?? "idle";
    if (phase !== "idle") sawActive = true;
    idleReads = phase === "idle" ? idleReads + 1 : 0;
    for (const request of projection?.interactions ?? []) {
      if (request.state !== "pending" || answered.has(request.id)) continue;
      answered.add(request.id);
      await invoke("resolve_native_agent_interaction", {
        ...identity,
        interactionId: request.id,
        resolution: {
          version: AGENT_INTERACTION_CONTRACT_VERSION,
          interactionId: request.id,
          sessionId: request.sessionId,
          action: APPROVAL_KINDS.has(request.kind) ? "deny" : "cancel",
          resolvedAt: Date.now(),
        },
      }).catch(() => undefined);
    }
    summary.interactionsDenied = answered.size;
    if (projection && phase === "error") return projection;
    // A fresh session has no assistant message until this turn writes one, so
    // a reply also proves the turn ran if it finished between two reads. Idle
    // must hold for two reads, so a provider that drops to idle between steps
    // is not cut off.
    const replied = projection?.messages.some((message) => message.role === "assistant");
    if (projection && idleReads >= 2 && (sawActive || replied)) return projection;
    const now = Date.now();
    if (now >= deadline) {
      throw new Error(
        `the ${identity.agent} coordinator turn did not finish within ${TURN_TIMEOUT_MS / 1_000}s (phase ${phase})`,
      );
    }
    if (now >= nextHeartbeat) {
      console.log(
        `[coordinator-live] ${identity.agent}: turn ${phase} for ${Math.round((now - started) / 1_000)}s, ${toolCalls(projection?.messages ?? []).length} tool calls so far`,
      );
      nextHeartbeat = now + HEARTBEAT_MS;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function writeSummary(summary: CoordinatorLivePlatformSummary): Promise<void> {
  const file = coordinatorLiveSummaryFile(repositoryRoot, runId, summary.platform);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
}

test.describe("live coordinator", () => {
  test.skip(
    !LIVE,
    `opt-in: ${COORDINATOR_LIVE_OPT_IN_ENV}=1 runs real coordinator turns on host credentials; use mise run test:agent:coordinator`,
  );

  for (const entry of coordinatorLivePlatformsFromEnv(
    process.env[COORDINATOR_LIVE_PLATFORMS_ENV],
  )) {
    const { platform } = entry;
    test(`read-only boundary holds on ${platform}: every mutation is refused, the checkout is unchanged and discovery returns`, async ({
      page,
    }) => {
      test.setTimeout(TURN_TIMEOUT_MS + 240_000);
      page.setDefaultTimeout(30_000);
      const summary: CoordinatorLivePlatformSummary = {
        version: 1,
        platform,
        verdict: "failed",
        tierSetting: entry.tierSetting,
        startedAt: new Date().toISOString(),
      };
      const started = Date.now();
      const skip = (reason: string): never => {
        summary.verdict = "skipped";
        summary.reason = reason;
        test.skip(true, reason);
        throw new Error(reason);
      };
      // Undone last-first in `finally`, whatever happened before.
      const cleanup: Array<() => Promise<unknown>> = [];
      try {
        const { checkout, invoke, fixture } = await openProfile(page);
        const projectId = fixture.id;

        const config = await invoke<{ global: Record<string, unknown> }>("get_config");
        const enabled = config.global.enabledAgentPlatforms;
        if (Array.isArray(enabled) && !enabled.includes(platform)) {
          skip(`${platform} is not enabled in this profile (start it with --agent-platforms)`);
        }
        const previousTier = config.global.coordinatorProviderTiers;
        if (previousTier !== entry.tierSetting) {
          await invoke("update_global_config", {
            global: { ...config.global, coordinatorProviderTiers: entry.tierSetting },
          });
          cleanup.push(async () => {
            const current = await invoke<{ global: Record<string, unknown> }>("get_config");
            await invoke("update_global_config", {
              global: { ...current.global, coordinatorProviderTiers: previousTier },
            });
          });
        }

        // A fresh, unassigned main conversation: a platform is bound by the
        // first prompt and never changes, so an earlier case's main is closed.
        let snapshot = await invoke<CoordinatorSnapshot>("ensure_project_coordinator", {
          projectId,
        });
        const previous = coordinatorMainConversation(snapshot.workspace);
        if (previous?.agent) {
          snapshot = await invoke<CoordinatorSnapshot>("close_coordinator_conversation", {
            projectId,
            conversationId: previous.id,
          });
        }
        if (!coordinatorMainConversation(snapshot.workspace)) {
          snapshot = await invoke<CoordinatorSnapshot>("create_coordinator_conversation", {
            projectId,
          });
        }
        const conversation = coordinatorMainConversation(snapshot.workspace)!;
        const qualification = snapshot.providerAvailability[platform];
        summary.tier = qualification?.tier;
        expect(
          qualification?.available,
          `${platform} is not offered to Coordinator: ${qualification?.reason ?? "no qualification"}`,
        ).toBe(true);
        expect(qualification?.delegation, `${platform} has no delegation`).toBe(true);
        expect(
          snapshot.controlMcp.running,
          `Control MCP is not running: ${snapshot.controlMcp.error ?? "disabled"}`,
        ).toBe(true);

        snapshot = await invoke<CoordinatorSnapshot>("assign_coordinator_conversation_agent", {
          projectId,
          conversationId: conversation.id,
          agent: platform,
        });
        cleanup.push(() =>
          invoke("close_coordinator_conversation", { projectId, conversationId: conversation.id }),
        );
        const identity: SessionIdentity = {
          environmentId: coordinatorRuntimeId(snapshot.workspace.id, conversation.id),
          agent: platform,
          logicalSessionKey: conversation.logicalSessionKey,
        };
        try {
          await invoke("ensure_native_agent_session", identity);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (SIGN_IN_ERROR.test(message)) {
            skip(`no usable ${platform} credential in this profile: ${message.slice(0, 300)}`);
          }
          throw error;
        }
        const auth = await invoke<{ state: NativeAgentAuthState } | null>(
          "get_native_agent_auth_status",
          identity,
        ).catch(() => null);
        if (auth && SIGNED_OUT.has(auth.state)) {
          skip(`no usable ${platform} credential in this profile (${auth.state})`);
        }

        // Canaries reachable only through a working read tool and Control MCP.
        const canaryLine = `coordinator-live-canary-${randomBytes(8).toString("hex")}`;
        await writeFile(path.join(checkout, CANARY_FILE), `${canaryLine}\n`);
        cleanup.push(() => rm(path.join(checkout, CANARY_FILE), { force: true }));
        const ticketTitle = `coordinator-live-discovery-${randomBytes(8).toString("hex")}`;
        const ticket = await invoke<{ id: string }>("add_kanban_task", {
          projectId,
          title: ticketTitle,
          description: "Synthetic ticket read back by the live coordinator read-only scenario.",
        });
        cleanup.push(() => invoke("delete_kanban_task", { taskId: ticket.id }));
        // The project home is the checkout as an environment: the one target a
        // coordinator credential must never act on.
        const home = await invoke<{ id: string }>("ensure_project_home_environment", {
          projectId,
        });
        // The agent is told not to launch workers. One it launches anyway is
        // removed after the checkout has been measured, so it still counts.
        const existing = new Set(
          (await invoke<Array<{ id: string }>>("get_environments", { projectId })).map(
            (environment) => environment.id,
          ),
        );
        cleanup.push(async () => {
          for (const environment of await invoke<Array<{ id: string }>>("get_environments", {
            projectId,
          })) {
            if (existing.has(environment.id)) continue;
            await invoke("stop_environment", { environmentId: environment.id }).catch(
              () => undefined,
            );
            await invoke("delete_environment", { environmentId: environment.id });
          }
        });

        const probe: ReadOnlyProbe = {
          platform,
          canaryFile: CANARY_FILE,
          canaryLine,
          ticketTitle,
          homeEnvironmentId: home.id,
          requestId: `coordinator-live-${randomUUID()}`,
        };
        const before = await fixtureTreeDigest(checkout);
        summary.tree = { before: before.digest };
        // Build mode, not the plan mode a fresh coordinator composer selects:
        // plan mode asks the agent not to try, so the boundary would never be
        // exercised. Build mode is where a coordinator lands after its plan is
        // approved, and the policy has to hold there whatever the agent tries.
        await invoke("dispatch_native_agent_intent", {
          ...identity,
          prompt: readOnlyScenarioPrompt(probe),
          requestId: randomUUID(),
          mode: "build",
        });
        const settled = await settleTurn(invoke, identity, summary);
        const after = await fixtureTreeDigest(checkout);
        summary.tree = {
          before: before.digest,
          after: after.digest,
          changes: describeDigestChanges(before, after),
        };
        const calls = toolCalls(settled.messages);
        summary.toolCalls = calls.map(({ name, state }) => ({ name, state }));
        summary.turn = {
          phase: settled.turn.phase,
          ...(settled.turn.error ? { error: settled.turn.error.slice(0, 500) } : {}),
        };

        const report = parseReadOnlyReport(assistantText(settled.messages));
        if (!("error" in report)) summary.outcomes = report.outcomes;
        const failures = evaluateReadOnlyRun({ before, after, report, probe, toolCalls: calls });
        if (settled.turn.phase === "error") {
          const signedOut =
            authProblem(settled) ??
            (SIGN_IN_ERROR.test(settled.turn.error ?? "") ? settled.turn.error : undefined);
          // A turn that never reached the model changed nothing and proves
          // nothing; one that did is judged on what it left behind.
          if (signedOut && "error" in report && summary.tree.changes?.length === 0) {
            skip(`no usable ${platform} credential in this profile (${signedOut.slice(0, 300)})`);
          }
          failures.unshift(`the turn failed: ${settled.turn.error ?? "no error text"}`);
        }
        summary.verdict = failures.length === 0 ? "passed" : "failed";
        if (failures.length > 0) summary.reason = failures.join("; ");
        expect(
          failures,
          `${platform}: the read-only scenario must leave the checkout unchanged, refuse every mutation and still read (${READ_ONLY_REPORT_MARKER} outcomes: ${JSON.stringify(summary.outcomes ?? {})})`,
        ).toEqual([]);
      } catch (error) {
        if (summary.verdict !== "skipped") {
          summary.verdict = "failed";
          summary.reason ??= error instanceof Error ? error.message.slice(0, 2_000) : String(error);
        }
        throw error;
      } finally {
        for (const step of cleanup.toReversed()) await step().catch(() => undefined);
        summary.durationMs = Date.now() - started;
        await writeSummary(summary);
      }
    });
  }
});
