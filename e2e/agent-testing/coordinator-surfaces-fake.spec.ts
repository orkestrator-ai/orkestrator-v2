/**
 * Two coordinator worker surfaces (coordinator.md, "Worker surfaces") on a
 * real `dev:test --fixture --fixture-environments local,container` profile,
 * driven by a Pi coordinator on a scripted loopback model and checked in the
 * browser client. Run it with `mise run test:agent:coordinator:surfaces-fake`,
 * which starts a disposable credential-free profile that offers only Pi, runs
 * this file and resets the profile.
 *
 * Opt-in: skipped unless `ORKESTRATOR_AGENT_TEST_COORDINATOR_SURFACES_FAKE=1`.
 * Nothing is billed and nothing logs in: every model call the profile's own
 * Pi bridge makes goes to `coordinator-surfaces-fake-model.ts` on loopback,
 * which the profile's isolated Pi `models.json` names (never `~/.pi`). The
 * real backend, coordinator, Control MCP, Pi bridge and SDK, node action
 * requests, approval dialog, agent mail, preview registry and browser tab
 * all run.
 *
 * 1. `request_root_changes` (task 1). The fixture checkout gets one modified,
 *    one deleted and one new file. The coordinator asks for the modified and
 *    new ones three times; the spec answers in the approval dialog: reject
 *    for the local worker (nothing changes there), approve for the local
 *    worker after also ticking the deleted file (all three land in its
 *    worktree), approve for the container worker (all three land in its
 *    `/workspace`, applied with `docker exec … git apply`). The checkout's
 *    own `git status` and HEAD never change, and each outcome wakes the
 *    coordinator exactly once, with its state.
 * 2. `open_worker_browser` on the container worker (task 3). A server inside
 *    the container and a decoy on the host's loopback listen on the same
 *    port; the container's is registered as a `container` preview service.
 *    The coordinator opens `http://localhost:<port>/surfaces` in the worker;
 *    the browser client's tab resolves the `agent-link` intent and binds
 *    itself to the container's service, never the host decoy.
 *
 * What it cannot prove: the fake calls each tool because the prompt names it,
 * so whether a real model chooses these tools needs the billed run in the
 * manual-test checklist (7568). The container publishes only its bridge
 * ports, so its service is reached through the backend's in-container relay
 * (on by default), whose TCP readiness probe must reach the container's
 * listener. The browser client embeds a preview only through a host port or a
 * published private origin, and a relayed service has neither on a fresh
 * profile, so the page's own text is checked only when this client embeds
 * it; the desktop-app half is in 7568.
 *
 * Writes a content-free summary to
 * `output/agent-testing/<run>/coordinator-surfaces-fake/pi-surfaces.json`.
 */
import { expect, test, type Page } from "./browser-test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  coordinatorMainConversation,
  coordinatorRuntimeId,
  type CoordinatorSnapshot,
} from "@orkestrator/protocol/coordinator";
import { snapshotFixtureFiles } from "./codex-fixture-files";
import type { WakeFacts } from "./coordinator-surfaces-fake-model-script";
import {
  authenticatedInvoke,
  containerWorkspace,
  hostWorkspace,
  profileStatus,
  repositoryRoot,
  sidebarNavigator,
  type Environment,
  type Invoke,
  type Project,
  type Status,
  type Workspace,
} from "./slash-command-live-support";

const LIVE = process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_SURFACES_FAKE === "1";
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "qa-coordinator-surfaces-fake";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const outputDirectory = path.join(
  repositoryRoot,
  "output",
  "agent-testing",
  runId,
  "coordinator-surfaces-fake",
);

const PI_PROVIDER = "surfaces-fake";
const PI_MODEL = "surfaces-1";
const MODEL_REF = `${PI_PROVIDER}/${PI_MODEL}`;
const TURN_TIMEOUT_MS = 120_000;
/** How long a settled outcome is watched for a second wake. */
const QUIET_MS = 8_000;

/** The checkout changes the case makes, by role. */
const NEW_FILE = "surfaces-0142/new-notes.txt";
const NEW_BODY = "uncommitted work started in the checkout\n";
const MODIFIED_SUFFIX = "\n<!-- surfaces-0142: an uncommitted edit -->\n";

