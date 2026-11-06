/**
 * MCP apply for an inactive environment, Codex process-wide variant
 * (docs/todo/mcp/0039-mcp-management.md, task 7): two Codex threads share one
 * app-server, so one saved change is one reload of that process, and each
 * thread must still prove for itself that it runs the change.
 *
 * Opt-in (`ORKESTRATOR_AGENT_TEST_LIVE_MCP=1`) against a running agent-test
 * profile. Environment A has two Codex tabs (A1, A2) on one bridge; the
 * browser sits on environment B, so A's React tree is never mounted. Every
 * edit goes to A's worktree `.codex/config.toml`, trusted only in the
 * profile's own `CODEX_HOME`. The fixture server's one tool answers with a
 * nonce that exists only in its arguments, and a marker file counts calls.
 *
 * - One save while A is inactive plans both threads of A, and nothing in B;
 *   the app-server reloads once and both wait for their own next turn, on the
 *   same bridge process.
 * - A1's next turn, with the page offline and its event stream cut, makes A1
 *   `applied` and leaves A2 waiting: one thread's turn is not evidence for
 *   another thread of the same process.
 * - A2's own turn makes it `applied`; the bridge process never changed.
 * - After a hard reload the settings card reads "Saved and loaded".
 * - A removal: both threads wait, then each turn finds the tool gone.
 *
 * `ORKESTRATOR_AGENT_TEST_MCP_FAKE_MODEL=1` runs every turn against the
 * scripted loopback model (`mcp-fake-model.ts`) instead of a provider: the
 * real app-server, bridge, backend and fixture server run, and no login is
 * used. Start the profile with a throwaway `CODEX_HOME` whose `auth.json`
 * holds a made-up API key, so the profile receives no real Codex login:
 *
 *   ORKESTRATOR_HOST_REACHABILITY_CHECK=off CODEX_HOME=<throwaway> \
 *     mise run dev:test --profile <p> --fixture --credential-source codex --agent-platforms codex
 *   ORKESTRATOR_AGENT_TEST_PROFILE=<p> ORKESTRATOR_AGENT_TEST_LIVE_MCP=1 \
 *     ORKESTRATOR_AGENT_TEST_MCP_FAKE_MODEL=1 \
 *     mise run test:agent:browser -- e2e/agent-testing/mcp-apply-inactive-codex.spec.ts
 */
import { expect, test, type Page } from "./browser-test";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  McpConfigSource,
  McpManagementSnapshot,
  McpManagementTarget,
  McpMutationOperation,
  McpMutationResult,
  McpOperationSnapshot,
  McpRuntimeApplyEntry,
} from "@orkestrator/protocol/mcp-management";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { watchEventStream } from "./event-stream-outage";
import { observeCodexReloads } from "./mcp-codex-reload-observer";
import { FIXTURE_SERVER } from "./mcp-apply-inactive-support";
import { grantCodexProjectTrust, writableSourcePath } from "./mcp-apply-live-safety";
import { startMcpFakeModel, type McpFakeModelHandle } from "./mcp-fake-model-wiring";
import { dismissSidebarTooltip } from "./sidebar-tooltip";

type Status = {
  status: string;
  profile?: string;
  flavor?: string;
  browserUrl?: string;
  testProject?: string;
  dataDir?: string;
};
type Project = { id: string; name: string; localPath: string | null };
type Environment = { id: string; name: string; worktreePath?: string | null };
type Message = { role?: unknown; content?: unknown };
type Projection = {
  sessionId?: string;
  turn: { phase: string; error?: string };
  messages?: Message[];
  recoverableDispatch?: { requestId: string };
} | null;
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Identity = { environmentId: string; agent: "codex"; logicalSessionKey: string };

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const LIVE_OPT_IN = process.env.ORKESTRATOR_AGENT_TEST_LIVE_MCP === "1";
const FAKE_MODEL = process.env.ORKESTRATOR_AGENT_TEST_MCP_FAKE_MODEL === "1";
const DESKTOP_VIEWPORT = { width: 1440, height: 1200 };
/** Mirrors `CODEX_TURN_APPLIED_REASON` in apps/backend/src/core/mcp-management/codex-turn-evidence.ts. */
const CODEX_APPLIED_REASON =
  "The thread started a turn after Codex loaded the saved configuration.";
