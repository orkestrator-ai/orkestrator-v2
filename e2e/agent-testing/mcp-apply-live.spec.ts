/**
 * Live MCP apply probes: an edit made in the MCP server editor reaches a real
 * provider, and a removed server's tool really stops working.
 *
 * Opt-in (`ORKESTRATOR_AGENT_TEST_LIVE_MCP=1`) against a running agent-test
 * profile. For each platform in `ORKESTRATOR_AGENT_TEST_MCP_PROVIDERS`
 * (default all six) it creates a local environment with project resources on,
 * opens two agent tabs, and for every writable scope the editor offers on
 * that environment's target:
 *
 * 1. adds a stdio server (`mcp-probe-server.mjs`, tag `v1`) with "save and
 *    apply", then asks tab A to call its `probe` tool;
 * 2. edits it to tag `v2` and probes tabs A and B (two sessions). On the
 *    first scope tab A is kept busy with a shell `sleep` while the edit is
 *    saved and applied, and the busy turn must finish normally;
 * 3. renames it: the new name must answer, the old one must not. On the
 *    first scope the provider's bridge is then restarted and the restored
 *    tab must still reach the renamed server;
 * 4. removes it: a call to the removed tool must fail.
 *
 * Whether a call reached a server is read from the server's own log (one JSON
 * line per start, call and exit, keyed by a fresh nonce), never from the
 * model's reply; a vanished status row is not proof either. The prompt is the
 * same whether a call should succeed or fail. Apply outcomes are recorded as
 * the backend reports them; a runtime left `restart-required` is restarted
 * (`stop_local_<provider>_server_cmd` / `start_…`) before probing, as a user
 * would, and for a removal one probe is made first to record whether the
 * removed tool was still live until then.
 *
 * Claude also runs the stale-server case: an SSE entry in the project
 * `.mcp.json` (which the Claude CLI loads itself and the bridge cannot
 * unload) is removed while the CLI stays warm, and the bridge's PreToolUse
 * hook must refuse the call.
 *
 * Safety: a source is written only when it resolves inside the environment's
 * worktree or the profile's own data directory (the isolated HOME and any
 * isolated provider home). An agent-test profile keeps every provider home
 * its own even when it authorizes the host's login, so a source in a host
 * provider home should not appear; one that does is skipped with that reason.
 * Codex project trust is granted only in an isolated `CODEX_HOME`.
 *
 * Each platform writes `output/agent-testing/<run>/mcp-apply-live/<platform>.json`
 * with every outcome. A platform whose login is missing is skipped with the
 * reason; every other problem is collected and fails the test at the end, so
 * one run fills the whole matrix.
 */
import { expect, test, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import {
  dispatchProbeTurn,
  hasRunningSleep,
  judgeProbe,
  parseProbeLog,
  PROBE_SERVER_NAME,
  probePrompt,
  scopePrefix,
  TRANSIENT_APPLY_STATES,
  type ProbeExpectation,
  type ProbeVerdict,
} from "./mcp-apply-live-support";

import { grantCodexProjectTrust, writeRefusal } from "./mcp-apply-live-safety";

type Platform = "claude" | "codex" | "opencode" | "cursor" | "grok" | "pi";
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
  messages: Message[];
  interactions?: Interaction[];
};
type Source = {
  sourceId: string;
  scope: string;
  label: string;
  displayPath: string;
  writable: boolean;
  readOnlyReason?: string;
  revision: string | null;
  trust?: string;
  trustReason?: string;
  state: string;
};
type Definition = { entryId: string; sourceId: string; name: string; status: string };
type Target = {
  targetId: string;
  provider: string;
  context: { kind: string; environmentId?: string };
  capabilities: unknown;
  readOnlyReason?: string;
};
type Snapshot = { target: Target; sources: Source[]; definitions: Definition[] };
type RuntimeEntry = { label: string; state: string; reason?: string; generation?: string };
type Operation = {
  operationId: string;
  phase: string;
  errorCode?: string;
  message?: string;
  apply: { state: string; runtimes: RuntimeEntry[]; terminalGuidance?: string };
};
type MutationResult = { operation: Operation; entryId: string | null; savedRevision: string };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const LIVE = process.env.ORKESTRATOR_AGENT_TEST_LIVE_MCP === "1";
const LABELS: Record<Platform, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  grok: "Grok",
  pi: "Pi",
};
const SELECTED = (
  (process.env.ORKESTRATOR_AGENT_TEST_MCP_PROVIDERS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean).length > 0
    ? process.env.ORKESTRATOR_AGENT_TEST_MCP_PROVIDERS!.split(",").map((entry) => entry.trim())
    : Object.keys(LABELS)
) as Platform[];
/** Optional scope filter, e.g. `backend-user,project`. */
const SCOPES = new Set(
  (process.env.ORKESTRATOR_AGENT_TEST_MCP_SCOPES ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean),
);
/** `<platform>=<model>` pairs, comma-separated. */
const MODELS = new Map(
  (process.env.ORKESTRATOR_AGENT_TEST_MCP_MODELS ?? "")
    .split(",")
    .map((entry) => entry.trim().split("="))
    .filter((pair): pair is [string, string] => pair.length === 2 && Boolean(pair[1])),
);
const TURN_TIMEOUT_MS = Number(process.env.ORKESTRATOR_AGENT_TEST_MCP_TURN_TIMEOUT_MS ?? "240000");
const APPLY_SETTLE_MS = 180_000;
const EVIDENCE_WAIT_MS = 45_000;
const PROBE_SERVER = path.join(import.meta.dirname, "mcp-probe-server.mjs");
const WRITABLE_SCOPES = new Set(["backend-user", "claude-local", "project"]);

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
    const invokeResponse = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl!).href,
      { data: { command, args }, timeout: Math.max(240_000, TURN_TIMEOUT_MS) },
    );
    if (!invokeResponse.ok()) {
      throw new Error(`${command}: ${(await invokeResponse.text()).slice(0, 1_000)}`);
    }
    return ((await invokeResponse.json()) as { result: T }).result;
  };
}

