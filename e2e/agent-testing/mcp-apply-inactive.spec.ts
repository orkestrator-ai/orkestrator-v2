/**
 * MCP apply for an inactive environment, against a real `dev:test --fixture`
 * profile and a real Claude session.
 *
 * Opt-in only: the turns run on the host's Claude credentials, so the case is
 * skipped unless `ORKESTRATOR_AGENT_TEST_LIVE_MCP=1`. Nothing at module scope
 * spawns `mise` or reads profile state, so the file stays inert in
 * profile-free runs.
 *
 * Every edit goes to a file the profile owns: environment A's worktree
 * `.mcp.json` (project scope) and the profile's isolated `~/.claude.json`
 * (backend-user scope; an agent-test profile runs the backend with its own
 * HOME). The case refuses to run if that user file is not inside the profile.
 * The fixture MCP server is a script written under this run's output folder;
 * its one tool answers with a nonce that exists only in the server's
 * arguments, so a reply carrying it proves the saved server really ran, and a
 * marker file records every call.
 *
 * What it checks (docs/todo/mcp/0039-mcp-management.md, "Inactive environment"):
 *
 * - Save and apply while A's turn runs: the turn is not interrupted, and the
 *   runtime stays `pending-next-turn` after it ends, because that query
 *   started before the save.
 * - A's next turn runs while the user is elsewhere and the browser is offline;
 *   the change is `applied` against the planned generation, the tool answers,
 *   and the open settings view shows "Saved and loaded" once the event stream
 *   reconnects, without a manual refresh.
 * - After a hard reload: the outcome, the saved revision, the effective
 *   definition, the transcript, the composer controls and the live MCP panel.
 * - A bridge restart between the save and the next turn: nothing is claimed
 *   before the new bridge runs a query, then `applied` names the newer run and
 *   only the edited server answers.
 * - A removal while inactive: `applied`, and the removed tool is not called.
 * - A shared user-file change reaches both environments' sessions, each with
 *   its own generation.
 *
 * `ORKESTRATOR_AGENT_TEST_MODEL` pins both tabs' Claude model (the profile's
 * default otherwise), e.g. when the account is rate limited on the default.
 */
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  turn: { phase: string; error?: string };
  messages?: Message[];
  recoverableDispatch?: { requestId: string };
} | null;
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const LIVE_OPT_IN = process.env.ORKESTRATOR_AGENT_TEST_LIVE_MCP === "1";
const DESKTOP_VIEWPORT = { width: 1440, height: 1200 };
/**
 * `ORKESTRATOR_AGENT_TEST_MCP_APPLY_ONLY=1` keeps every apply, generation and
 * UI check but drops the ones that need the model to answer (replies, tool
 * calls, transcript text, the live panel's inventory). Claude's bridge records
 * the MCP files a query was built from when the query starts, before any API
 * call, so a turn the provider refuses (a rate limit, say) still proves what
 * the runtime loaded.
 */
const MODEL_CHECKS = process.env.ORKESTRATOR_AGENT_TEST_MCP_APPLY_ONLY !== "1";
/** Optional Claude model for both tabs; the profile's default otherwise. */
const LAUNCH_MODEL = process.env.ORKESTRATOR_AGENT_TEST_MODEL?.trim() || undefined;

/** Mirrors `NEWER_RUN_REASON` in apps/backend/src/core/mcp-management/evidence.ts. */
const NEWER_RUN_REASON =
  "A newer run of this session, started after apply was planned, loaded the saved configuration.";
const APPLIED_REASON = "The session's latest message started with the saved configuration.";
/** The evidence poll re-reads a runtime at most every 10 s; wait past two polls. */
const EVIDENCE_SETTLE_MS = 25_000;

/**
 * A harmless stdio MCP server: one tool, `probe_<name>`, that answers
 * `pong <name> v<version> <nonce>` and appends `call <name> <version>` to the
 * marker file. Plain ESM so the runner's own `node` executes it.
 */