/** The evidence poll re-reads a runtime at most every 10 s; wait past two polls. */
const EVIDENCE_SETTLE_MS = 25_000;
const TURN_TIMEOUT_MS = 240_000;

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
    // `page.request` is not subject to `context.setOffline`, so backend truth
    // stays readable while the page's own streams are cut.
    const invokeResponse = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl!).href,
      { data: { command, args }, timeout: TURN_TIMEOUT_MS },
    );
    expect(invokeResponse.ok(), `${command}: ${await invokeResponse.text()}`).toBe(true);
    return ((await invokeResponse.json()) as { result: T }).result;
  };
}

/**
 * A profile without a login for an enabled platform (a fake-model run) opens
 * its "not logged in" notice whenever the check finishes, which can be after
 * the sidebar is first used; close it whenever it covers the page.
 */
async function closeLoginNotices(page: Page) {
  const notices = ["Continue Without Claude", "Continue Without Codex"].map((name) =>
    page.getByRole("button", { name, exact: true }),
  );
  await page.addLocatorHandler(
    notices[0]!.or(notices[1]!).first(),
    async () => {
      for (const notice of notices) {
        if (await notice.isVisible()) await notice.click({ timeout: 2_000 }).catch(() => undefined);
      }
    },
    { noWaitAfter: true },
  );
}

function sidebarNavigator(page: Page, projectName: string) {
  return async (name: string) => {
    const expand = page.getByRole("button", { name: `Expand project ${projectName}` });
    const entry = page.getByText(name, { exact: true }).first();
    await expect(expand.or(entry).first()).toBeVisible({ timeout: 30_000 });
    for (const label of [
      "Continue Without Codex",
      "Continue Without Claude",
      "Continue Without Docker",
      "Continue Without GitHub CLI",
    ]) {
      const continueButton = page.getByRole("button", { name: label, exact: true });
      if (await continueButton.isVisible()) await continueButton.click({ timeout: 5_000 });
    }
    if (await expand.isVisible()) await expand.click();
    await dismissSidebarTooltip(page, projectName);
    await entry.click();
  };
}

const textOf = (message: Message) => (typeof message.content === "string" ? message.content : "");
/** Random and never typed, so only the fixture server can produce it. */
const nonce = (tag: string) => `${tag}-${randomBytes(5).toString("hex")}`;

