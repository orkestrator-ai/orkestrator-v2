/**
 * Live approval of an annotation request across disruption, against a real
 * `dev:test --fixture` profile (default provider Claude).
 *
 * Opt-in only (`ORKESTRATOR_AGENT_TEST_LIVE_ANNOTATION_DISRUPTION=1`): it runs
 * billed provider turns and stops and starts the profile, so run this file on
 * its own against a profile you started by hand, never inside
 * `test:agent:browser:isolated`. The provider comes from
 * `ORKESTRATOR_AGENT_TEST_ANNOTATION_AGENT` (default `claude`).
 *
 * 1. An implement request in an Ask-policy environment raises an approval
 *    before its edit (`needs-input`). The browser client opens that
 *    environment, switches to another, reloads, and loses its event stream;
 *    the backend is then stopped and started (a graceful restart). Whatever
 *    survives, nothing is applied implicitly: an interaction still pending is
 *    answered once from the request card and refused when answered again
 *    from chat, and the edit is made exactly once; one that did not survive
 *    is withdrawn, an answer to it is refused, and nothing changes.
 * 2. A request in a fresh environment raises an approval and the backend is
 *    `SIGKILL`ed (a dead generation). After the restart the old approval must never be
 *    applied: answering it is refused and the source stays unchanged unless
 *    a new, live approval is raised and answered.
 *
 * Content-free facts per step land as `[annotation-disruption]` lines and
 * Playwright annotations.
 */
import { expect, test, type Page } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { openSync, promises as fs } from "node:fs";
import path from "node:path";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  type AgentInteractionRequest,
  type AgentInteractionResolution,
} from "@orkestrator/protocol/agent-interactions";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import {
  WEB_ANNOTATION_COMMANDS as C,
  type WebAnnotationDestination,
  type WebAnnotationRequest,
} from "@orkestrator/protocol/web-annotations";
import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { reserveLoopbackPorts } from "../../apps/desktop/scripts/dev/profile-io";
import { watchEventStream } from "./event-stream-outage";
import {
  EXPECTED_SOURCE_CHANGE,
  FIXTURE_VIEWPORT,
  startFixtureServer,
} from "./web-annotations-support";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const ENABLED = process.env.ORKESTRATOR_AGENT_TEST_LIVE_ANNOTATION_DISRUPTION === "1";
const AGENT = (process.env.ORKESTRATOR_AGENT_TEST_ANNOTATION_AGENT ??
  "claude") as WebAnnotationDestination["agent"];
const APPROVAL_KINDS = new Set(["command-approval", "file-approval", "permission"]);

type Status = {
  status: string;
  profile?: string;
  browserUrl?: string;
  testProject?: string;
  pids?: { backend?: number };
};
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

test.describe.configure({ mode: "serial" });
test.use({ trace: "off" });

function profileStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) throw new Error("dev:status returned no manifest");
  return JSON.parse(command.stdout) as Status;
}

function log(step: string, facts: unknown): void {
  const line = `${step} ${JSON.stringify(facts)}`;
  console.log(`[annotation-disruption] ${line}`);
  test.info().annotations.push({ type: "disruption", description: line.slice(0, 1_500) });
}

function runAsync(command: string, args: string[], timeoutMs: number) {
  return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4_096);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

/**
 * Stop and start the profile with its stored selection, as quitting and
 * reopening the app would. `crash` first `SIGKILL`s this profile's backend.
 * `--fixture` is not passed on the way back up (it would recreate the
 * repository every worktree points at). As in `cold-restart-live.spec.ts`.
 */