type Calls = {
  completions: number;
  refused: number;
  toolCalls: Record<string, number>;
  toolResults: Record<string, { ok: number; failed: number }>;
  wakes: WakeFacts[];
};
type Summary = {
  version: 1;
  verdict: "passed" | "failed";
  startedAt: string;
  durationMs?: number;
  reason?: string;
  rootChanges?: Record<string, unknown>;
  workerBrowser?: Record<string, unknown>;
  fakeModel?: Calls | null;
};

test.describe.configure({ mode: "serial" });
// Backend calls carry the disposable profile's token; keep it out of artifacts.
test.use({ trace: "off", video: "off" });

async function startFakeModel(): Promise<{ origin: string; child: ChildProcess }> {
  const child = spawn(
    "bun",
    [path.join(import.meta.dirname, "coordinator-surfaces-fake-model.ts")],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const origin = await new Promise<string>((resolve, reject) => {
    createInterface({ input: child.stdout! }).once("line", resolve);
    child.once("exit", () => reject(new Error("the fake model exited before it listened")));
  });
  return { origin, child };
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

async function calls(origin: string): Promise<Calls> {
  return (await (await fetch(`${origin}/__calls`)).json()) as Calls;
}

/**
 * Names the fake provider in the profile's isolated Pi `models.json` and makes
 * it Pi's saved default there (never `~/.pi`); returns the restore. The key is
 * a literal placeholder.
 */
function pointPiAt(status: Status, baseUrl: string): () => void {
  const root = path.resolve(status.dataDir!);
  const directory = path.join(root, "agent-credentials", "home", ".pi", "agent");
  const models = path.join(directory, "models.json");
  const settings = path.join(directory, "settings.json");
  for (const file of [models, settings]) {
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error("Pi settings escape the profile");
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const restore = snapshotFixtureFiles([models, settings]);
  const read = (file: string) =>
    existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
  const existing = read(models) as { providers?: Record<string, unknown> };
  writeFileSync(
    models,
    `${JSON.stringify(
      {
        ...existing,
        providers: {
          ...existing.providers,
          [PI_PROVIDER]: {
            name: "Coordinator surfaces fake",
            baseUrl,
            api: "openai-completions",
            apiKey: "surfaces-fake-not-a-key",
            compat: {
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsReasoningEffort: false,
              supportsUsageInStreaming: true,
              maxTokensField: "max_tokens",
            },
            models: [
              {
                id: PI_MODEL,
                name: "Surfaces 1",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                // Large, so the coordinator context never triggers auto-compaction.
                contextWindow: 1_000_000,
                maxTokens: 4_096,
              },
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    settings,
    `${JSON.stringify({ ...read(settings), defaultProvider: PI_PROVIDER, defaultModel: PI_MODEL }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return restore;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.status !== 0) throw new Error(`git ${args[0]} exited ${result.status}`);
  return result.stdout;
}

function containerGit(containerId: string, args: string[]): string {
  const result = spawnSync(
    "docker",
    ["exec", "--user", "node", "--workdir", "/workspace", containerId, "git", ...args],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`docker exec git ${args[0]} exited ${result.status}`);
  return result.stdout;
}

/** Two tracked files of the fixture to modify and delete, and their bodies. */
function pickTrackedFiles(checkout: string): { modified: string; deleted: string } {
  const tracked = git(checkout, ["ls-files", "-z"])
    .split("\0")
    .filter((file) => file && !file.startsWith(".") && !file.includes("/"));
  const modified = tracked.find((file) => file.endsWith(".md")) ?? tracked[0];
  const deleted = tracked.find(
    (file) => file !== modified && !["package.json", "bun.lock"].includes(file),
  );
  if (!modified || !deleted) throw new Error("the fixture has too few tracked files");
  return { modified, deleted };
}

async function fixtureEnvironment(
  invoke: Invoke,
  projectId: string,
  name: string,
): Promise<Environment> {
  const environments = await invoke<Environment[]>("get_environments", { projectId });
  const match = environments.find((environment) => environment.name === name);
  if (!match) throw new Error(`no fixture environment named ${name}`);
  return match;
}

type Coordinator = {
  invoke: Invoke;
  identity: { environmentId: string; agent: "pi"; logicalSessionKey: string };
  origin: string;
};

/**
 * One scripted coordinator turn: the prompt names the tool and its input.
 * Settles once the fake has seen the tool's result and the turn is idle.
 */
async function scriptedCall(
  coordinator: Coordinator,
  tool: "request_root_changes" | "open_worker_browser",
  input: Record<string, unknown>,
): Promise<void> {
  const before = (await calls(coordinator.origin)).toolResults[tool] ?? { ok: 0, failed: 0 };
  await coordinator.invoke("dispatch_native_agent_intent", {
    ...coordinator.identity,
    prompt: `Run the scripted step below.\nsurfaces-fake: ${tool} ${JSON.stringify(input)}`,
    requestId: `surfaces-${tool}-${String(input.requestId)}`,
    mode: "build",
  });
  await expect
    .poll(
      async () => {
        const after = (await calls(coordinator.origin)).toolResults[tool] ?? { ok: 0, failed: 0 };
        return { ok: after.ok - before.ok, failed: after.failed - before.failed };
      },
      { timeout: TURN_TIMEOUT_MS, message: `the coordinator's ${tool} call` },
    )
    .toEqual({ ok: 1, failed: 0 });
  await expect
    .poll(
      async () =>
        (
          await coordinator.invoke<{ turn: { phase: string } } | null>(
            "get_native_agent_projection",
            { ...coordinator.identity, messageLimit: 5 },
          )
        )?.turn.phase,
      { timeout: TURN_TIMEOUT_MS, message: "the coordinator turn to settle" },
    )
    .toBe("idle");
}

/** Waits for the wakes to reach `expected`, then checks no extra one follows. */
async function expectWakes(origin: string, expected: WakeFacts["state"][]): Promise<void> {
  const states = async () =>
    (await calls(origin)).wakes.filter((wake) => wake.rootChanges).map((wake) => wake.state);
  await expect
    .poll(states, { timeout: TURN_TIMEOUT_MS, message: "the root-changes wakes" })
    .toEqual(expected);
  await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
  expect(await states(), "a root-changes outcome woke the coordinator more than once").toEqual(
    expected,
  );
}

function rootChangesDialog(page: Page, worker: string) {
  return page.getByTestId("root-changes-request").filter({ hasText: `“${worker}”` });
}

function findTab(node: unknown, tabId: string): Record<string, unknown> | undefined {
  if (!node || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findTab(item, tabId);
      if (found) return found;
    }
    return undefined;
  }
  const record = node as Record<string, unknown>;
  if (record.id === tabId && typeof record.type === "string") return record;
  for (const value of Object.values(record)) {
    const found = findTab(value, tabId);
    if (found) return found;
  }
  return undefined;
}

function writeSummary(summary: Summary): void {
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(
    path.join(outputDirectory, "pi-surfaces.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
}

test.describe("coordinator worker surfaces on a fake model", () => {
  test.skip(
    !LIVE,
    "opt-in: set ORKESTRATOR_AGENT_TEST_COORDINATOR_SURFACES_FAKE=1 (fake model, no billing)",
  );
  test.setTimeout(20 * 60_000);

  test("root changes reach local and container workers only on approval, and the worker browser opens the container's service", async ({
    page,
  }) => {
    page.setDefaultTimeout(30_000);
    const status = profileStatus(profile);
    expect(status.status, `profile "${profile}" is not running`).toBe("ready");
    expect(status.dataDir, "dev:status reported no data directory").toBeTruthy();
    expect(status.testProject, "the profile has no fixture project").toBeTruthy();
    const invoke = await authenticatedInvoke(page, status, profile);
    const fixture = (await invoke<Project[]>("get_projects")).find(
      (project) => project.localPath === status.testProject,
    );
    expect(fixture, "the profile has no seeded fixture project").toBeTruthy();
    const projectId = fixture!.id;
    const checkout = status.testProject!;
    const local = await fixtureEnvironment(invoke, projectId, "fixture-local");
    const container = await fixtureEnvironment(invoke, projectId, "fixture-container");
    expect(local.worktreePath, "the local fixture worker has no worktree").toBeTruthy();
    expect(container.containerId, "the container fixture worker is not running").toBeTruthy();

    const summary: Summary = { version: 1, verdict: "failed", startedAt: new Date().toISOString() };
    const started = Date.now();
    const model = await startFakeModel();
    const cleanup: Array<() => Promise<unknown> | unknown> = [];
    try {
      const restorePi = pointPiAt(status, `${model.origin}/v1`);
      cleanup.push(restorePi);

      const config = await invoke<{ global: Record<string, unknown> }>("get_config");
      const previous = {
        coordinatorProviderTiers: config.global.coordinatorProviderTiers,
        agentSettings: config.global.agentSettings,
      };
      const agentSettings = (config.global.agentSettings ?? {}) as Record<string, unknown>;
      const platforms = (agentSettings.platforms ?? {}) as Record<string, unknown>;
      await invoke("update_global_config", {
        global: {
          ...config.global,
          coordinatorProviderTiers: "provider-configured",
          agentSettings: {
            ...agentSettings,
            platforms: { ...platforms, pi: { mode: "native", model: MODEL_REF } },
          },
        },
      });
      cleanup.push(async () => {
        const current = await invoke<{ global: Record<string, unknown> }>("get_config");
        await invoke("update_global_config", { global: { ...current.global, ...previous } });
      });
      // The fixture made both workers, not this coordinator. `request_root_changes`
      // is a request the user approves, but `open_worker_browser` sends work, so
      // it needs the project's "use environments it did not create" setting.
      const otherEnvironments = (
        config as { repositories?: Record<string, { coordinatorOtherEnvironments?: boolean }> }
      ).repositories?.[projectId]?.coordinatorOtherEnvironments;
      await invoke("patch_repository_settings", {
        projectId,
        updates: { coordinatorOtherEnvironments: true },
      });
      cleanup.push(() =>
        invoke(
          "patch_repository_settings",
          otherEnvironments === undefined
            ? { projectId, unset: ["coordinatorOtherEnvironments"] }
            : { projectId, updates: { coordinatorOtherEnvironments: otherEnvironments } },
        ),
      );

      // A fresh main conversation on Pi.
      let snapshot = await invoke<CoordinatorSnapshot>("ensure_project_coordinator", {
        projectId,
      });
      const earlier = coordinatorMainConversation(snapshot.workspace);
      if (earlier?.agent) {
        snapshot = await invoke<CoordinatorSnapshot>("close_coordinator_conversation", {
          projectId,
          conversationId: earlier.id,
        });
      }
      if (!coordinatorMainConversation(snapshot.workspace)) {
        snapshot = await invoke<CoordinatorSnapshot>("create_coordinator_conversation", {
          projectId,
        });
      }
      const conversation = coordinatorMainConversation(snapshot.workspace)!;
      expect(snapshot.providerAvailability.pi?.available, "Pi is not offered to Coordinator").toBe(
        true,
      );
      expect(snapshot.controlMcp.running, "Control MCP is not running").toBe(true);
      snapshot = await invoke<CoordinatorSnapshot>("assign_coordinator_conversation_agent", {
        projectId,
        conversationId: conversation.id,
        agent: "pi",
      });
      cleanup.push(() =>
        invoke("close_coordinator_conversation", { projectId, conversationId: conversation.id }),
      );
      const identity = {
        environmentId: coordinatorRuntimeId(snapshot.workspace.id, conversation.id),
        agent: "pi" as const,
        logicalSessionKey: conversation.logicalSessionKey,
      };
      await invoke("ensure_native_agent_session", { ...identity, model: MODEL_REF });
      const coordinator: Coordinator = { invoke, identity, origin: model.origin };
      // Request receipts belong to the coordinator, not the conversation, so
      // a rerun on the same profile needs its own request IDs.
      const run = Date.now().toString(36);

      // ---- 1. request_root_changes ---------------------------------------
      const { modified, deleted } = pickTrackedFiles(checkout);
      const checkoutFiles = hostWorkspace(checkout);
      const original = {
        modified: checkoutFiles.read(modified)!,
        deleted: checkoutFiles.read(deleted)!,
      };
      const headBefore = git(checkout, ["rev-parse", "HEAD"]).trim();
      expect(git(checkout, ["status", "--porcelain"]), "the fixture checkout is not clean").toBe(
        "",
      );
      checkoutFiles.write(modified, `${original.modified}${MODIFIED_SUFFIX}`);
      checkoutFiles.remove(deleted);
      checkoutFiles.write(NEW_FILE, NEW_BODY);
      cleanup.push(() => {
        checkoutFiles.write(modified, original.modified);
        checkoutFiles.write(deleted, original.deleted);
        rmSync(path.join(checkout, path.dirname(NEW_FILE)), { recursive: true, force: true });
      });
      const dirty = git(checkout, ["status", "--porcelain", "--untracked-files=all"]);
      const workers: Array<{ name: string; files: Workspace; status: () => string }> = [
        {
          name: local.name,
          files: hostWorkspace(local.worktreePath!),
          status: () =>
            git(local.worktreePath!, ["status", "--porcelain", "--untracked-files=all"]),
        },
        {
          name: container.name,
          files: containerWorkspace(container.containerId!),
          status: () =>
            containerGit(container.containerId!, [
              "status",
              "--porcelain",
              "--untracked-files=all",
            ]),
        },
      ];
      for (const worker of workers) {
        expect(worker.status(), `${worker.name} is not clean before the case`).toBe("");
        cleanup.push(() => {
          worker.files.write(modified, original.modified);
          worker.files.write(deleted, original.deleted);
          worker.files.remove(NEW_FILE);
        });
      }
      const ask = (requestId: string, environmentId: string) =>
        scriptedCall(coordinator, "request_root_changes", {
          requestId,
          environmentId,
          files: [modified, NEW_FILE],
          reason: "Continue the uncommitted work in a worker.",
        });
      const checkoutUnchanged = () => {
        expect(git(checkout, ["status", "--porcelain", "--untracked-files=all"])).toBe(dirty);
        expect(git(checkout, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);
      };

      // Reject: the local worker gets nothing.
      await ask(`surfaces-root-reject-${run}`, local.id);
      const rejectDialog = rootChangesDialog(page, local.name);
      await expect(rejectDialog).toBeVisible({ timeout: 60_000 });
      // The coordinator's suggestion starts ticked; the deleted file does not.
      await expect(rejectDialog.getByRole("checkbox", { name: modified })).toBeChecked();
      await expect(rejectDialog.getByRole("checkbox", { name: NEW_FILE })).toBeChecked();
      await expect(rejectDialog.getByRole("checkbox", { name: deleted })).not.toBeChecked();
      await page.screenshot({ path: path.join(outputDirectory, "root-changes-dialog.png") });
      await rejectDialog.getByRole("button", { name: "Reject", exact: true }).click();
      await expect(rejectDialog).toBeHidden();
      await expectWakes(model.origin, ["rejected"]);
      expect(workers[0]!.status(), "a rejected request changed the worker").toBe("");
      checkoutUnchanged();

      // Approve for the local worker, with the deleted file ticked as well.
      await ask(`surfaces-root-local-${run}`, local.id);
      const localDialog = rootChangesDialog(page, local.name);
      await expect(localDialog).toBeVisible({ timeout: 60_000 });
      await localDialog.getByRole("checkbox", { name: deleted }).check();
      await localDialog.getByRole("button", { name: "Apply 3 files" }).click();
      await expect(localDialog).toBeHidden({ timeout: 60_000 });
      await expectWakes(model.origin, ["rejected", "executed"]);
      const landed = (worker: (typeof workers)[number]) => {
        expect(worker.files.read(modified), `${worker.name}: the modified file`).toBe(
          `${original.modified}${MODIFIED_SUFFIX}`,
        );
        expect(worker.files.read(NEW_FILE), `${worker.name}: the new file`).toBe(NEW_BODY);
        expect(worker.files.read(deleted), `${worker.name}: the deleted file`).toBeUndefined();
      };
      landed(workers[0]!);
      checkoutUnchanged();

      // Approve for the container worker, applied inside the container.
      await ask(`surfaces-root-container-${run}`, container.id);
      const containerDialog = rootChangesDialog(page, container.name);
      await expect(containerDialog).toBeVisible({ timeout: 60_000 });
      await containerDialog.getByRole("checkbox", { name: deleted }).check();
      await containerDialog.getByRole("button", { name: "Apply 3 files" }).click();
      await expect(containerDialog).toBeHidden({ timeout: 60_000 });
      await expectWakes(model.origin, ["rejected", "executed", "executed"]);
      landed(workers[1]!);
      checkoutUnchanged();
      summary.rootChanges = {
        reject: { workerUnchanged: true, wakes: 1 },
        local: { applied: 3, wakes: 1 },
        container: { applied: 3, wakes: 1 },
        checkoutUnchanged: true,
      };

      // ---- 2. open_worker_browser on the container worker -----------------
      const markers = { container: "surfaces-0142-container", host: "surfaces-0142-host" };
      const decoy = http.createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(`<h1>${markers.host}</h1>`);
      });
      await new Promise<void>((resolve) => decoy.listen(0, "127.0.0.1", resolve));
      cleanup.push(() => new Promise((resolve) => decoy.close(() => resolve(undefined))));
      const port = (decoy.address() as AddressInfo).port;
      const pidFile = "/tmp/surfaces-0142-server.pid";
      const serve = `Bun.serve({ hostname: "0.0.0.0", port: ${port}, fetch: () => new Response("<h1>${markers.container}</h1>", { headers: { "content-type": "text/html" } }) })`;
      const server = spawnSync(
        "docker",
        [
          "exec",
          "-d",
          "--user",
          "node",
          container.containerId!,
          "sh",
          "-c",
          `echo $$ > ${pidFile}; exec bun -e '${serve}'`,
        ],
        { encoding: "utf8" },
      );
      expect(server.status, "the container server did not start").toBe(0);
      cleanup.push(() =>
        spawnSync("docker", [
          "exec",
          "--user",
          "node",
          container.containerId!,
          "sh",
          "-c",
          `[ -s ${pidFile} ] && kill "$(cat ${pidFile})"; rm -f ${pidFile}`,
        ]),
      );
      await expect
        .poll(
          () =>
            spawnSync(
              "docker",
              [
                "exec",
                "--user",
                "node",
                container.containerId!,
                "sh",
                "-c",
                `curl -fsS http://127.0.0.1:${port}/`,
              ],
              { encoding: "utf8" },
            ).stdout,
          { timeout: 30_000, message: "the container server to answer" },
        )
        .toContain(markers.container);

      const service = await invoke<{ definition: { serviceId: string; revision?: number } }>(
        "register_preview_service",
        {
          service: {
            environmentId: container.id,
            label: "surfaces-0142",
            targetKind: "container",
            applicationPort: port,
            addressFamily: "ipv4",
            readinessPath: "/",
          },
          operationId: `surfaces-0142-register-${port}`,
        },
      );
      const serviceId = service.definition.serviceId;
      cleanup.push(() =>
        invoke("remove_preview_service", {
          serviceId,
          operationId: `surfaces-0142-remove-${serviceId}`,
        }),
      );

      const address = `http://localhost:${port}/surfaces`;
      // Per run, so a rerun on the same profile finds its own tab.
      const title = `Surfaces preview ${run}`;
      const layoutTab = async () => {
        const layout = await invoke<unknown>("get_pane_layout", { environmentId: container.id });
        const tabs: Record<string, unknown>[] = [];
        const visit = (node: unknown) => {
          if (!node || typeof node !== "object") return;
          if (Array.isArray(node)) return node.forEach(visit);
          const record = node as Record<string, unknown>;
          if (
            record.type === "browser" &&
            typeof record.id === "string" &&
            record.id.startsWith("browser-coordinator-")
          )
            tabs.push(record);
          Object.values(record).forEach(visit);
        };
        visit(layout);
        return tabs;
      };
      const tabsBefore = new Set((await layoutTab()).map((tab) => tab.id));
      await scriptedCall(coordinator, "open_worker_browser", {
        requestId: `surfaces-browser-container-${run}`,
        environmentId: container.id,
        url: address,
        title,
      });
      const opened = (await layoutTab()).filter((tab) => !tabsBefore.has(tab.id));
      expect(opened, "open_worker_browser added one browser tab").toHaveLength(1);
      const tabId = opened[0]!.id as string;
      const urlOf = async () =>
        String(
          (
            (findTab(await invoke("get_pane_layout", { environmentId: container.id }), tabId)
              ?.browserData ?? {}) as { url?: unknown }
          ).url ?? "",
        );
      const intent = await urlOf();
      expect(intent).toContain("orkestrator-preview://intent/");
      expect(intent).toContain("/agent-link?url=");

      // The same resolution the tab makes: the container's service only.
      const resolution = await invoke<{
        kind: string;
        service?: { definition: { serviceId: string; targetKind: string } };
      }>("resolve_preview_target", {
        intent: { url: address, source: "agent-link", environmentId: container.id },
      });
      expect(resolution.kind).toBe("service");
      expect(resolution.service?.definition).toMatchObject({ serviceId, targetKind: "container" });

      // The browser client opens the tab and binds it to that service.
      await page.reload();
      await sidebarNavigator(page, fixture!.name)(container.name);
      await page.getByRole("tab", { name: title }).click();
      await expect
        .poll(urlOf, { timeout: 60_000, message: "the tab to bind to the container's service" })
        .toMatch(new RegExp(`^orkestrator-preview://service/[^/]+/[^/]+/${serviceId}/surfaces$`));
      // The bound service reaches the container's server: the container
      // publishes only its bridge ports, so the backend reaches this one only
      // through its in-container relay, which cannot see the host decoy. The
      // prober checks a relayed target's TCP layer only (HTTP is skipped);
      // `probe_preview_service` is the picker's explicit check.
      const endpoint = async () => {
        const probed = await invoke<{
          endpoint: { transportKind: string | null; readiness: { tcp: { state: string } } };
        }>("probe_preview_service", { serviceId });
        return {
          transportKind: probed.endpoint.transportKind,
          tcp: probed.endpoint.readiness.tcp.state,
        };
      };
      await expect
        .poll(endpoint, { timeout: 60_000, message: "the container service to answer its probe" })
        .toEqual({ transportKind: "container-relay", tcp: "ok" });
      const iframe = page.locator('iframe[title="Backend browser preview"]');
      const embedded = (await iframe.count()) > 0;
      if (embedded) {
        const frame = page.frameLocator('iframe[title="Backend browser preview"]');
        await expect(frame.locator("h1")).toHaveText(markers.container, { timeout: 60_000 });
      } else {
        await expect(page.getByRole("heading", { name: "surfaces-0142" })).toBeVisible();
      }
      await page.screenshot({ path: path.join(outputDirectory, "worker-browser-container.png") });
      summary.workerBrowser = {
        intentStored: true,
        resolvedTargetKind: "container",
        transportKind: "container-relay",
        relayTcp: "ok",
        tabBound: true,
        embeddedPageChecked: embedded,
      };

      const fake = await calls(model.origin);
      expect(fake.refused).toBe(0);
      expect(fake.toolResults).toEqual({
        request_root_changes: { ok: 3, failed: 0 },
        open_worker_browser: { ok: 1, failed: 0 },
      });
      summary.verdict = "passed";
    } catch (error) {
      summary.reason ??= error instanceof Error ? error.message.slice(0, 2_000) : String(error);
      throw error;
    } finally {
      let failures = 0;
      for (const step of cleanup.toReversed()) {
        try {
          await step();
        } catch {
          failures += 1;
        }
      }
      if (failures > 0) {
        summary.verdict = "failed";
        summary.reason = `${summary.reason ? `${summary.reason}; ` : ""}${failures} cleanup steps failed`;
      }
      summary.fakeModel = await calls(model.origin).catch(() => null);
      summary.durationMs = Date.now() - started;
      writeSummary(summary);
      await stopChild(model.child);
    }
  });
});