const FIXTURE_SERVER = `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [name, version, nonce, marker] = process.argv.slice(2);
appendFileSync(marker, \`start \${name} \${version} \${process.pid}\\n\`);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin })
  .on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id === undefined) return;
    const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
    switch (message.method) {
      case "initialize":
        return reply({
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: \`mcpq-\${name}\`, version },
        });
      case "tools/list":
        return reply({ tools: [{
          name: \`probe_\${name}\`,
          description: \`Answers with a fixed token from the \${name} fixture.\`,
          inputSchema: { type: "object", properties: {} },
        }] });
      case "tools/call":
        appendFileSync(marker, \`call \${name} \${version}\\n\`);
        return reply({ content: [{ type: "text", text: \`pong \${name} v\${version} \${nonce}\` }] });
      case "ping":
        return reply({});
      default:
        return send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
    }
  })
  .on("close", () => process.exit(0));
`;

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
      { data: { command, args } },
    );
    expect(invokeResponse.ok(), `${command}: ${await invokeResponse.text()}`).toBe(true);
    return ((await invokeResponse.json()) as { result: T }).result;
  };
}

function sidebarNavigator(page: Page, projectName: string) {
  return async (name: string) => {
    const expand = page.getByRole("button", { name: `Expand project ${projectName}` });
    const entry = page.getByText(name, { exact: true }).first();
    await expect(expand.or(entry).first()).toBeVisible({ timeout: 30_000 });
    for (const label of ["Continue Without Docker", "Continue Without GitHub CLI"]) {
      const continueButton = page.getByRole("button", { name: label, exact: true });
      if (await continueButton.isVisible()) await continueButton.click();
    }
    if (await expand.isVisible()) await expand.click();
    // A sidebar tooltip from the previous hover can sit over the entry.
    await dismissSidebarTooltip(page, projectName);
    await entry.click();
  };
}

const textOf = (message: Message) => (typeof message.content === "string" ? message.content : "");
const count = (messages: Message[] | undefined, role: string, needle: string) =>
  (messages ?? []).filter((message) => message.role === role && textOf(message).includes(needle))
    .length;
/** Random and never typed, so only the fixture server can produce it. */
const nonce = (tag: string) => `${tag}-${randomBytes(5).toString("hex")}`;