test.describe("live MCP apply in an inactive environment (codex, process-wide)", () => {
  test.skip(!LIVE_OPT_IN, "opt-in live Codex turns; set ORKESTRATOR_AGENT_TEST_LIVE_MCP=1");

  test("one app-server reload, two threads: each proves its own next turn while A is inactive", async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(1_500_000);
    page.setDefaultTimeout(15_000);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await closeLoginNotices(page);

    const status = profileStatus();
    expect(status.profile, "dev:status answered for a different profile").toBe(profile);
    expect(status.status, `profile "${profile}" is not running`).toBe("ready");
    expect(status.flavor).toBe("agent-test");
    const record = (type: string, description: string) =>
      testInfo.annotations.push({ type, description });

    const runDir = path.join(
      repositoryRoot,
      "output",
      "agent-testing",
      profile,
      `mcp-inactive-codex-${Date.now()}`,
    );
    mkdirSync(runDir, { recursive: true });
    const serverScript = path.join(runDir, "fixture-server.mjs");
    const marker = path.join(runDir, "calls.log");
    writeFileSync(serverScript, FIXTURE_SERVER);
    writeFileSync(marker, "");
    const markerLines = (line: string) =>
      readFileSync(marker, "utf8")
        .split("\n")
        .filter((entry) => entry === line).length;

    let fake: McpFakeModelHandle | undefined;
    const reloads = observeCodexReloads(status.dataDir!, runDir);
    const environments: Environment[] = [];
    let invoke: Invoke | undefined;
    try {
      if (FAKE_MODEL) {
        // Before any environment exists, so the app-server reads it at launch.
        fake = await startMcpFakeModel("codex", status.dataDir!);
        record(
          "fake-model",
          `scripted loopback model at ${fake.origin}; no provider turn, no login`,
        );
      }
      invoke = await authenticatedInvoke(page, status);
      const call = invoke;
      const fixture = (await call<Project[]>("get_projects")).find(
        (project) => project.localPath === status.testProject,
      );
      expect(fixture, `the ${profile} fixture project is missing`).toBeTruthy();
      for (const stale of await call<Environment[]>("get_environments", {
        projectId: fixture!.id,
      })) {
        if (!stale.name.startsWith("mcpqx-")) continue;
        await call("stop_environment", { environmentId: stale.id }).catch(() => undefined);
        await call("delete_environment", { environmentId: stale.id }).catch(() => undefined);
      }
      for (const name of ["mcpqx-a", "mcpqx-b"]) {
        environments.push(
          await call<Environment>("create_environment", {
            projectId: fixture!.id,
            name: `${name}-${Date.now()}`,
            networkAccessMode: "restricted",
            environmentType: "local",
            agentSettings: {
              executionPolicy: { projectResources: true, approvals: "auto-approve" },
            },
          }),
        );
      }
      const [envA, envB] = environments as [Environment, Environment];
      for (const environment of environments) {
        await call("start_environment", { environmentId: environment.id });
      }
      const worktreeA = (await call<Environment>("get_environment", { environmentId: envA.id }))
        .worktreePath;
      expect(worktreeA).toBeTruthy();

      // A: two Codex tabs on one bridge. B: one, where the browser sits.
      const tabsOf = new Map<string, string[]>([
        [envA.id, ["mcpqx-a1", "mcpqx-a2"]],
        [envB.id, ["mcpqx-b1"]],
      ]);
      for (const environment of environments) {
        const tabs = tabsOf.get(environment.id)!;
        const layout = await call<{ revision?: number } | null>("get_pane_layout", {
          environmentId: environment.id,
        });
        await call("save_pane_layout", {
          environmentId: environment.id,
          expectedRevision: layout?.revision ?? 0,
          layout: {
            version: PANE_LAYOUT_VERSION,
            containerId: null,
            activePaneId: "pane-mcpqx",
            root: {
              kind: "leaf",
              id: "pane-mcpqx",
              activeTabId: tabs[0],
              tabs: tabs.map((id, index) => ({
                id,
                type: "agent-native",
                displayTitle: `Codex ${index + 1}`,
                nativeAgentData: {
                  environmentId: environment.id,
                  platform: "codex",
                  isLocal: true,
                },
              })),
            },
          },
        });
      }
      const identity = (environmentId: string, tab: string): Identity => ({
        environmentId,
        agent: "codex",
        logicalSessionKey: `env-${environmentId}:${tab}`,
      });
      const a1 = identity(envA.id, "mcpqx-a1");
      const a2 = identity(envA.id, "mcpqx-a2");
      const b1 = identity(envB.id, "mcpqx-b1");
      const label = (who: Identity) => (who === a1 ? "A1" : who === a2 ? "A2" : "B1");
      const projection = (who: Identity) =>
        call<Projection>("get_native_agent_projection", { ...who, messageLimit: 200 });

      const startedAt = Date.now();
      const trace = (line: string) =>
        console.log(`[mcpqx +${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${line}`);
      /** Send one prompt to a session that is not on screen and wait for its reply. */
      const turn = async (who: Identity, prompt: string, needle: string) => {
        const before = new Set(
          ((await projection(who))?.messages ?? []).map((message) => JSON.stringify(message)),
        );
        const outcome = await call<{ outcome: string; error?: string }>(
          "dispatch_native_agent_intent",
          { ...who, prompt, requestId: randomUUID(), mode: "build" },
        );
        expect(outcome.outcome, outcome.error).toBe("accepted");
        let reply = "";
        await expect
          .poll(
            async () => {
              const current = await projection(who);
              const phase = current?.turn.phase;
              if (phase === "error") return `error: ${current?.turn.error ?? ""}`;
              if (phase !== "idle" || current?.recoverableDispatch) return "running";
              reply = (current?.messages ?? [])
                .filter((message) => !before.has(JSON.stringify(message)))
                .filter((message) => message.role === "assistant")
                .map(textOf)
                .join("\n");
              return reply.includes(needle) ? "replied" : "idle without the reply";
            },
            {
              timeout: TURN_TIMEOUT_MS,
              intervals: [2_000],
              message: `${label(who)}: no reply carrying ${needle}`,
            },
          )
          .toBe("replied");
        trace(`${label(who)} replied`);
        return reply;
      };
      const toolPrompt = (name: string) =>
        `Call the MCP tool probe_${name} from the ${name} server exactly once, then reply with exactly the text it returned and nothing else.`;
      const absentPrompt = (name: string, token: string) =>
        `If a tool named probe_${name} is available to you, call it once and reply with exactly ` +
        `its result. If it is not available, reply with exactly ${token} and nothing else.`;

      // --- MCP management (the same commands the settings UI uses) ---
      const targetOf = async (environmentId: string) => {
        const list = await call<{ targets: McpManagementTarget[] }>("list_mcp_management_targets", {
          environmentId,
        });
        const found = list.targets.find(
          (candidate) =>
            candidate.provider === "codex" &&
            candidate.context.kind === "environment" &&
            candidate.context.environmentId === environmentId,
        );
        expect(found, `no Codex MCP target for ${environmentId}`).toBeTruthy();
        return found!;
      };
      const snapshot = (targetId: string) =>
        call<McpManagementSnapshot>("get_mcp_management_snapshot", { targetId });
      const sourceOf = async (targetId: string, scope: McpConfigSource["scope"]) => {
        const found = (await snapshot(targetId)).sources.find(
          (candidate) => candidate.scope === scope,
        );
        expect(found, `no ${scope} source`).toBeTruthy();
        return found!;
      };
      const targetA = await targetOf(envA.id);
      const boundary = { dataDir: status.dataDir!, worktree: worktreeA!, flavor: status.flavor };
      // Codex reads a project's `.codex/config.toml` only for a trusted
      // project; grant it only in the profile's own user config.
      const user = await sourceOf(targetA.targetId, "backend-user");
      expect(grantCodexProjectTrust(user, boundary), "trust outside the profile").toBe(true);
      const project = await sourceOf(targetA.targetId, "project");
      expect(project.writable, `project source read-only: ${project.readOnlyReason}`).toBe(true);
      expect(
        writableSourcePath(project, boundary)?.startsWith(worktreeA!),
        "the project file is outside A's worktree",
      ).toBe(true);
      // Sessions start after the trust grant, so A's app-server reads it at launch.
      for (const who of [a1, a2, b1]) await call("ensure_native_agent_session", who);

      // Every session has a thread before apply plans anything (apply never makes one).
      for (const who of [a1, a2, b1]) {
        await turn(who, "Reply with exactly READY. Do not use any tools.", "READY");
      }
      const threadIds = new Map<Identity, string | undefined>();
      for (const who of [a1, a2]) threadIds.set(who, (await projection(who))?.sessionId);
      expect(threadIds.get(a1), "A1 has a Codex thread").toBeTruthy();
      expect(threadIds.get(a2), "A2 has its own Codex thread").not.toBe(threadIds.get(a1));

      const saveAndApply = async (operation: McpMutationOperation) => {
        const result = await call<McpMutationResult>("mutate_mcp_definition", {
          mutation: {
            requestId: `mcpqx-${randomUUID()}`,
            targetId: targetA.targetId,
            applyIntent: "save-and-apply",
            operation,
          },
        });
        expect(result.operation.phase, result.operation.message).toBe("saved");
        return result;
      };
      const operation = (operationId: string) =>
        call<McpOperationSnapshot>("get_mcp_operation", { operationId });
      // A runtime's label ends with its tab id.
      const runtimeOf = (value: McpOperationSnapshot, who: Identity) =>
        value.apply.runtimes.find(
          (runtime) =>
            runtime.environmentId === who.environmentId &&
            runtime.label.endsWith(` · ${who.logicalSessionKey.split(":").at(-1)}`),
        );
      const describe = (value: McpOperationSnapshot) =>
        value.apply.runtimes
          .map(
            (runtime) =>
              `${runtime.label}=${runtime.state}${runtime.generation ? `@${runtime.generation}` : ""}`,
          )
          .join(", ");
      const waitFor = async (
        operationId: string,
        who: Identity,
        state: McpRuntimeApplyEntry["state"],
        message: string,
      ) => {
        let last: McpRuntimeApplyEntry | undefined;
        await expect
          .poll(
            async () => {
              last = runtimeOf(await operation(operationId), who);
              return last?.state;
            },
            { timeout: 180_000, intervals: [2_000], message },
          )
          .toBe(state);
        return last!;
      };
      const bridgePid = async () =>
        (
          await call<{ running: boolean; pid: number | null }>("get_local_codex_server_status", {
            environmentId: envA.id,
          })
        ).pid;

      // --- UI ---
      const openEnvironment = sidebarNavigator(page, fixture!.name);
      const stream = watchEventStream(page, (line) => trace(line));
      const settingsCard = (kind: string, name: string) =>
        page
          .getByRole("region", { name: "Recent changes" })
          .getByRole("listitem")
          .filter({ hasText: new RegExp(`^${kind} ${name}`) })
          .first();
      /** Open MCP settings from B's agent panel, then switch the context to A. */
      const openSettingsForA = async () => {
        await openEnvironment(envB.name);
        await page.getByRole("button", { name: "Open agent information" }).first().click();
        await page.getByRole("button", { name: "Manage saved MCP servers…" }).click();
        await expect(
          page.getByRole("heading", { name: "MCP servers for your agents" }),
        ).toBeVisible();
        await page.getByRole("combobox", { name: "Configuration for" }).click();
        await page.getByRole("option", { name: `${envA.name} (worktree)` }).click();
        await expect(page.getByRole("region", { name: "Recent changes" })).toBeVisible({
          timeout: 30_000,
        });
      };
      const closeSettings = async () => {
        await page.getByRole("button", { name: "Close settings" }).click();
        const panel = page.getByRole("dialog", { name: "Agent information" });
        const closePanel = panel.getByRole("button", { name: "Close agent information" });
        if (await closePanel.isVisible()) await closePanel.click();
      };

      await page.goto(status.browserUrl!);
      await openEnvironment(envB.name);
      await expect(page.getByTestId("shared-native-compose-bar")).toBeVisible({ timeout: 90_000 });

      const token = nonce("MCPQXV1");
      const pid = await bridgePid();
      expect(pid, "A's Codex bridge is running").toBeTruthy();
      let addOperationId = "";
      const beforeAdd = reloads.count(worktreeA!);
      let afterAdd = beforeAdd;

      await test.step("one save plans both threads of A's app-server, and nothing in B", async () => {
        const saved = await saveAndApply({
          kind: "add",
          sourceId: project.sourceId,
          expectedRevision: project.revision,
          definition: {
            name: "mcpqa",
            transport: "stdio",
            command: process.execPath,
            args: [serverScript, "mcpqa", "1", token, marker],
          },
        });
        addOperationId = saved.operation.operationId;
        record("planned", describe(saved.operation));
        const inA = saved.operation.apply.runtimes.filter(
          (runtime) => runtime.environmentId === envA.id,
        );
        expect(inA, "both of A's threads are planned").toHaveLength(2);
        expect(
          saved.operation.apply.runtimes.filter((runtime) => runtime.environmentId === envB.id),
          "a project file reaches only A",
        ).toEqual([]);
        // The reload settles both, then each waits for its own next turn.
        await waitFor(addOperationId, a1, "pending-next-turn", "A1 never left the reload");
        await waitFor(addOperationId, a2, "pending-next-turn", "A2 never left the reload");
        const settled = await operation(addOperationId);
        record("after-reload", describe(settled));
        const generations = new Set(
          settled.apply.runtimes
            .filter((runtime) => runtime.environmentId === envA.id)
            .map((runtime) => runtime.generation),
        );
        expect(generations.size, "each thread names its own generation").toBe(2);
        expect(await bridgePid(), "the reload replaced the bridge").toBe(pid);
        expect(markerLines("call mcpqa 1")).toBe(0);
        afterAdd = reloads.count(worktreeA!);
        expect(afterAdd - beforeAdd, "one process-wide reload for the add").toBe(1);
      });

      await test.step("A1's turn while A is inactive and the stream is down proves only A1", async () => {
        await openSettingsForA();
        await stream.cut(context);
        trace("offline, stream cut");
        const offlineAt = Date.now();
        const reply = await turn(a1, toolPrompt("mcpqa"), `pong mcpqa v1 ${token}`);
        expect(reply).toContain(token);
        const applied = await waitFor(addOperationId, a1, "applied", "A1 never proved its turn");
        expect(applied.reason).toBe(CODEX_APPLIED_REASON);
        expect(markerLines("call mcpqa 1")).toBe(1);
        // A2 shares the process that loaded the change, but has not run a turn.
        await page.waitForTimeout(EVIDENCE_SETTLE_MS);
        expect(
          runtimeOf(await operation(addOperationId), a2)?.state,
          "A1's turn was taken as A2's evidence",
        ).toBe("pending-next-turn");
        await page.waitForTimeout(Math.max(0, 15_000 - (Date.now() - offlineAt)));
        await context.setOffline(false);
        trace("online");
        await stream.expectReconnected();
        await closeSettings();
      });

      await test.step("A2's own turn proves A2, on the same bridge process", async () => {
        const reply = await turn(a2, toolPrompt("mcpqa"), `pong mcpqa v1 ${token}`);
        expect(reply).toContain(token);
        const applied = await waitFor(addOperationId, a2, "applied", "A2 never proved its turn");
        expect(applied.reason).toBe(CODEX_APPLIED_REASON);
        expect(markerLines("call mcpqa 1")).toBe(2);
        expect(await bridgePid(), "the bridge changed between the two threads").toBe(pid);
        record("applied", describe(await operation(addOperationId)));
        expect(
          reloads.count(worktreeA!) - beforeAdd,
          "duplicate add reload after thread turns",
        ).toBe(1);
      });

      await test.step("after a hard reload the card reads saved and loaded", async () => {
        await page.reload();
        await openSettingsForA();
        await expect(settingsCard("Added", "mcpqa")).toContainText("Saved and loaded", {
          timeout: 60_000,
        });
        await closeSettings();
      });

      await test.step("a removal: both threads wait, then each finds the tool gone", async () => {
        const beforeRemove = reloads.count(worktreeA!);
        expect(beforeRemove).toBe(afterAdd);
        const current = await snapshot(targetA.targetId);
        const definition = current.definitions.find(
          (candidate) => candidate.sourceId === project.sourceId && candidate.name === "mcpqa",
        );
        expect(definition, "mcpqa is saved").toBeTruthy();
        const saved = await saveAndApply({
          kind: "remove",
          entryId: definition!.entryId,
          expectedRevision: current.sources.find((item) => item.sourceId === project.sourceId)!
            .revision!,
        });
        const operationId = saved.operation.operationId;
        await waitFor(operationId, a1, "pending-next-turn", "A1 never left the reload");
        await waitFor(operationId, a2, "pending-next-turn", "A2 never left the reload");
        expect(
          reloads.count(worktreeA!) - beforeRemove,
          "one process-wide reload for removal",
        ).toBe(1);
        for (const who of [a1, a2]) {
          const absent = nonce("MCPQXNOTOOL");
          await turn(who, absentPrompt("mcpqa", absent), absent);
          const applied = await waitFor(
            operationId,
            who,
            "applied",
            `${label(who)} never proved the removal`,
          );
          expect(applied.reason).toBe(CODEX_APPLIED_REASON);
        }
        expect(markerLines("call mcpqa 1"), "the removed server was called").toBe(2);
        expect(await bridgePid(), "the bridge changed during the removal").toBe(pid);
        record("removed", describe(await operation(operationId)));
        expect(
          reloads.count(worktreeA!) - beforeRemove,
          "duplicate removal reload after turns",
        ).toBe(1);
      });
    } finally {
      await context.setOffline(false).catch(() => undefined);
      for (const created of environments) {
        await invoke?.("stop_environment", { environmentId: created.id }).catch(() => undefined);
        await invoke?.("delete_environment", { environmentId: created.id }).catch(() => undefined);
      }
      try {
        await fake?.stop();
      } finally {
        reloads.stop();
      }
    }
  });
});