async function restartProfile(mode: "graceful" | "crash"): Promise<Status> {
  const runtime = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: profile,
    flavor: "agent-test",
  });
  const stored = JSON.parse(
    await fs.readFile(path.join(runtime.profileRoot, "profile.json"), "utf8"),
  ) as { credentialSources?: string[]; agentPlatforms?: string[] };
  if (mode === "crash") {
    const backend = profileStatus().pids?.backend;
    expect(backend, "dev:status names no backend pid").toBeTruthy();
    process.kill(backend!, "SIGKILL");
  }
  const stop = await runAsync("mise", ["run", "dev:stop", "--profile", profile], 90_000);
  expect(stop.code, `dev:stop failed: ${stop.stderr}`).toBe(0);
  const output = openSync(test.info().outputPath(`dev-test-restart-${Date.now()}.log`), "a");
  const launcher = spawn(
    "bun",
    [
      "apps/desktop/scripts/dev-test.ts",
      "--profile",
      profile,
      ...(stored.credentialSources ?? []).flatMap((source) => ["--credential-source", source]),
      ...(stored.agentPlatforms?.length
        ? ["--agent-platforms", stored.agentPlatforms.join(",")]
        : []),
    ],
    { cwd: repositoryRoot, detached: true, stdio: ["ignore", output, output] },
  );
  launcher.unref();
  let status: Status | undefined;
  await expect
    .poll(
      () => {
        status = profileStatus();
        return status.status === "ready" && Boolean(status.browserUrl);
      },
      { timeout: 240_000, intervals: [2_000] },
    )
    .toBe(true);
  return status!;
}

/** Sign a page in and return an invoker bound to the current gateway. */
async function signIn(page: Page, status: Status): Promise<Invoke> {
  const login = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (login.status !== 0) throw new Error("dev:login failed");
  const { loginUrl } = JSON.parse(login.stdout) as { loginUrl: string };
  await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
  return async <T>(command: string, args: Record<string, unknown> = {}) => {
    const response = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl!).href,
      {
        data: { command, args },
      },
    );
    const text = await response.text();
    if (!response.ok()) throw new Error(`${command}: ${text.slice(0, 300)}`);
    return (JSON.parse(text) as { result: T }).result;
  };
}

async function openEnvironment(page: Page, name: string): Promise<void> {
  const entry = page.getByText(name, { exact: true }).first();
  const expand = page.getByRole("button", { name: /^Expand project / }).first();
  await expect(expand.or(entry)).toBeVisible({ timeout: 90_000 });
  for (const label of ["Continue Without Docker", "Continue Without GitHub CLI"]) {
    const button = page.getByRole("button", { name: label, exact: true });
    if (await button.isVisible()) await button.click();
  }
  if (!(await entry.isVisible())) await expand.click();
  await page.mouse.move(0, 0);
  await entry.click();
}

interface Workspace {
  environmentId: string;
  name: string;
  worktreePath: string;
  destination: WebAnnotationDestination;
}

async function workspace(invoke: Invoke, projectId: string, name: string, ask: boolean) {
  const environment = await invoke<{ id: string }>("create_environment", {
    projectId,
    name,
    networkAccessMode: "restricted",
    environmentType: "local",
  });
  if (ask) {
    await invoke("update_environment_agent_settings", {
      environmentId: environment.id,
      agentSettings: { executionPolicy: { approvals: "ask" } },
    });
  }
  await invoke("start_environment", { environmentId: environment.id });
  const hydrated = await invoke<{ worktreePath: string | null }>("get_environment", {
    environmentId: environment.id,
  });
  const tabId = `annotation-disruption-${AGENT}`;
  const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
    environmentId: environment.id,
  });
  await invoke("save_pane_layout", {
    environmentId: environment.id,
    expectedRevision: layout?.revision ?? 0,
    layout: {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "pane-disruption",
      root: {
        kind: "leaf",
        id: "pane-disruption",
        tabs: [
          {
            id: tabId,
            type: "agent-native",
            nativeAgentData: { environmentId: environment.id, platform: AGENT, isLocal: true },
          },
        ],
        activeTabId: tabId,
      },
    },
  });
  const { options } = await invoke<{ options: Array<{ destination: WebAnnotationDestination }> }>(
    C.destinations,
    { environmentId: environment.id },
  );
  const option = options.find((candidate) => candidate.destination.tabId === tabId);
  if (!option) throw new Error(`${AGENT} is not an annotation destination in this profile`);
  return {
    environmentId: environment.id,
    name,
    worktreePath: hydrated.worktreePath!,
    destination: option.destination,
  } satisfies Workspace;
}