test.describe("live MCP apply in an inactive environment (claude)", () => {
  test.skip(
    !LIVE_OPT_IN,
    "opt-in live Claude turns against the isolated fixture with host credentials",
  );

  test("save and apply while busy or away, across a dropped stream, a reload and a bridge restart", async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(1_500_000);
    page.setDefaultTimeout(15_000);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    // A dev profile's backend reports the Electron version as its own, so every
    // event-stream reconnect (this case forces one) raises this reminder.
    await page.addLocatorHandler(
      page.getByText("Reload to use the matching version."),
      async (reminder) => {
        await reminder.click();
      },
    );

    const status = profileStatus();
    expect(status.profile, "dev:status answered for a different profile").toBe(profile);
    expect(status.status, `profile "${profile}" is not running`).toBe("ready");
    expect(status.flavor).toBe("agent-test");
    const invoke = await authenticatedInvoke(page, status);
    const fixture = (await invoke<Project[]>("get_projects")).find(
      (project) => project.localPath === status.testProject,
    );
    expect(fixture, `the ${profile} fixture project is missing`).toBeTruthy();

    const runDir = path.join(
      repositoryRoot,
      "output",
      "agent-testing",
      profile,
      `mcp-inactive-${Date.now()}`,
    );
    mkdirSync(runDir, { recursive: true });
    const serverScript = path.join(runDir, "fixture-server.mjs");
    const marker = path.join(runDir, "calls.log");
    writeFileSync(serverScript, FIXTURE_SERVER);
    writeFileSync(marker, "");
    const markerLines = (prefix: string) =>
      readFileSync(marker, "utf8")
        .split("\n")
        .filter((line) => line === prefix).length;
    const stdio = (name: string, version: string, token: string) => ({
      name,
      transport: "stdio" as const,
      command: process.execPath,
      args: [serverScript, name, version, token, marker],
    });

    const environments: Environment[] = [];
    let userEntryCleanup: (() => Promise<void>) | undefined;
    try {
      for (const name of ["mcpq-a", "mcpq-b"]) {
        environments.push(
          await invoke<Environment>("create_environment", {
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
        await invoke("start_environment", { environmentId: environment.id });
      }
      const worktreeA = (await invoke<Environment>("get_environment", { environmentId: envA.id }))
        .worktreePath;
      expect(worktreeA).toBeTruthy();

      const identities = new Map<string, Record<string, string>>();
      for (const environment of environments) {
        const tabId = `mcpq-${environment.id.slice(0, 8)}`;
        const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
          environmentId: environment.id,
        });
        await invoke("save_pane_layout", {
          environmentId: environment.id,
          expectedRevision: layout?.revision ?? 0,
          layout: {
            version: PANE_LAYOUT_VERSION,
            containerId: null,
            activePaneId: "pane-mcpq",
            root: {
              kind: "leaf",
              id: "pane-mcpq",
              activeTabId: tabId,
              tabs: [
                {
                  id: tabId,
                  type: "agent-native",
                  nativeAgentData: {
                    environmentId: environment.id,
                    platform: "claude",
                    isLocal: true,
                  },
                  ...(LAUNCH_MODEL ? { initialAgentModel: LAUNCH_MODEL } : {}),
                },
              ],
            },
          },
        });
        identities.set(environment.id, {
          environmentId: environment.id,
          agent: "claude",
          logicalSessionKey: `env-${environment.id}:${tabId}`,
        });
      }
      const identityA = identities.get(envA.id)!;
      const identityB = identities.get(envB.id)!;
      const projection = (identity: Record<string, string>) =>
        invoke<Projection>("get_native_agent_projection", identity);
      const settled = async (identity: Record<string, string>) => {
        const current = await projection(identity);
        const phase = current?.turn.phase;
        return (phase === "idle" || phase === "error") && !current?.recoverableDispatch;
      };
      const replies = async (identity: Record<string, string>, needle: string) =>
        count((await projection(identity))?.messages, "assistant", needle);

      // --- MCP management helpers (the same commands the settings UI uses) ---
      const claudeTarget = async (environmentId: string) => {
        const list = await invoke<{ targets: McpManagementTarget[] }>(
          "list_mcp_management_targets",
          { environmentId },
        );
        const target = list.targets.find(
          (candidate) =>
            candidate.provider === "claude" &&
            candidate.context.kind === "environment" &&
            candidate.context.environmentId === environmentId,
        );
        expect(target, `no Claude MCP target for ${environmentId}`).toBeTruthy();
        return target!;
      };
      const snapshot = (targetId: string) =>
        invoke<McpManagementSnapshot>("get_mcp_management_snapshot", { targetId });
      const source = async (targetId: string, scope: McpConfigSource["scope"]) => {
        const found = (await snapshot(targetId)).sources.find(
          (candidate) => candidate.scope === scope,
        );
        expect(found, `no ${scope} source`).toBeTruthy();
        expect(found!.writable, `${scope} source is read-only: ${found!.readOnlyReason}`).toBe(
          true,
        );
        return found!;
      };
      const entryOf = async (targetId: string, sourceId: string, name: string) => {
        const current = await snapshot(targetId);
        const definition = current.definitions.find(
          (candidate) => candidate.sourceId === sourceId && candidate.name === name,
        );
        expect(definition, `${name} is not saved`).toBeTruthy();
        const revision = current.sources.find(
          (candidate) => candidate.sourceId === sourceId,
        )?.revision;
        return { entryId: definition!.entryId, revision: revision!, snapshot: current };
      };
      const saveAndApply = async (targetId: string, operation: McpMutationOperation) => {
        const result = await invoke<McpMutationResult>("mutate_mcp_definition", {
          mutation: {
            requestId: `mcpq-${randomUUID()}`,
            targetId,
            applyIntent: "save-and-apply",
            operation,
          },
        });
        expect(result.operation.phase, result.operation.message).toBe("saved");
        return result;
      };
      const operation = (operationId: string) =>
        invoke<McpOperationSnapshot>("get_mcp_operation", { operationId });
      const runtimeIn = (snapshotValue: McpOperationSnapshot, environmentId: string) =>
        snapshotValue.apply.runtimes.find((runtime) => runtime.environmentId === environmentId);
      const waitForRuntime = async (
        operationId: string,
        environmentId: string,
        state: McpRuntimeApplyEntry["state"],
        message: string,
      ) => {
        let last: McpRuntimeApplyEntry | undefined;
        await expect
          .poll(
            async () => {
              last = runtimeIn(await operation(operationId), environmentId);
              return last?.state;
            },
            { timeout: 180_000, intervals: [2_000], message },
          )
          .toBe(state);
        return last!;
      };
      const record = (type: string, description: string) =>
        testInfo.annotations.push({ type, description });

      // --- UI helpers ---
      const openEnvironment = sidebarNavigator(page, fixture!.name);
      const composeBar = page.getByTestId("shared-native-compose-bar");
      const input = composeBar.getByRole("textbox", { name: "Message Claude" });
      const typeIntoComposer = async (text: string) => {
        await expect(input).toBeVisible({ timeout: 90_000 });
        await expect(async () => {
          await input.click();
          await input.fill("");
          await page.keyboard.type(text);
          await expect(input).toHaveText(text, { timeout: 2_000 });
        }).toPass({ timeout: 30_000 });
      };
      /** Send from the keyboard and return the browser's own dispatch arguments. */
      const sendFromComposer = async (text: string) => {
        await typeIntoComposer(text);
        const submitted = page.waitForRequest((request) => {
          if (request.method() !== "POST" || !request.url().endsWith("/__orkestrator/invoke"))
            return false;
          const body = request.postDataJSON() as {
            command?: string;
            args?: Record<string, unknown>;
          };
          return body.command === "dispatch_native_agent_intent" && body.args?.prompt === text;
        });
        await expect(composeBar.getByRole("button", { name: "Send", exact: true })).toBeEnabled({
          timeout: 30_000,
        });
        await input.press("Enter");
        return ((await submitted).postDataJSON() as { args: Record<string, unknown> }).args;
      };
      let dispatchTemplate: Record<string, unknown> | undefined;
      /**
       * Send a message to a session whose tab is not on screen, the way the
       * browser would: the arguments of a real submission from this run with a
       * new prompt and request id.
       */
      const dispatchWhileAway = async (identity: Record<string, string>, prompt: string) => {
        expect(dispatchTemplate, "no browser submission to model the dispatch on").toBeTruthy();
        const outcome = await invoke<{ outcome: string; error?: string }>(
          "dispatch_native_agent_intent",
          { ...dispatchTemplate, ...identity, prompt, requestId: randomUUID() },
        );
        expect(outcome.outcome, outcome.error).toBe("accepted");
      };
      const toolPrompt = (name: string) =>
        `Call the MCP tool probe_${name} from the ${name} server exactly once, then reply with exactly the text it returned and nothing else.`;
      const turnState = async (identity: Record<string, string>) => {
        const current = await projection(identity);
        const turn = current?.turn;
        // On a provider failure the last assistant row usually carries its text.
        const last = turn?.error
          ? [...(current?.messages ?? [])].reverse().find((message) => message.role === "assistant")
          : undefined;
        return (
          `${turn?.phase ?? "no session"}${turn?.error ? ` (${turn.error.slice(0, 200)})` : ""}` +
          (last ? ` last reply: ${textOf(last).slice(0, 200)}` : "")
        );
      };
      const startedAt = Date.now();
      /** Timestamped progress in the run log, so a failure can be placed in time. */
      const trace = async (label: string, identity?: Record<string, string>) =>
        console.log(
          `[mcpq +${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${label}` +
            (identity ? `: ${await turnState(identity)}` : ""),
        );
      // The page's own event stream, to place a dropped or resumed stream in time.
      const stream = watchEventStream(page, (line) => void trace(line));
      const waitForReply = async (identity: Record<string, string>, needle: string) => {
        try {
          await expect
            .poll(async () => (await settled(identity)) && (await replies(identity, needle)), {
              timeout: 240_000,
              intervals: [3_000],
              message: `no reply carrying ${needle}`,
            })
            .toBe(1);
        } catch (error) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\nlast turn: ${await turnState(identity)}`,
          );
        }
      };

      /** The reply when the model is checked, otherwise only a settled turn. */
      const replied = async (identity: Record<string, string>, needle: string) => {
        if (MODEL_CHECKS) return waitForReply(identity, needle);
        await expect
          .poll(() => settled(identity), { timeout: 240_000, intervals: [3_000] })
          .toBe(true);
        record("apply-only-turn", `${needle.split("-")[0]}: ${await turnState(identity)}`);
      };
      const expectCalls = (line: string, count: number, message?: string) => {
        if (MODEL_CHECKS) expect(markerLines(line), message).toBe(count);
      };
      const settingsCard = (kind: string, name: string) =>
        page
          .getByRole("region", { name: "Recent changes" })
          .getByRole("listitem")
          .filter({ hasText: new RegExp(`^${kind} ${name}`) })
          .first();
      /** Open MCP settings from B's agent panel, then switch the context to A. */
      const openSettingsForA = async () => {
        await openEnvironment(envB.name);
        await expect(input).toBeVisible({ timeout: 90_000 });
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
      /** Close settings and the agent panel that opened them, which overlays the sidebar. */
      const closeSettings = async () => {
        await page.getByRole("button", { name: "Close settings" }).click();
        // The panel's own close button; its trigger and a full-page backdrop
        // share the label, and the backdrop covers the trigger.
        const panel = page.getByRole("dialog", { name: "Agent information" });
        const closePanel = panel.getByRole("button", { name: "Close agent information" });
        if (await closePanel.isVisible()) await closePanel.click();
      };

      // Mount both tabs so each environment has a persisted Claude session.
      await page.goto(status.browserUrl!);
      for (const environment of [envB, envA]) {
        await openEnvironment(environment.name);
        await expect(input).toBeVisible({ timeout: 90_000 });
        await expect
          .poll(async () => (await projection(identities.get(environment.id)!)) !== null, {
            timeout: 120_000,
            message: `${environment.name} never created its session`,
          })
          .toBe(true);
      }

      const targetA = await claudeTarget(envA.id);
      const projectA = await source(targetA.targetId, "project");
      const tokenV1 = nonce("MCPQV1");
      const tokenV2 = nonce("MCPQV2");
      const busyToken = nonce("MCPQBUSY");
      let addOperationId = "";
      let plannedGeneration: string | undefined;

      await test.step("save and apply while A is busy: the turn goes on and nothing is claimed", async () => {
        dispatchTemplate = await sendFromComposer(
          "Write every whole number from 1 to 250 in words, separated by commas. Then on a final " +
            `line write exactly the text ${busyToken} and nothing else. Do not use any tools.`,
        );
        await expect
          .poll(async () => (await projection(identityA))?.turn.phase, {
            timeout: 90_000,
            message: "the busy turn never started",
          })
          .toBe("running");
        await trace("busy turn started", identityA);
        const saved = await saveAndApply(targetA.targetId, {
          kind: "add",
          sourceId: projectA.sourceId,
          expectedRevision: projectA.revision,
          definition: stdio("mcpqa", "1", tokenV1),
        });
        await trace("saved and applied", identityA);
        addOperationId = saved.operation.operationId;
        const planned = runtimeIn(saved.operation, envA.id);
        expect(planned?.state).toBe("pending-next-turn");
        expect(planned?.generation, "a local runtime names its generation").toMatch(
          /^[A-Za-z0-9_-]{16}$/,
        );
        plannedGeneration = planned!.generation;
        // A project file reaches only A's sessions.
        expect(runtimeIn(saved.operation, envB.id)).toBeUndefined();
        if (MODEL_CHECKS) {
          expect((await projection(identityA))?.turn.phase, "apply interrupted the turn").toBe(
            "running",
          );
        }
        await page.waitForTimeout(5_000);
        await trace("5 s after the save", identityA);
        await openEnvironment(envB.name);
        await page.waitForTimeout(5_000);
        await trace("5 s after switching to B", identityA);
        await replied(identityA, busyToken);
        await trace("busy turn finished", identityA);
        if (MODEL_CHECKS) expect((await projection(identityA))?.turn.error).toBeFalsy();
        // That query started before the save, so it proves nothing.
        await page.waitForTimeout(EVIDENCE_SETTLE_MS);
        const after = runtimeIn(await operation(addOperationId), envA.id);
        expect(after?.state, "a query that predates the save was taken as evidence").toBe(
          "pending-next-turn",
        );
        expect(markerLines("call mcpqa 1")).toBe(0);
      });

      await test.step("the next turn loads it while A is inactive and the event stream is down", async () => {
        await openSettingsForA();
        const card = settingsCard("Added", "mcpqa");
        await expect(card).toContainText("Saved; not loaded until the session's next message");
        // Offline emulation alone leaves an open stream connected, so cut it
        // too: the page must notice, miss the change, and catch up on reconnect.
        await stream.cut(context);
        await trace("offline, stream cut");
        const offlineAt = Date.now();
        await dispatchWhileAway(identityA, toolPrompt("mcpqa"));
        const applied = await waitForRuntime(
          addOperationId,
          envA.id,
          "applied",
          "the inactive session never proved it loaded the save",
        );
        expect(applied.reason).toBe(APPLIED_REASON);
        expect(applied.generation, "same bridge and conversation: same generation").toBe(
          plannedGeneration,
        );
        await replied(identityA, tokenV1);
        expectCalls("call mcpqa 1", 1);
        // Keep the outage long enough for the page to lose its event stream.
        await page.waitForTimeout(Math.max(0, 15_000 - (Date.now() - offlineAt)));
        await context.setOffline(false);
        await trace("online");
        // No Refresh click: the section re-reads when its stream reconnects.
        await expect(card).toContainText("Saved and loaded", { timeout: 60_000 });
        await expect(card).toContainText(APPLIED_REASON);
        await stream.expectReconnected();
        await closeSettings();
      });

      await test.step("after a hard reload the state is the same everywhere", async () => {
        await page.reload();
        await openSettingsForA();
        await expect(settingsCard("Added", "mcpqa")).toContainText("Saved and loaded");
        await closeSettings();
        const { snapshot: current } = await entryOf(targetA.targetId, projectA.sourceId, "mcpqa");
        const operationNow = await operation(addOperationId);
        const sourceNow = current.sources.find((item) => item.sourceId === projectA.sourceId);
        expect(sourceNow?.revision, "the file changed after the save").toBe(
          operationNow.savedRevision,
        );
        expect(current.effective.mcpqa).toBeTruthy();
        const saved = JSON.parse(readFileSync(path.join(worktreeA!, ".mcp.json"), "utf8")) as {
          mcpServers?: Record<string, { args?: string[] }>;
        };
        expect(saved.mcpServers?.mcpqa?.args?.[2]).toBe("1");
        await openEnvironment(envA.name);
        if (MODEL_CHECKS) {
          await expect(page.getByText(`pong mcpqa v1 ${tokenV1}`).first()).toBeVisible({
            timeout: 60_000,
          });
        }
        await expect(composeBar.getByTitle("Stop current query")).toBeHidden();
        await expect(input).toBeEditable();
        await page.getByRole("button", { name: "Open agent information" }).first().click();
        // The live panel, read from the session's own inventory.
        const panel = page.getByLabel("MCP servers", { exact: true });
        await expect(panel).toBeVisible({ timeout: 60_000 });
        const toggle = panel.getByRole("button").first();
        if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
        if (MODEL_CHECKS) await expect(panel).toContainText("mcpqa", { timeout: 30_000 });
        // The panel's link opens this environment's saved servers.
        await page.getByRole("button", { name: "Manage saved MCP servers…" }).click();
        await expect(page.getByRole("combobox", { name: "Configuration for" })).toHaveText(
          `${envA.name} (worktree)`,
        );
        await expect(settingsCard("Added", "mcpqa")).toContainText("Saved and loaded");
        await closeSettings();
      });

      await test.step("a bridge restart before the next turn: applied names the newer run", async () => {
        await openEnvironment(envB.name);
        const entry = await entryOf(targetA.targetId, projectA.sourceId, "mcpqa");
        const saved = await saveAndApply(targetA.targetId, {
          kind: "update",
          entryId: entry.entryId,
          expectedRevision: entry.revision,
          patch: {
            args: [
              { kind: "keep", index: 0 },
              { kind: "keep", index: 1 },
              { kind: "set", value: "2" },
              { kind: "set", value: tokenV2 },
              { kind: "keep", index: 4 },
            ],
          },
        });
        const planned = runtimeIn(saved.operation, envA.id)!;
        expect(planned.state).toBe("pending-next-turn");
        await invoke("stop_local_claude_server_cmd", { environmentId: envA.id });
        await invoke("start_local_claude_server_cmd", { environmentId: envA.id });
        await invoke("await_bridge_ready", {
          environmentId: envA.id,
          agent: "claude",
          timeoutMs: 60_000,
        });
        // The new bridge has run no query yet, so it cannot prove anything.
        await page.waitForTimeout(EVIDENCE_SETTLE_MS);
        expect(runtimeIn(await operation(saved.operation.operationId), envA.id)?.state).toBe(
          "pending-next-turn",
        );
        await dispatchWhileAway(identityA, toolPrompt("mcpqa"));
        const applied = await waitForRuntime(
          saved.operation.operationId,
          envA.id,
          "applied",
          "the restarted bridge never proved it loaded the edit",
        );
        record(
          "restart-generation",
          `planned ${planned.generation}, applied ${applied.generation}`,
        );
        expect(applied.generation, "a restarted bridge is a new generation").not.toBe(
          planned.generation,
        );
        expect(applied.reason).toBe(NEWER_RUN_REASON);
        await replied(identityA, tokenV2);
        expectCalls("call mcpqa 2", 1);
        expectCalls("call mcpqa 1", 1, "the replaced server answered");
        await openSettingsForA();
        const card = settingsCard("Edited", "mcpqa");
        await expect(card).toContainText("Saved and loaded");
        await expect(card).toContainText(NEWER_RUN_REASON);
        await closeSettings();
        await openEnvironment(envA.name);
        if (MODEL_CHECKS) {
          await expect(page.getByText(`pong mcpqa v2 ${tokenV2}`).first()).toBeVisible({
            timeout: 60_000,
          });
        }
      });

      await test.step("a removal while A is inactive: applied, and the tool is gone", async () => {
        await openEnvironment(envB.name);
        const entry = await entryOf(targetA.targetId, projectA.sourceId, "mcpqa");
        const saved = await saveAndApply(targetA.targetId, {
          kind: "remove",
          entryId: entry.entryId,
          expectedRevision: entry.revision,
        });
        expect(runtimeIn(saved.operation, envA.id)?.state).toBe("pending-next-turn");
        await openSettingsForA();
        const card = settingsCard("Removed", "mcpqa");
        await expect(card).toContainText("Saved; not loaded until the session's next message");
        // This time the stream stays up through the outage: the change event
        // arrives, but the re-read it triggers cannot.
        await context.setOffline(true);
        await trace("offline, stream kept");
        const absentToken = nonce("MCPQNOTOOL");
        await dispatchWhileAway(
          identityA,
          "If a tool named probe_mcpqa is available to you, call it once and reply with exactly " +
            `its result. If it is not available, reply with exactly ${absentToken} and nothing else.`,
        );
        const applied = await waitForRuntime(
          saved.operation.operationId,
          envA.id,
          "applied",
          "the removal was never proven",
        );
        expect(applied.reason).toBe(APPLIED_REASON);
        await replied(identityA, absentToken);
        expectCalls("call mcpqa 2", 1, "the removed server was called");
        await page.waitForTimeout(EVIDENCE_SETTLE_MS);
        await context.setOffline(false);
        await trace("online");
        await expect(card).toContainText("Saved and loaded", { timeout: 30_000 });
        await closeSettings();
      });

      await test.step("a bridge older than the MCP report: said so, and the change still loads", async () => {
        // Optional: the dist folder of a Claude bridge built before the
        // `mcpConfigReporting` marker. It stands in for a bridge left running
        // across a backend upgrade: it is swapped in only to start A's bridge,
        // and the current build is restored as soon as that bridge is up.
        const olderDist = process.env.ORKESTRATOR_AGENT_TEST_MCP_OLDER_CLAUDE_BRIDGE?.trim();
        if (!olderDist) {
          record("skip-step", "no ORKESTRATOR_AGENT_TEST_MCP_OLDER_CLAUDE_BRIDGE build given");
          return;
        }
        const olderBundle = path.join(olderDist, "index.js");
        expect(readFileSync(olderBundle, "utf8")).not.toContain("mcpConfigReporting");
        const currentBundle = path.join(
          repositoryRoot,
          "bridges",
          "claude-bridge",
          "dist",
          "index.js",
        );
        const backup = path.join(runDir, "claude-bridge-index.js");
        copyFileSync(currentBundle, backup);
        const restartA = async () => {
          await invoke("stop_local_claude_server_cmd", { environmentId: envA.id });
          await invoke("start_local_claude_server_cmd", { environmentId: envA.id });
          await invoke("await_bridge_ready", {
            environmentId: envA.id,
            agent: "claude",
            timeoutMs: 60_000,
          });
        };
        await openEnvironment(envB.name);
        const tokenOld = nonce("MCPQOLD");
        const project = await source(targetA.targetId, "project");
        const saved = await saveAndApply(targetA.targetId, {
          kind: "add",
          sourceId: project.sourceId,
          expectedRevision: project.revision,
          definition: stdio("mcpqo", "1", tokenOld),
        });
        try {
          copyFileSync(olderBundle, currentBundle);
          await restartA();
        } finally {
          copyFileSync(backup, currentBundle);
        }
        try {
          // Before it has loaded anything the older bridge reports nothing.
          await page.waitForTimeout(EVIDENCE_SETTLE_MS);
          const waiting = runtimeIn(await operation(saved.operation.operationId), envA.id)!;
          record("older-bridge-before-turn", `${waiting.state}: ${waiting.reason}`);
          expect(waiting.state).toBe("pending-next-turn");
          expect(waiting.reason).toContain("older than this backend");
          await dispatchWhileAway(identityA, toolPrompt("mcpqo"));
          await replied(identityA, tokenOld);
          expectCalls("call mcpqo 1", 1, "the older bridge did not load the save");
          // Bridges since #838 report what they loaded once something has, so
          // the first query is expected to prove it.
          const after = await waitForRuntime(
            saved.operation.operationId,
            envA.id,
            "applied",
            "the older bridge's first query never proved the save",
          );
          record("older-bridge-after-turn", `${after.state}: ${after.reason}`);
        } finally {
          // Leave A on the current bridge.
          await restartA();
        }
      });

      await test.step("a shared user-file change reaches both environments", async () => {
        const userSource = await source(targetA.targetId, "backend-user");
        // Only ever the profile's own HOME, never an operator's file.
        const userFile = path.join(status.dataDir!, "agent-credentials", "home", ".claude.json");
        expect(userSource.displayPath).toBe("~/.claude.json");
        expect(existsSync(path.dirname(userFile)), "the profile HOME is not where expected").toBe(
          true,
        );
        const before = existsSync(userFile) ? readFileSync(userFile, "utf8") : undefined;
        const tokenU = nonce("MCPQUSER");
        const saved = await saveAndApply(targetA.targetId, {
          kind: "add",
          sourceId: userSource.sourceId,
          expectedRevision: userSource.revision,
          definition: stdio("mcpqu", "1", tokenU),
        });
        expect(
          readFileSync(userFile, "utf8"),
          "the user-scope save did not land in the profile HOME",
        ).toContain(tokenU);
        userEntryCleanup = async () => {
          const entry = await entryOf(targetA.targetId, userSource.sourceId, "mcpqu").catch(
            () => undefined,
          );
          if (entry) {
            await invoke("mutate_mcp_definition", {
              mutation: {
                requestId: `mcpq-${randomUUID()}`,
                targetId: targetA.targetId,
                applyIntent: "save",
                operation: {
                  kind: "remove",
                  entryId: entry.entryId,
                  expectedRevision: entry.revision,
                },
              },
            });
          }
          if (before === undefined && existsSync(userFile)) {
            const left = JSON.parse(readFileSync(userFile, "utf8")) as Record<string, unknown>;
            if (Object.keys(left).every((key) => key === "mcpServers")) rmSync(userFile);
          }
        };
        const plannedA = runtimeIn(saved.operation, envA.id);
        const plannedB = runtimeIn(saved.operation, envB.id);
        expect(plannedA?.state).toBe("pending-next-turn");
        expect(plannedB?.state).toBe("pending-next-turn");
        expect(plannedA?.generation).not.toBe(plannedB?.generation);
        // B is on screen; A is not.
        await openEnvironment(envB.name);
        await sendFromComposer(toolPrompt("mcpqu"));
        await dispatchWhileAway(identityA, toolPrompt("mcpqu"));
        for (const environment of [envA, envB]) {
          const applied = await waitForRuntime(
            saved.operation.operationId,
            environment.id,
            "applied",
            `${environment.name} never proved it loaded the user file`,
          );
          expect(applied.reason).toBe(APPLIED_REASON);
        }
        await replied(identityA, tokenU);
        await replied(identityB, tokenU);
        expectCalls("call mcpqu 1", 2);
        if (MODEL_CHECKS) {
          await expect(page.getByText(`pong mcpqu v1 ${tokenU}`).first()).toBeVisible({
            timeout: 60_000,
          });
        }
        const targetB = await claudeTarget(envB.id);
        expect((await snapshot(targetB.targetId)).effective.mcpqu).toBeTruthy();
      });
    } finally {
      await context.setOffline(false).catch(() => undefined);
      await userEntryCleanup?.().catch(() => undefined);
      for (const created of environments) {
        await invoke("stop_environment", { environmentId: created.id }).catch(() => undefined);
        await invoke("delete_environment", { environmentId: created.id }).catch(() => undefined);
      }
    }
  });
});