function nonce(): string {
  return `MQ${randomBytes(5).toString("hex").toUpperCase()}`;
}

function textOf(message: Message): string {
  return typeof message.content === "string" ? message.content : "";
}

function toolRows(messages: readonly Message[]): string[] {
  const rows: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.parts)) continue;
    for (const part of message.parts as Array<Record<string, unknown>>) {
      if (typeof part?.type !== "string" || !/tool|mcp/i.test(part.type)) continue;
      const name = [part.toolName, part.tool, part.name, part.server].find(
        (value) => typeof value === "string",
      );
      const state = [part.toolState, part.state, part.status].find(
        (value) => typeof value === "string",
      );
      rows.push(`${part.type}:${String(name ?? "?")}:${String(state ?? "?")}`.slice(0, 160));
    }
  }
  return rows.slice(-12);
}

function signedOut(value: unknown): boolean {
  return /sign(ed)? ?(in|out)|not authenticated|unauthori[sz]ed|needs? auth|log ?in|expired|credential|api key/i.test(
    typeof value === "string" ? value : JSON.stringify(value ?? ""),
  );
}

interface StepRecord {
  step: string;
  operation?: {
    phase: string;
    errorCode?: string;
    message?: string;
    immediate?: RuntimeEntry[];
    settled?: RuntimeEntry[];
    afterEvidence?: RuntimeEntry[];
    terminalGuidance?: string;
  };
  restarted?: boolean;
  probes: Array<{
    tab: string;
    server: string;
    expect: string;
    note?: string;
    verdict?: ProbeVerdict;
    reply?: string;
    turnError?: string;
    toolMentions?: number;
    interactions?: string[];
    toolRows?: string[];
  }>;
  note?: string;
}

interface ScopeRecord {
  scope: string;
  label: string;
  displayPath: string;
  trust?: string;
  trustReason?: string;
  skipped?: string;
  steps: StepRecord[];
}

interface PlatformSummary {
  platform: Platform;
  profile: string;
  startedAt: string;
  durationMs?: number;
  verdict: "passed" | "failed" | "skipped";
  reason?: string;
  model?: string;
  capabilities?: unknown;
  sources?: Array<
    Pick<
      Source,
      | "scope"
      | "label"
      | "displayPath"
      | "writable"
      | "readOnlyReason"
      | "trust"
      | "trustReason"
      | "state"
    >
  >;
  scopes: ScopeRecord[];
  failures: string[];
}

function writeSummary(summary: PlatformSummary): void {
  const directory = path.join(repositoryRoot, "output", "agent-testing", runId, "mcp-apply-live");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(directory, `${summary.platform}.json`),
    `${JSON.stringify(summary, null, 2)}\n`,
    { mode: 0o600 },
  );
}