/** Create the expected-change note on a served fixture page and send it. */
async function sendImplement(invoke: Invoke, page: Page, target: Workspace, requestId: string) {
  const [port] = await reserveLoopbackPorts(1);
  const fixture = await startFixtureServer(target.worktreePath, port!);
  try {
    await page.setViewportSize(FIXTURE_VIEWPORT);
    await page.goto(`${fixture.url}${EXPECTED_SOURCE_CHANGE.route}`);
    const element = await page.locator(EXPECTED_SOURCE_CHANGE.selector).evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return {
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        text: (node.textContent ?? "").trim(),
        title: document.title,
      };
    });
    const { annotationId } = await invoke<{ annotationId: string }>(C.create, {
      environmentId: target.environmentId,
      operationId: `op-${requestId}`,
      body: EXPECTED_SOURCE_CHANGE.annotationBody,
      capture: {
        producer: "desktop-native",
        capturedAt: new Date().toISOString(),
        documentGeneration: 1,
        page: {
          service: { kind: "port", port: fixture.port },
          route: EXPECTED_SOURCE_CHANGE.route,
          displayUrl: `${fixture.url}${EXPECTED_SOURCE_CHANGE.route}`,
          title: element.title,
          requiresNavigation: false,
        },
        target: {
          kind: "element",
          label: `button “${element.text}”`,
          anchor: {
            stableId: { kind: "test-id", value: "plan-cta-team" },
            semantic: { tagName: "button", role: null, name: element.text },
            text: { exact: element.text, prefix: "", suffix: "" },
            ancestors: [],
            cssPath: EXPECTED_SOURCE_CHANGE.selector,
            scope: { kind: "document" },
          },
          rect: element.rect,
        },
        geometry: {
          viewport: FIXTURE_VIEWPORT,
          scroll: { x: 0, y: 0 },
          zoomFactor: 1,
          devicePixelRatio: 1,
          image: null,
        },
        evidence: { text: element.text, attributes: {}, styles: {}, hierarchy: [], html: "" },
        assetIds: [],
        redaction: {
          attributesRemoved: 0,
          valuesMasked: 0,
          urlParametersRemoved: 0,
          sensitiveRegionsMasked: 0,
          manualRegions: 0,
          imageExcluded: false,
        },
      },
    });
    const { annotation } = await invoke<{
      annotation: { contentRevision: number; currentCaptureId: string };
    }>(C.get, { environmentId: target.environmentId, annotationId });
    const preparation = await invoke<{ preparationId: string; bodyHash: string }>(
      C.requestPrepare,
      {
        environmentId: target.environmentId,
        operation: "implement",
        destination: target.destination,
        annotations: [
          {
            annotationId,
            expectedContentRevision: annotation.contentRevision,
            expectedCaptureId: annotation.currentCaptureId,
          },
        ],
        instruction: "",
      },
    );
    await invoke(C.requestSend, {
      environmentId: target.environmentId,
      preparationId: preparation.preparationId,
      requestId,
      bodyHash: preparation.bodyHash,
    });
  } finally {
    await fixture.stop();
  }
}

const readRequest = async (invoke: Invoke, target: Workspace, requestId: string) =>
  (
    await invoke<{ request: WebAnnotationRequest }>(C.requestGet, {
      environmentId: target.environmentId,
      requestId,
    })
  ).request;

/** Wait for `needs-input` with an approval; the interaction's id. */
async function awaitApproval(invoke: Invoke, target: Workspace, requestId: string) {
  let request: WebAnnotationRequest | null = null;
  await expect
    .poll(
      async () => {
        request = await readRequest(invoke, target, requestId);
        if (["awaiting-review", "completed", "failed", "cancelled"].includes(request.state)) {
          throw new Error(`settled ${request.state} without asking: ${request.stateReason ?? ""}`);
        }
        if (request.state === "queued" && request.blockedReason === "dispatch-rejected") {
          throw new Error(`dispatch rejected: ${request.stateReason ?? ""}`);
        }
        return (
          request.state === "needs-input" &&
          (request.interactions ?? []).some((item) => APPROVAL_KINDS.has(item.kind))
        );
      },
      { timeout: 600_000, intervals: [3_000] },
    )
    .toBe(true);
  return request!.interactions!.find((item) => APPROVAL_KINDS.has(item.kind))!.id;
}

async function pendingInteraction(invoke: Invoke, target: Workspace, id: string) {
  const projection = await invoke<{ interactions: AgentInteractionRequest[] } | null>(
    "get_native_agent_projection",
    {
      environmentId: target.environmentId,
      agent: AGENT,
      logicalSessionKey: target.destination.logicalSessionKey,
      messageLimit: 20,
    },
  );
  return projection?.interactions.find((item) => item.id === id) ?? null;
}

/**
 * The request card's allow-once answer (`RequestInteractions` → the card's
 * primary button): no answers for an approval without choices, otherwise its
 * allow-once option.
 */
function allowOnce(interaction: AgentInteractionRequest): AgentInteractionResolution {
  const question = interaction.presentation.questions[0];
  const answers: Array<{ questionId: string; optionIds: string[] }> = [];
  if (question?.required) {
    const option = question.options.find(
      (item) =>
        item.amendment === undefined &&
        /^(allow|approve|yes|accept|run)\b/i.test(item.label) &&
        !/always|session|remember|policy|deny|reject|never|\bno\b/i.test(item.label),
    );
    if (!option) throw new Error("no allow-once option");
    answers.push({ questionId: question.id, optionIds: [option.id] });
  }
  return {
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    interactionId: interaction.id,
    sessionId: interaction.sessionId,
    action: "answer",
    answer: {
      version: AGENT_INTERACTION_CONTRACT_VERSION,
      interactionId: interaction.id,
      sessionId: interaction.sessionId,
      answers,
    },
    resolvedAt: Date.now(),
  };
}

async function answer(
  invoke: Invoke,
  target: Workspace,
  resolution: AgentInteractionResolution,
): Promise<string> {
  return invoke<{ result: string }>("resolve_native_agent_interaction", {
    environmentId: target.environmentId,
    agent: AGENT,
    logicalSessionKey: target.destination.logicalSessionKey,
    interactionId: resolution.interactionId,
    resolution,
  }).then(
    (outcome) => outcome.result,
    (error: Error) => `error: ${error.message.slice(0, 160)}`,
  );
}

function sourceState(target: Workspace): "original" | "changed" | "other" {
  const run = (expectation?: string) =>
    spawnSync("bun", ["annotation-app/verify-change.ts", ...(expectation ? [expectation] : [])], {
      cwd: target.worktreePath,
      encoding: "utf8",
    }).status;
  if (run("--expect=original") === 0) return "original";
  return run() === 0 ? "changed" : "other";
}

async function settle(invoke: Invoke, target: Workspace, requestId: string) {
  let request: WebAnnotationRequest | null = null;
  await expect
    .poll(
      async () => {
        request = await readRequest(invoke, target, requestId);
        return !["prepared", "queued", "running", "needs-input", "cancelling"].includes(
          request.state,
        );
      },
      { timeout: 600_000, intervals: [5_000] },
    )
    .toBe(true);
  return request!;
}