test.describe("live MCP apply", () => {
  test.skip(
    !LIVE,
    "opt-in live turns against the isolated fixture; set ORKESTRATOR_AGENT_TEST_LIVE_MCP=1",
  );

  for (const platform of SELECTED) {
    const label = LABELS[platform];
    test(`${label}: saved MCP edits reach the runtime and a removed tool stops working`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(Number(process.env.ORKESTRATOR_AGENT_TEST_MCP_TEST_TIMEOUT_MS ?? "3600000"));
      const summary: PlatformSummary = {
        platform,
        profile,
        startedAt: new Date().toISOString(),
        verdict: "failed",
        scopes: [],
        failures: [],
      };
      const started = Date.now();
      const scratch = mkdtempSync(path.join(os.tmpdir(), `mcpq-${platform}-`));
      const sseServers: ChildProcess[] = [];
      let invoke: Invoke | null = null;
      let environment: Environment | null = null;
      const skip = (reason: string): never => {
        summary.verdict = "skipped";
        summary.reason = reason;
        testInfo.skip(true, reason);
        throw new Error("unreachable");
      };
      try {
        const status = profileStatus();
        expect(status.profile).toBe(profile);
        expect(status.status, `profile "${profile}" is not running`).toBe("ready");
        expect(status.flavor, "live MCP probes run only in an agent-test profile").toBe(
          "agent-test",
        );
        const dataDir = status.dataDir!;
        invoke = await signIn(page, status);
        const call = invoke;
        const config = await call<{ global?: { enabledAgentPlatforms?: string[] } }>(
          "get_config",
        ).catch(() => null);
        const enabled = config?.global?.enabledAgentPlatforms;
        if (Array.isArray(enabled) && !enabled.includes(platform)) {
          skip(`${label} is not enabled in profile "${profile}"`);
        }
        const fixture = (await call<Project[]>("get_projects")).find(
          (project) => project.localPath === status.testProject,
        );
        expect(fixture, `the ${profile} fixture project is missing`).toBeTruthy();

        // An interrupted run leaves its environment, whose sessions would
        // join every later apply's fan-out.
        for (const stale of await call<Environment[]>("get_environments", {
          projectId: fixture!.id,
        })) {
          if (!stale.name.startsWith(`mcpq-${platform}-`)) continue;
          await call("stop_environment", { environmentId: stale.id }).catch(() => undefined);
          await call("delete_environment", { environmentId: stale.id }).catch(() => undefined);
        }

        environment = await call<Environment>("create_environment", {
          projectId: fixture!.id,
          name: `mcpq-${platform}-${Date.now()}`,
          networkAccessMode: "restricted",
          environmentType: "local",
          agentSettings: { executionPolicy: { projectResources: true } },
        });
        const environmentId = environment.id;
        await call("start_environment", { environmentId });
        const worktree = (await call<Environment>("get_environment", { environmentId }))
          .worktreePath;
        expect(worktree, "the environment has a worktree").toBeTruthy();

        const boundary = { dataDir, worktree: worktree!, flavor: status.flavor };

        const tabs = ["A", "B"].map((name) => `mcpq-${platform}-${name.toLowerCase()}`);
        const model = MODELS.get(platform);
        if (model) summary.model = model;
        const layout = await call<{ revision?: number } | null>("get_pane_layout", {
          environmentId,
        });
        await call("save_pane_layout", {
          environmentId,
          expectedRevision: layout?.revision ?? 0,
          layout: {
            version: PANE_LAYOUT_VERSION,
            containerId: null,
            activePaneId: "pane-mcpq",
            root: {
              kind: "leaf",
              id: "pane-mcpq",
              activeTabId: tabs[0],
              tabs: tabs.map((id, index) => ({
                id,
                type: "agent-native",
                displayTitle: `${label} MCP ${index === 0 ? "A" : "B"}`,
                nativeAgentData: { environmentId, platform, isLocal: true },
                ...(model ? { initialAgentModel: model } : {}),
              })),
            },
          },
        });
        const identity = (tab: string) => ({
          environmentId,
          agent: platform,
          logicalSessionKey: `env-${environmentId}:${tab}`,
        });
        const projection = (tab: string) =>
          call<Projection | null>("get_native_agent_projection", {
            ...identity(tab),
            messageLimit: 200,
          });

        // Codex reads a project's `.codex/config.toml` only for a trusted
        // project, and trust lives in the user config. Grant it only where
        // that config is the profile's own.
        if (platform === "codex") {
          const targets = await call<{ targets: Target[] }>("list_mcp_management_targets", {
            environmentId,
          });
          const target = targets.targets.find(
            (entry) => entry.provider === "codex" && entry.context.environmentId === environmentId,
          );
          const snapshot = await call<Snapshot>("get_mcp_management_snapshot", {
            targetId: target!.targetId,
          });
          const user = snapshot.sources.find((source) => source.scope === "backend-user");
          if (user) grantCodexProjectTrust(user, boundary);
        }

        for (const tab of tabs) {
          try {
            await call("ensure_native_agent_session", identity(tab));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (signedOut(message)) skip(`${label} is not signed in: ${message.slice(0, 300)}`);
            throw error;
          }
        }
        const auth = await call<{ state?: string } | null>(
          "get_native_agent_auth_status",
          identity(tabs[0]!),
        ).catch(() => null);
        if (auth?.state && /signed-out|unauthenticated|authentication-required/.test(auth.state)) {
          skip(`${label} is not signed in (${auth.state})`);
        }

        /** Dispatch one prompt and wait for the turn to settle. */
        const runTurn = async (
          tab: string,
          prompt: string,
          options: { waitForSettle?: boolean } = {},
        ) => {
          const before = await projection(tab);
          const previous = new Set((before?.messages ?? []).map((message) => message.id));
          const promptKey = prompt.slice(0, 120);
          const dispatch = await dispatchProbeTurn(
            (requestId) =>
              call<{ outcome: string; error?: string }>("dispatch_native_agent_intent", {
                ...identity(tab),
                prompt,
                requestId,
                mode: "build",
              }),
            randomUUID,
            () => new Promise((resolve) => setTimeout(resolve, 5_000)),
          );
          const dispatchNote =
            dispatch.outcome === "accepted"
              ? undefined
              : `dispatch ${dispatch.outcome}: ${(dispatch.error ?? "").slice(0, 200)}`;
          const settle = async () => {
            const deadline = Date.now() + TURN_TIMEOUT_MS;
            const interactions: string[] = [];
            const answered = new Set<string>();
            let idleReads = 0;
            for (;;) {
              const current = await projection(tab);
              for (const request of current?.interactions ?? []) {
                if (request.state !== "pending" || answered.has(request.id)) continue;
                answered.add(request.id);
                interactions.push(request.kind);
                const approval = /approval|permission/.test(request.kind);
                await call("resolve_native_agent_interaction", {
                  ...identity(tab),
                  interactionId: request.id,
                  resolution: {
                    version: 1,
                    interactionId: request.id,
                    sessionId: request.sessionId,
                    action: approval ? "approve-for-session" : "cancel",
                    resolvedAt: Date.now(),
                  },
                }).catch(() => undefined);
              }
              const unseen = (current?.messages ?? []).filter(
                (message) => !previous.has(message.id),
              );
              // Only rows after this turn's own prompt: a background task an
              // earlier turn started can add a reply of its own (Claude
              // reports a finished background command in a new turn).
              const own = unseen.findLastIndex(
                (message) => message.role === "user" && textOf(message).includes(promptKey),
              );
              const fresh = own >= 0 ? unseen.slice(own + 1) : unseen;
              const phase = current?.turn.phase ?? "idle";
              idleReads = phase === "idle" ? idleReads + 1 : 0;
              const replied = fresh.some(
                (message) => message.role === "assistant" && textOf(message).trim().length > 0,
              );
              if (phase === "error") {
                return {
                  reply: "",
                  error: current?.turn.error ?? "turn error",
                  fresh,
                  interactions,
                };
              }
              if (dispatch.outcome !== "accepted") {
                return { reply: "", error: dispatchNote, fresh, interactions };
              }
              if (idleReads >= 2 && replied) {
                const reply = fresh
                  .filter((message) => message.role === "assistant")
                  .map(textOf)
                  .join("\n");
                return { reply, fresh, interactions };
              }
              if (Date.now() > deadline) {
                return {
                  reply: "",
                  error: `no reply within ${TURN_TIMEOUT_MS / 1000}s (phase ${phase}; ${dispatchNote ?? "dispatch accepted"}; new rows ${unseen.map((message) => message.role).join(",") || "none"})`,
                  fresh,
                  interactions,
                };
              }
              await new Promise((resolve) => setTimeout(resolve, 1_500));
            }
          };
          // Observe immediately, including approvals while a busy turn runs.
          // All callers share the same waiter and interaction responses.
          const result = settle().catch((error: unknown) => ({
            reply: "",
            error: error instanceof Error ? error.message : String(error),
            fresh: [] as Message[],
            interactions: [] as string[],
          }));
          if (options.waitForSettle === false) return { settle: () => result };
          return { settle: () => result, result: await result };
        };

        // A first turn per tab, so each has a provider session for apply to
        // track (apply never creates one).
        const warm = await Promise.all(
          tabs.map((tab) => runTurn(tab, "Reply with exactly READY. Do not use any tools.")),
        );
        for (const [index, outcome] of warm.entries()) {
          if (outcome.result?.error) {
            if (signedOut(outcome.result.error)) {
              skip(`${label} is not signed in: ${outcome.result.error.slice(0, 300)}`);
            }
            throw new Error(`${label} tab ${index} could not start: ${outcome.result.error}`);
          }
        }

        const logFile = path.join(scratch, "probe-log.jsonl");
        writeFileSync(logFile, "");
        const events = () => parseProbeLog(readFileSync(logFile, "utf8"));

        const probe = async (
          tab: string,
          server: string,
          expectation: ProbeExpectation,
          note?: string,
        ) => {
          const value = nonce();
          const outcome = (await runTurn(tab, probePrompt(server, value))).result!;
          // Give a slow server a moment to flush its log line.
          await new Promise((resolve) => setTimeout(resolve, 500));
          const rows = toolRows(outcome.fresh);
          const verdict = judgeProbe({
            events: events(),
            server,
            nonce: value,
            reply: outcome.reply,
            expect: expectation,
            toolRows: rows,
            turnError: outcome.error,
          });
          const record = {
            tab: tab.endsWith("-a") ? "A" : "B",
            server,
            expect: expectation.reach ? `reach ${expectation.tag}` : "fail",
            ...(note ? { note } : {}),
            verdict,
            reply: outcome.reply.replace(/\s+/g, " ").slice(0, 240),
            ...(outcome.error ? { turnError: outcome.error.slice(0, 500) } : {}),
            toolMentions: outcome.fresh.filter((message) =>
              JSON.stringify(message.parts ?? message.content ?? "").includes(server),
            ).length,
            ...(outcome.interactions.length > 0 ? { interactions: outcome.interactions } : {}),
            // Which tools the turn tried, by name and state only (no
            // arguments or output), so a call that never reached a server
            // shows whether it was refused, failed or never attempted.
            ...(rows.length > 0 ? { toolRows: rows } : {}),
          };
          return record;
        };

        const restartBridge = async () => {
          await call(`stop_local_${platform}_server_cmd`, { environmentId });
          await call(`start_local_${platform}_server_cmd`, { environmentId });
          await call("await_bridge_ready", { environmentId, agent: platform, timeoutMs: 90_000 });
        };

        const operationRuntimes = (operation: Operation) =>
          operation.apply.runtimes.map(({ label: name, state, reason, generation }) => ({
            label: name,
            state,
            ...(reason ? { reason: reason.slice(0, 300) } : {}),
            ...(generation ? { generation } : {}),
          }));
        const readOperation = (operationId: string) =>
          call<Operation>("get_mcp_operation", { operationId });
        const settleOperation = async (operationId: string) => {
          const deadline = Date.now() + APPLY_SETTLE_MS;
          let operation = await readOperation(operationId);
          while (
            Date.now() < deadline &&
            operation.apply.runtimes.some((runtime) => TRANSIENT_APPLY_STATES.has(runtime.state))
          ) {
            await new Promise((resolve) => setTimeout(resolve, 2_000));
            operation = await readOperation(operationId);
          }
          return operation;
        };
        const evidence = async (operationId: string) => {
          const deadline = Date.now() + EVIDENCE_WAIT_MS;
          let operation = await readOperation(operationId);
          while (
            Date.now() < deadline &&
            operation.apply.runtimes.some((runtime) =>
              ["pending-next-turn", "pending-reattach", "queued", "applying"].includes(
                runtime.state,
              ),
            )
          ) {
            await new Promise((resolve) => setTimeout(resolve, 3_000));
            operation = await readOperation(operationId);
          }
          return operationRuntimes(operation);
        };

        const target = (
          await call<{ targets: Target[] }>("list_mcp_management_targets", { environmentId })
        ).targets.find(
          (entry) => entry.provider === platform && entry.context.environmentId === environmentId,
        );
        expect(target, `no ${label} MCP target for the environment`).toBeTruthy();
        const snapshot = () =>
          call<Snapshot>("get_mcp_management_snapshot", { targetId: target!.targetId });
        const first = await snapshot();
        summary.capabilities = first.target.capabilities;
        summary.sources = first.sources.map(
          ({
            scope,
            label: name,
            displayPath,
            writable,
            readOnlyReason,
            trust,
            trustReason,
            state,
          }) => ({
            scope,
            label: name,
            displayPath,
            writable,
            ...(readOnlyReason ? { readOnlyReason } : {}),
            ...(trust ? { trust } : {}),
            ...(trustReason ? { trustReason } : {}),
            state,
          }),
        );

        /** Save one mutation with "save and apply"; returns the operation. */
        const mutate = async (operation: Record<string, unknown>) => {
          const result = await call<MutationResult>("mutate_mcp_definition", {
            mutation: {
              requestId: randomUUID(),
              targetId: target!.targetId,
              applyIntent: "save-and-apply",
              operation,
            },
          });
          return result;
        };
        const findEntry = async (sourceId: string, name: string) => {
          const current = await snapshot();
          const source = current.sources.find((entry) => entry.sourceId === sourceId)!;
          const definition = current.definitions.find(
            (entry) => entry.sourceId === sourceId && entry.name === name,
          );
          return { source, definition };
        };
        const args = (server: string, tag: string) => [
          PROBE_SERVER,
          "--label",
          server,
          "--tag",
          tag,
          "--log",
          logFile,
        ];

        /**
         * Save, settle and probe one step. A runtime left `restart-required`
         * is restarted first unless this step must qualify the warm runtime.
         */
        const step = async (
          scope: ScopeRecord,
          name: string,
          operation: Record<string, unknown>,
          probes: Array<{ tab: string; server: string; expect: ProbeExpectation }>,
          options: {
            busyTab?: string;
            probeBeforeRestart?: { tab: string; server: string };
            keepWarm?: boolean;
          } = {},
        ) => {
          const record: StepRecord = { step: name, probes: [] };
          scope.steps.push(record);
          let busy: Awaited<ReturnType<typeof runTurn>> | null = null;
          if (options.busyTab) {
            const marker = path.join(scratch, `busy-${randomUUID()}`);
            busy = await runTurn(
              options.busyTab,
              `Use your shell tool to run the command \`printf started > '${marker}'; sleep 45\` once, in the foreground (not as a background task), and wait for it to finish. Then reply with exactly BUSY-DONE. Do not use any other tool.`,
              { waitForSettle: false },
            );
            const deadline = Date.now() + 60_000;
            let running = false;
            while (Date.now() < deadline) {
              const current = await projection(options.busyTab);
              if (
                existsSync(marker) &&
                Date.now() - statSync(marker).mtimeMs < 15_000 &&
                current &&
                !["idle", "error"].includes(current.turn.phase) &&
                hasRunningSleep(current.messages, marker)
              ) {
                running = true;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
            if (!running) {
              record.note = "busy setup failed: no running foreground shell sleep was observed";
              summary.failures.push(`${scope.scope} ${name}: ${record.note}`);
              await busy.settle();
              return { record, entryId: null as string | null };
            }
            record.note = "observed the running foreground shell sleep before saving";
          }
          const warmIdentity = options.keepWarm ? await projection(probes[0]!.tab) : null;
          const warmBridge = options.keepWarm
            ? await call<{ running: boolean; pid: number | null }>(
                `get_local_${platform}_server_status`,
                { environmentId },
              )
            : null;
          let result: MutationResult;
          try {
            result = await mutate(operation);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            record.operation = { phase: "rejected", message: message.slice(0, 500) };
            summary.failures.push(`${scope.scope} ${name}: save failed: ${message.slice(0, 300)}`);
            if (busy) await busy.settle();
            return { record, entryId: null as string | null };
          }
          record.operation = {
            phase: result.operation.phase,
            ...(result.operation.errorCode ? { errorCode: result.operation.errorCode } : {}),
            ...(result.operation.message
              ? { message: result.operation.message.slice(0, 300) }
              : {}),
            immediate: operationRuntimes(result.operation),
            ...(result.operation.apply.terminalGuidance
              ? { terminalGuidance: result.operation.apply.terminalGuidance.slice(0, 300) }
              : {}),
          };
          if (busy) {
            const outcome = await busy.settle();
            const finished = !outcome.error && outcome.reply.includes("BUSY-DONE");
            record.note = finished
              ? "the busy turn finished normally while the edit was saved and applied"
              : `the busy turn did not finish normally: ${outcome.error ?? outcome.reply.slice(0, 200)}`;
            if (!finished) summary.failures.push(`${scope.scope} ${name}: ${record.note}`);
          }
          const settled = await settleOperation(result.operation.operationId);
          record.operation.settled = operationRuntimes(settled);
          if (options.keepWarm) {
            const warmRuntime = settled.apply.runtimes.find((runtime) =>
              runtime.label.endsWith(` · ${probes[0]!.tab}`),
            );
            // A live SSE client cannot unload this entry. Require the warm
            // runtime's restart-required outcome, but judge before any restart.
            if (warmRuntime?.state !== "restart-required") {
              summary.failures.push(
                `${scope.scope} ${name}: warm runtime did not report restart-required`,
              );
            }
          } else if (
            settled.apply.runtimes.some((runtime) => runtime.state === "restart-required")
          ) {
            if (options.probeBeforeRestart) {
              record.probes.push(
                await probe(
                  options.probeBeforeRestart.tab,
                  options.probeBeforeRestart.server,
                  { reach: false },
                  "before the restart the outcome asked for (recorded, not judged)",
                ),
              );
            }
            await restartBridge();
            record.restarted = true;
          }
          for (const entry of probes) {
            const outcome = await probe(entry.tab, entry.server, entry.expect);
            record.probes.push(outcome);
            if (!outcome.verdict.passed) {
              summary.failures.push(
                `${scope.scope} ${name}: tab ${outcome.tab} ${entry.server} expected ${outcome.expect}: ${outcome.verdict.reason ?? "failed"}`,
              );
            }
          }
          if (options.keepWarm) {
            const after = await projection(probes[0]!.tab);
            const bridge = await call<{ running: boolean; pid: number | null }>(
              `get_local_${platform}_server_status`,
              { environmentId },
            );
            if (
              !warmBridge?.running ||
              !warmBridge.pid ||
              !bridge.running ||
              bridge.pid !== warmBridge.pid ||
              !warmIdentity?.sessionId ||
              after?.sessionId !== warmIdentity.sessionId
            ) {
              summary.failures.push(
                `${scope.scope} ${name}: bridge generation or warm session changed during the stale-server probe`,
              );
            }
          }
          record.operation.afterEvidence = await evidence(result.operation.operationId);
          return { record, entryId: result.entryId };
        };

        // Clear what an interrupted run left in the files this run may write,
        // so a leftover never shadows a name or widens the apply fan-out.
        for (const definition of first.definitions) {
          const source = first.sources.find((entry) => entry.sourceId === definition.sourceId);
          if (
            !source?.writable ||
            !PROBE_SERVER_NAME.test(definition.name) ||
            writeRefusal(source, boundary)
          ) {
            continue;
          }
          const current = await findEntry(source.sourceId, definition.name);
          if (!current.definition) continue;
          await call("mutate_mcp_definition", {
            mutation: {
              requestId: randomUUID(),
              targetId: target!.targetId,
              applyIntent: "save",
              operation: {
                kind: "remove",
                entryId: current.definition.entryId,
                expectedRevision: current.source.revision,
              },
            },
          });
        }

        const [tabA, tabB] = tabs as [string, string];
        const writable = first.sources.filter(
          (source) =>
            WRITABLE_SCOPES.has(source.scope) && (SCOPES.size === 0 || SCOPES.has(source.scope)),
        );
        for (const [index, source] of writable.entries()) {
          const scope: ScopeRecord = {
            scope: source.scope,
            label: source.label,
            displayPath: source.displayPath,
            ...(source.trust ? { trust: source.trust } : {}),
            ...(source.trustReason ? { trustReason: source.trustReason } : {}),
            steps: [],
          };
          summary.scopes.push(scope);
          if (!source.writable) {
            scope.skipped = `not writable: ${source.readOnlyReason ?? "no reason given"}`;
            continue;
          }
          const refusal = writeRefusal(source, boundary);
          if (refusal) {
            scope.skipped = refusal;
            continue;
          }
          const lifecycle = summary.scopes.filter((entry) => !entry.skipped).length === 1;
          const prefix = scopePrefix(source.scope, index);
          const alpha = `${prefix}_alpha`;
          const beta = `${prefix}_beta`;

          const add = await step(
            scope,
            "add",
            {
              kind: "add",
              sourceId: source.sourceId,
              expectedRevision: (await findEntry(source.sourceId, alpha)).source.revision,
              definition: {
                name: alpha,
                transport: "stdio",
                command: process.execPath,
                args: args(alpha, "v1"),
              },
            },
            [{ tab: tabA, server: alpha, expect: { reach: true, tag: "v1" } }],
          );
          if (!add.entryId) continue;

          let entry = await findEntry(source.sourceId, alpha);
          await step(
            scope,
            lifecycle ? "edit (tab A busy during save and apply)" : "edit",
            {
              kind: "update",
              entryId: entry.definition!.entryId,
              expectedRevision: entry.source.revision,
              patch: {
                args: args(alpha, "v2").map((value) => ({ kind: "set", value })),
              },
            },
            [
              { tab: tabA, server: alpha, expect: { reach: true, tag: "v2" } },
              { tab: tabB, server: alpha, expect: { reach: true, tag: "v2" } },
            ],
            lifecycle ? { busyTab: tabA } : {},
          );

          entry = await findEntry(source.sourceId, alpha);
          await step(
            scope,
            "rename",
            {
              kind: "rename",
              entryId: entry.definition!.entryId,
              expectedRevision: entry.source.revision,
              newName: beta,
            },
            [
              { tab: tabA, server: beta, expect: { reach: true, tag: "v2", label: alpha } },
              { tab: tabA, server: alpha, expect: { reach: false } },
            ],
          );

          if (lifecycle) {
            const record: StepRecord = { step: "restart and restore", probes: [] };
            scope.steps.push(record);
            await restartBridge();
            record.restarted = true;
            const outcome = await probe(tabA, beta, { reach: true, tag: "v2", label: alpha });
            record.probes.push(outcome);
            if (!outcome.verdict.passed) {
              summary.failures.push(
                `${scope.scope} restart and restore: ${outcome.verdict.reason ?? "failed"}`,
              );
            }
          }

          entry = await findEntry(source.sourceId, beta);
          await step(
            scope,
            "remove",
            {
              kind: "remove",
              entryId: entry.definition!.entryId,
              expectedRevision: entry.source.revision,
            },
            [
              { tab: tabA, server: beta, expect: { reach: false } },
              { tab: tabB, server: beta, expect: { reach: false } },
            ],
            { probeBeforeRestart: { tab: tabA, server: beta } },
          );
        }

        // Claude: a server the CLI loaded from a file itself (an SSE entry,
        // which the bridge drops from its inline set) cannot be unloaded in
        // place. Removing it must leave the runtime restart-required and the
        // bridge's hook must refuse the call while the CLI stays warm.
        if (platform === "claude" && (SCOPES.size === 0 || SCOPES.has("claude-sse"))) {
          const project = first.sources.find((source) => source.scope === "project");
          const scope: ScopeRecord = {
            scope: "claude-sse",
            label: "Project .mcp.json SSE entry (written outside the editor)",
            displayPath: project?.displayPath ?? "<worktree>/.mcp.json",
            steps: [],
          };
          summary.scopes.push(scope);
          const portFile = path.join(scratch, "sse-port");
          const server = "mqs_sse";
          sseServers.push(
            spawn(
              process.execPath,
              [
                PROBE_SERVER,
                "--sse",
                "--port-file",
                portFile,
                "--label",
                server,
                "--tag",
                "v1",
                "--log",
                logFile,
              ],
              { stdio: "ignore" },
            ),
          );
          const deadline = Date.now() + 10_000;
          while (!existsSync(portFile) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          const port = readFileSync(portFile, "utf8").trim();
          const file = path.join(worktree!, ".mcp.json");
          const current = existsSync(file)
            ? (JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, unknown> })
            : {};
          writeFileSync(
            file,
            `${JSON.stringify(
              {
                ...current,
                mcpServers: {
                  ...current.mcpServers,
                  [server]: { type: "sse", url: `http://127.0.0.1:${port}/sse` },
                },
              },
              null,
              2,
            )}\n`,
          );
          // The CLI reads its own MCP files only at launch, and the bridge
          // keeps a CLI warm across turns, so a new one has to start.
          const loaded: StepRecord = {
            step: "external SSE add, bridge restart, probe",
            probes: [],
            restarted: true,
          };
          scope.steps.push(loaded);
          await restartBridge();
          const outcome = await probe(tabA, server, { reach: true, tag: "v1" });
          loaded.probes.push(outcome);
          if (!outcome.verdict.passed) {
            loaded.note =
              "the new CLI did not load the SSE entry, so the stale-server hook could not be exercised";
            summary.failures.push(
              `claude-sse initial load: ${outcome.verdict.reason ?? loaded.note}`,
            );
          } else {
            const entry = await findEntry(project!.sourceId, server);
            await step(
              scope,
              "remove SSE entry while the CLI stays warm",
              {
                kind: "remove",
                entryId: entry.definition!.entryId,
                expectedRevision: entry.source.revision,
              },
              [{ tab: tabA, server, expect: { reach: false } }],
              { keepWarm: true },
            );
          }
        }

        summary.verdict = summary.failures.length === 0 ? "passed" : "failed";
        if (summary.failures.length > 0) summary.reason = summary.failures.join("; ");
        expect(summary.failures).toEqual([]);
      } catch (error) {
        if (summary.verdict !== "skipped" && summary.verdict !== "passed") {
          summary.verdict = "failed";
          summary.reason ??= error instanceof Error ? error.message.slice(0, 2_000) : String(error);
        }
        throw error;
      } finally {
        summary.durationMs = Date.now() - started;
        writeSummary(summary);
        for (const child of sseServers) child.kill();
        if (invoke && environment) {
          await invoke("stop_environment", { environmentId: environment.id }).catch(
            () => undefined,
          );
          await invoke("delete_environment", { environmentId: environment.id }).catch(
            () => undefined,
          );
        }
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  }
});