test("an annotation approval survives a switch, reload, stream loss and restart, and is never applied twice or implicitly", async ({
  page,
}, testInfo) => {
  test.skip(!ENABLED, "requires ORKESTRATOR_AGENT_TEST_LIVE_ANNOTATION_DISRUPTION=1");
  testInfo.setTimeout(45 * 60_000);
  let status = profileStatus();
  expect(status.status).toBe("ready");
  await page.setViewportSize({ width: 1440, height: 960 });
  let invoke = await signIn(page, status);
  const projects = await invoke<Array<{ id: string; localPath: string | null }>>("get_projects");
  // A profile restarted without `--fixture` (as `restartProfile` does) has no
  // `testProject` in its status; its fixture project keeps the same path.
  const project = projects.find((candidate) =>
    status.testProject
      ? candidate.localPath === status.testProject
      : candidate.localPath?.endsWith(path.join("fixtures", "test-project")),
  );
  expect(project).toBeTruthy();
  const suffix = Date.now();
  const a = await workspace(invoke, project!.id, `disrupt-a-${suffix}`, true);
  const b = await workspace(invoke, project!.id, `disrupt-b-${suffix}`, false);
  const created = [a, b];
  try {
    // 1. An approval raised before the edit.
    const first = `req-disrupt-a-${suffix}`;
    await sendImplement(invoke, page, a, first);
    const approval = await awaitApproval(invoke, a, first);
    expect(sourceState(a), "nothing changed before the approval").toBe("original");
    log("raised", { kind: "approval", source: sourceState(a) });

    // Switch away in the client, reload, and lose the event stream.
    await page.goto(status.browserUrl!);
    await openEnvironment(page, a.name);
    await openEnvironment(page, b.name);
    await page.reload();
    await openEnvironment(page, b.name);
    const stream = watchEventStream(page);
    await stream.cut(page.context());
    await page.waitForTimeout(5_000);
    await page.context().setOffline(false);
    await stream.expectReconnected();
    const afterClient = await readRequest(invoke, a, first);
    expect(afterClient.state).toBe("needs-input");
    expect((afterClient.interactions ?? []).map((item) => item.id)).toContain(approval);
    expect(sourceState(a)).toBe("original");
    log("after switch, reload and stream loss", { state: afterClient.state, source: "original" });

    // Graceful restart of the backend (and the app).
    status = await restartProfile("graceful");
    invoke = await signIn(page, status);
    const restarted = await readRequest(invoke, a, first);
    const survivor = await pendingInteraction(invoke, a, approval);
    log("after graceful restart", {
      state: restarted.state,
      interaction: survivor ? survivor.state : "absent",
      source: sourceState(a),
    });
    expect(sourceState(a), "a restart never applies the approval").toBe("original");
    if (survivor && survivor.state === "pending") {
      const card = await answer(invoke, a, allowOnce(survivor));
      const chat = await answer(invoke, a, allowOnce(survivor));
      log("answered", { card, chat });
      expect(card).toBe("applied");
      expect(chat).not.toBe("applied");
    } else {
      // Withdrawn with its generation: an answer to it must be refused.
      const stale = survivor
        ? await answer(invoke, a, allowOnce(survivor))
        : await answer(invoke, a, {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            interactionId: approval,
            sessionId: "unknown",
            action: "deny",
            resolvedAt: Date.now(),
          });
      log("withdrawn approval answered", { result: stale });
      expect(stale).not.toBe("applied");
    }
    const settled = await settle(invoke, a, first);
    const source = sourceState(a);
    log("settled", { state: settled.state, turnOutcome: settled.turnOutcome ?? null, source });
    if (survivor?.state === "pending") {
      expect(settled.state).toBe("awaiting-review");
      expect(source).toBe("changed");
    } else {
      expect(source).toBe("original");
    }

    // 2. A dead generation: the backend is killed while an approval waits.
    // A fresh environment: after a restart cut its turn, the first session
    // refuses new prompts until the user sends a message in chat.
    const c = await workspace(invoke, project!.id, `disrupt-c-${suffix}`, true);
    created.push(c);
    expect(sourceState(c)).toBe("original");
    const second = `req-disrupt-c-${suffix}`;
    await sendImplement(invoke, page, c, second);
    const doomed = await awaitApproval(invoke, c, second);
    status = await restartProfile("crash");
    invoke = await signIn(page, status);
    const old = await pendingInteraction(invoke, c, doomed);
    const deadAnswer = old
      ? await answer(invoke, c, allowOnce(old))
      : await answer(invoke, c, {
          version: AGENT_INTERACTION_CONTRACT_VERSION,
          interactionId: doomed,
          sessionId: "unknown",
          action: "deny",
          resolvedAt: Date.now(),
        });
    const afterCrash = await readRequest(invoke, c, second);
    log("after crash restart", {
      state: afterCrash.state,
      interaction: old ? old.state : "absent",
      answer: deadAnswer,
      source: sourceState(c),
    });
    if (deadAnswer === "applied") {
      // Only acceptable when the provider re-raised the same approval on a
      // live generation (the projection showed it pending again).
      expect(old?.state).toBe("pending");
    }
    const final = await settle(invoke, c, second);
    log("crash case settled", {
      state: final.state,
      turnOutcome: final.turnOutcome ?? null,
      source: sourceState(c),
    });
    if (deadAnswer !== "applied") expect(sourceState(c)).toBe("original");
  } finally {
    for (const target of created) {
      await invoke("stop_environment", { environmentId: target.environmentId }).catch(
        () => undefined,
      );
      await invoke("delete_environment", { environmentId: target.environmentId }).catch(
        () => undefined,
      );
    }
  }
});
