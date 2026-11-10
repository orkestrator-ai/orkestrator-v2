/**
 * Fleet ticket sync over two real backends (to-do 3800 task 1): two running
 * `dev:test` profiles on this machine, the second attached to the first as a
 * leaf, over the real gateway, event stream and node link, with a real
 * disconnect (the leaf profile stopped and started again).
 *
 * Covered, in order: a leaf ticket made before sync shared with Share; a
 * command-node ticket reaching the leaf and a leaf edit coming back without a
 * manual sync; an image read in each direction; a conflict made while the
 * link is disabled, with its comment, the sync line's count, the conflict
 * list and dismissal; edits that wait while the leaf is stopped; a
 * coordinator build refused while it is stopped and the one reconnect
 * message (task 8); a build started on the leaf with `nodeId` for a ticket of
 * this board, linked there and then cancelled. Screenshots of both boards go
 * to `output/visual-previews/fleet-ticket-sync-*.png`.
 *
 * Nothing is billed and nothing logs in: the profiles run without agent
 * credentials, the only agent is Pi, and the leaf's Pi `models.json` names a
 * loopback fake model (`auto-pipeline-fake-model.ts`). Gateway tokens are read
 * from each profile's auth file into memory only (`scope-proof-support.ts`).
 *
 * Needs two fresh profiles (reset first); the spec renames them, gives both
 * fixture projects one repository identity and attaches the leaf:
 *
 * ```bash
 * FLAGS="--fixture --headless --no-agent-credentials --agent-platforms pi"
 * env -u DISPLAY -u WAYLAND_DISPLAY ORKESTRATOR_HOST_REACHABILITY_CHECK=off \
 *   mise run dev:test --profile fts-cmd $FLAGS    # own terminal
 * env -u DISPLAY -u WAYLAND_DISPLAY ORKESTRATOR_HOST_REACHABILITY_CHECK=off \
 *   mise run dev:test --profile fts-leaf $FLAGS   # own terminal
 * ORKESTRATOR_AGENT_TEST_FLEET_TICKET_SYNC=1 \
 * ORKESTRATOR_AGENT_TEST_PROFILE=fts-cmd ORKESTRATOR_AGENT_TEST_LEAF_PROFILE=fts-leaf \
 *   mise run test:logged -- --name fleet-ticket-sync -- \
 *   bunx playwright test --config e2e/agent-testing/playwright.fleet-ticket-sync.config.ts
 * mise run dev:stop --profile fts-leaf && mise run dev:reset --profile fts-leaf
 * mise run dev:stop --profile fts-cmd && mise run dev:reset --profile fts-cmd
 * ```
 *
 * The spec restarts the leaf itself with the same flags
 * (`ORKESTRATOR_AGENT_TEST_LEAF_START_ARGS` overrides them); that launcher
 * keeps running afterwards and `dev:stop` stops it. Evidence (ids, timings,
 * counts; no tokens, prompts or file contents) is written to
 * `output/agent-testing/<run>/fleet-ticket-sync/evidence.json`.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import { expect, test, type Page } from "./browser-test";
import {
  attachLeaf,
  commandProfile,
  gateway,
  leafProfile,
  loginUrl,
  profileStatus,
  repositoryRoot,
  runId,
  type Gateway,
} from "./scope-proof-support";

const LIVE = process.env.ORKESTRATOR_AGENT_TEST_FLEET_TICKET_SYNC === "1";
const LEAF_START_ARGS = (
  process.env.ORKESTRATOR_AGENT_TEST_LEAF_START_ARGS ??
  "--fixture --headless --no-agent-credentials --agent-platforms pi"
)
  .split(/\s+/)
  .filter(Boolean);
const SHARED_GIT_URL = "https://example.invalid/orkestrator-qa/fleet-ticket-sync-fixture.git";
const COMMAND_NAME = "QA command";
const LEAF_NAME = "QA leaf";
const PI_PROVIDER = "fleet-fake";
const PI_MODEL = "fleet-1";
const EVIDENCE_DIR = path.join(
  repositoryRoot,
  "output",
  "agent-testing",
  runId,
  "fleet-ticket-sync",
);
const PREVIEWS = path.join(repositoryRoot, "output", "visual-previews");
/** An 8×8 PNG, generated once; the backend stores it as WebP. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4ESCHFTEMLQkAcwpNgYcsJIMAAAAASUVORK5CYII=";

type Project = { id: string; localPath?: string; gitUrl?: string };
type Ticket = {
  id: string;
  title: string;
  status: string;
  buildPipelineId?: string;
  comments?: Array<{ text: string }>;
  images?: Array<{ id: string; filename: string }>;
  sync?: {
    replica?: { controllerId: string };
    work?: { nodeId: string; buildPipelineId?: string };
  };
};
type SyncStatus = {
  nodes: Array<{ nodeId: string; state: string; pending?: number }>;
  conflicts: Array<{ id: string; ticketId?: string; field?: string }>;
  conflictCount?: number;
};

const evidence: Record<string, unknown> = { runId, startedAt: new Date().toISOString() };

function record(key: string, value: unknown): void {
  evidence[key] = value;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(path.join(EVIDENCE_DIR, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
}

async function waitFor<T>(
  what: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 60_000,
): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  let last: T | undefined;
  let error: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await read();
      if (done(last)) return { value: last, ms: Date.now() - started };
    } catch (caught) {
      error = caught;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `${what} did not happen within ${timeoutMs} ms${error instanceof Error ? ` (last error: ${error.message})` : ""}`,
  );
}

function mise(args: string[]): void {
  const result = spawnSync("mise", ["run", ...args], { cwd: repositoryRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`mise run ${args.join(" ")} failed`);
}

async function fixtureProject(node: Gateway): Promise<Project> {
  const status = profileStatus(node.profile);
  const projects = await node.invoke<Project[]>("get_projects");
  const project = projects.find((entry) => entry.localPath === status.testProject);
  if (!project) throw new Error(`${node.profile} has no fixture project (start it with --fixture)`);
  return project;
}

async function rename(node: Gateway, displayName: string): Promise<void> {
  const profile = await node.invoke<{ revision: number }>("get_backend_profile");
  await node.invoke("update_backend_profile", {
    expectedRevision: profile.revision,
    displayName,
  });
}

const tickets = (node: Gateway, projectId: string) =>
  node.invoke<Ticket[]>("get_kanban_tasks", { projectId });
const ticket = async (node: Gateway, projectId: string, id: string) =>
  (await tickets(node, projectId)).find((entry) => entry.id === id);

/** The fake model on loopback; its own handle stops it. */
async function startFakeModel(): Promise<{ origin: string; child: ChildProcess }> {
  const child = spawn("bun", [path.join(import.meta.dirname, "auto-pipeline-fake-model.ts")], {
    stdio: ["ignore", "pipe", "inherit"],
  });
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

/** Names the fake in the profile's own isolated Pi `models.json` (never `~/.pi`). */
function pointPiAt(profile: string, baseUrl: string): void {
  const status = profileStatus(profile) as ReturnType<typeof profileStatus> & { dataDir?: string };
  const root = path.resolve(status.dataDir!);
  const file = path.join(root, "agent-credentials", "home", ".pi", "agent", "models.json");
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error("models.json escapes the profile");
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const existing = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as { providers?: Record<string, unknown> })
    : {};
  const config = {
    ...existing,
    providers: {
      ...existing.providers,
      [PI_PROVIDER]: {
        name: "Fleet ticket sync fake",
        baseUrl,
        api: "openai-completions",
        apiKey: "fleet-fake-not-a-key",
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
            name: "Fleet 1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1_000_000,
            maxTokens: 4_096,
          },
        ],
      },
    },
  };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/** Starts the leaf profile again with its flags, detached; `dev:stop` ends it. */
async function restartLeaf(): Promise<number> {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const log = openSync(path.join(EVIDENCE_DIR, "leaf-restart.log"), "a");
  const env: Record<string, string | undefined> = {
    ...process.env,
    ORKESTRATOR_HOST_REACHABILITY_CHECK: "off",
  };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  const child = spawn("mise", ["run", "dev:test", "--profile", leafProfile, ...LEAF_START_ARGS], {
    cwd: repositoryRoot,
    detached: true,
    stdio: ["ignore", log, log],
    env,
  });
  child.unref();
  closeSync(log);
  const { ms } = await waitFor(
    "the leaf profile to be ready again",
    async () => {
      try {
        return profileStatus(leafProfile).status;
      } catch {
        return "starting";
      }
    },
    (status) => status === "ready",
    10 * 60_000,
  );
  return ms;
}

async function openBoard(page: Page, profile: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(loginUrl(profile), { waitUntil: "domcontentloaded" });
  const projectRow = page.getByRole("button", { name: /^origin/ }).first();
  await expect(projectRow).toBeVisible({ timeout: 60_000 });
  // A fresh profile may open a startup notice; none of them matter here.
  await page.keyboard.press("Escape");
  await projectRow.click();
  await page.getByRole("tab", { name: "Kanban", exact: true }).click();
  await expect(page.getByTestId("ticket-sync-strip")).toBeVisible({ timeout: 30_000 });
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(PREVIEWS, { recursive: true });
  await page.screenshot({ path: path.join(PREVIEWS, `fleet-ticket-sync-${name}.png`) });
}

test.describe.configure({ mode: "serial" });

test.describe("fleet ticket sync over two dev:test profiles", () => {
  test.skip(
    !LIVE || !commandProfile || !leafProfile,
    "opt-in: set ORKESTRATOR_AGENT_TEST_FLEET_TICKET_SYNC=1, ORKESTRATOR_AGENT_TEST_PROFILE and ORKESTRATOR_AGENT_TEST_LEAF_PROFILE",
  );

  test("sync, share, images, conflicts, disconnect, reconnect wake and a remote build", async ({
    page,
  }) => {
    test.setTimeout(30 * 60_000);
    const command = gateway(commandProfile);
    let leaf = gateway(leafProfile);
    const commandProject = await fixtureProject(command);
    const leafProject = await fixtureProject(leaf);
    const leafNodeId = (await leaf.invoke<{ nodeId: string; mode: string }>("get_node_status"))
      .nodeId;
    const commandNodeId = (await command.invoke<{ nodeId: string }>("get_node_status")).nodeId;
    // One loopback fake serves every Pi turn on both machines: the coordinator's
    // wake on the command node and the build on the leaf. Named before any Pi
    // bridge starts, so each reads it.
    const model = await startFakeModel();
    try {
      for (const [profile, node, project] of [
        [commandProfile, command, commandProject],
        [leafProfile, leaf, leafProject],
      ] as const) {
        pointPiAt(profile, `${model.origin}/v1`);
        await node.invoke("patch_repository_settings", {
          projectId: project.id,
          updates: {
            agentSettings: {
              defaultAgent: "pi",
              platforms: { pi: { mode: "native", model: `${PI_PROVIDER}/${PI_MODEL}` } },
              multiReview: { reviewerCount: 1 },
            },
          },
        });
      }

      await test.step("setup: two names, one repository, an older leaf ticket, then attach", async () => {
        const leafStatus = await leaf.invoke<{ mode: string }>("get_node_status");
        expect(leafStatus.mode, "the leaf profile must be fresh (dev:reset it)").toBe("standalone");
        await rename(command, COMMAND_NAME);
        await rename(leaf, LEAF_NAME);
        for (const [node, project] of [
          [command, commandProject],
          [leaf, leafProject],
        ] as const) {
          await node.invoke("update_project", {
            projectId: project.id,
            updates: { gitUrl: SHARED_GIT_URL },
          });
        }
        const older = await leaf.invoke<Ticket>("add_kanban_task", {
          projectId: leafProject.id,
          title: "Made on the leaf before sync",
          description: "Only Share sends this one.",
        });
        evidence.olderLeafTicket = older.id;
        await attachLeaf(command, leaf);
        const { ms } = await waitFor(
          "the first sync",
          () =>
            command.invoke<SyncStatus>("get_ticket_sync_status", { projectId: commandProject.id }),
          (status) =>
            status.nodes.some((node) => node.nodeId === leafNodeId && node.state === "in-sync"),
          // On the leaf's first project read, not the 60 s reconcile.
          30_000,
        );
        record("attach", { leafNodeId, commandNodeId, firstSyncMs: ms });
        // Nothing older was adopted on first sync.
        expect(
          (await tickets(command, commandProject.id)).map((entry) => entry.title),
        ).not.toContain("Made on the leaf before sync");
      });

      const shared =
        await test.step("a command ticket reaches the leaf with no manual sync", async () => {
          const created = await command.invoke<Ticket>("add_kanban_task", {
            projectId: commandProject.id,
            title: "Shared from the command node",
            description: "Synced to the leaf.",
          });
          const { value, ms } = await waitFor(
            "the ticket on the leaf",
            () => ticket(leaf, leafProject.id, created.id),
            (found) => Boolean(found?.sync?.replica),
          );
          expect(value!.sync!.replica!.controllerId).toBe(commandNodeId);
          record("commandToLeaf", { ticketId: created.id, ms });
          return created;
        });

      await test.step("a leaf edit reaches the command node on the leaf's announcement", async () => {
        await leaf.invoke("update_kanban_task", { taskId: shared.id, title: "Edited on the leaf" });
        const { ms } = await waitFor(
          "the leaf edit on the command node",
          () => ticket(command, commandProject.id, shared.id),
          (found) => found?.title === "Edited on the leaf",
          // The 60 s reconcile would also deliver it; the announcement must be quicker.
          20_000,
        );
        record("leafToCommand", { ms });
      });

      await test.step("Share sends the leaf's older ticket", async () => {
        const before = await leaf.invoke<{ unshared: number }>("get_ticket_sync_leaf_status", {
          projectId: leafProject.id,
        });
        expect(before.unshared).toBe(1);
        const result = await leaf.invoke<{ shared: number }>("share_tickets_with_command_node", {
          projectId: leafProject.id,
        });
        expect(result.shared).toBe(1);
        const { ms } = await waitFor(
          "the shared ticket on the command node",
          () => tickets(command, commandProject.id),
          (list) => list.some((entry) => entry.title === "Made on the leaf before sync"),
          20_000,
        );
        const after = await leaf.invoke<{ unshared: number }>("get_ticket_sync_leaf_status", {
          projectId: leafProject.id,
        });
        expect(after.unshared).toBe(0);
        record("share", { shared: result.shared, ms });
      });

      await test.step("an image read in each direction", async () => {
        const onCommand = await command.invoke<Ticket>("add_kanban_image", {
          taskId: shared.id,
          filename: "from-command.png",
          data: PNG,
        });
        const commandImage = onCommand.images!.find(
          (image) => image.filename === "from-command.png",
        )!;
        const commandBytes = await command.invoke<string>("get_kanban_image_data", {
          imageId: commandImage.id,
        });
        const listed = await waitFor(
          "the image reference on the leaf",
          () => ticket(leaf, leafProject.id, shared.id),
          (found) => Boolean(found?.images?.some((image) => image.id === commandImage.id)),
        );
        const read = await waitFor(
          "the image bytes on the leaf",
          () => leaf.invoke<string>("get_kanban_image_data", { imageId: commandImage.id }),
          (data) => data === commandBytes,
          60_000,
        );

        const onLeaf = await leaf.invoke<Ticket>("add_kanban_image", {
          taskId: shared.id,
          filename: "from-leaf.png",
          data: PNG,
        });
        const leafImage = onLeaf.images!.find((image) => image.filename === "from-leaf.png")!;
        const leafBytes = await leaf.invoke<string>("get_kanban_image_data", {
          imageId: leafImage.id,
        });
        const listedBack = await waitFor(
          "the leaf image reference on the command node",
          () => ticket(command, commandProject.id, shared.id),
          (found) => Boolean(found?.images?.some((image) => image.id === leafImage.id)),
          20_000,
        );
        const readBack = await waitFor(
          "the leaf image bytes on the command node",
          () => command.invoke<string>("get_kanban_image_data", { imageId: leafImage.id }),
          (data) => data === leafBytes,
        );
        record("images", {
          commandToLeaf: { listedMs: listed.ms, bytesMs: read.ms, bytes: commandBytes.length },
          leafToCommand: { listedMs: listedBack.ms, bytesMs: readBack.ms, bytes: leafBytes.length },
        });
      });

      await test.step("the boards: sync line on the command node, synced-from marks on the leaf", async () => {
        await openBoard(page, commandProfile);
        await expect(page.getByTestId("ticket-sync-node").first()).toContainText(LEAF_NAME);
        await shot(page, "command-board");
        await openBoard(page, leafProfile);
        await expect(page.getByTestId("ticket-sync-leaf")).toBeVisible();
        await expect(page.getByTestId("kanban-card-synced-from").first()).toBeVisible();
        await shot(page, "leaf-board");
      });

      await test.step("a conflict made while the link is disabled", async () => {
        await command.invoke("update_node", { nodeId: leafNodeId, enabled: false });
        await waitFor(
          "the leaf to read as disconnected",
          () =>
            command.invoke<{ nodes: Array<{ nodeId: string; available: boolean }> }>(
              "get_node_summaries",
              { nodeIds: [leafNodeId] },
            ),
          (summaries) => summaries.nodes[0]?.available === false,
        );
        await leaf.invoke("update_kanban_task", { taskId: shared.id, title: "Leaf side" });
        await command.invoke("update_kanban_task", { taskId: shared.id, title: "Command side" });
        await command.invoke("update_node", { nodeId: leafNodeId, enabled: true });
        const conflicted = await waitFor(
          "the conflict to be recorded",
          () =>
            command.invoke<SyncStatus>("get_ticket_sync_status", { projectId: commandProject.id }),
          (status) => (status.conflictCount ?? status.conflicts.length) > 0,
          90_000,
        );
        const settled = await waitFor(
          "both boards to agree on the title",
          async () => [
            (await ticket(command, commandProject.id, shared.id))?.title,
            (await ticket(leaf, leafProject.id, shared.id))?.title,
          ],
          ([onCommand, onLeaf]) => onCommand === onLeaf,
        );
        const comments = (await ticket(command, commandProject.id, shared.id))?.comments ?? [];
        expect(comments.some((comment) => /conflict/i.test(comment.text))).toBe(true);
        record("conflict", {
          ms: conflicted.ms,
          count: conflicted.value.conflictCount ?? conflicted.value.conflicts.length,
          kept: settled.value[0],
          commentRecorded: true,
        });

        await openBoard(page, commandProfile);
        await expect(page.getByTestId("ticket-sync-conflicts")).toBeVisible();
        await page.getByTestId("ticket-sync-conflicts").click();
        await expect(page.getByTestId("ticket-sync-conflict").first()).toBeVisible();
        await shot(page, "conflict-list");
        await page.keyboard.press("Escape");
        const dismissed = await command.invoke<{ dismissed: number; remaining: number }>(
          "dismiss_ticket_sync_conflicts",
          { projectId: commandProject.id },
        );
        expect(dismissed.remaining).toBe(0);
        const kept = (await ticket(command, commandProject.id, shared.id))?.comments ?? [];
        expect(kept.some((comment) => /conflict/i.test(comment.text))).toBe(true);
        record("dismiss", dismissed);
      });

      const coordinator = await test.step("a coordinator on the command node", async () => {
        // Left running: a paused coordinator is not a runnable identity. Its
        // wake turn, if one starts, goes to the loopback fake.
        const snapshot = await command.invoke<{
          workspace: {
            id: string;
            conversations: Array<{ id: string; role?: string; tabId: string; closedAt?: string }>;
          };
        }>("ensure_project_coordinator", { projectId: commandProject.id });
        const main = snapshot.workspace.conversations.find(
          (conversation) => conversation.role === "main" && !conversation.closedAt,
        )!;
        return {
          scope: {
            projectId: commandProject.id,
            coordinatorId: snapshot.workspace.id,
            conversationId: main.id,
          },
          mailbox: {
            environmentId: coordinatorRuntimeId(snapshot.workspace.id, main.id),
            tabId: main.tabId,
          },
        };
      });
      const baseCommit = spawnSync(
        "git",
        ["-C", profileStatus(commandProfile).testProject!, "rev-parse", "HEAD"],
        { encoding: "utf8" },
      ).stdout.trim();

      await test.step("a real disconnect: edits wait, a build is refused, the reconnect wakes the coordinator", async () => {
        mise(["dev:stop", "--profile", leafProfile]);
        const down = await waitFor(
          "the command node to see the leaf gone",
          () =>
            command.invoke<{ nodes: Array<{ available: boolean }> }>("get_node_summaries", {
              nodeIds: [leafNodeId],
            }),
          (summaries) => summaries.nodes[0]?.available === false,
          120_000,
        );
        await command.invoke("update_kanban_task", { taskId: shared.id, status: "review" });
        await command.invoke("update_kanban_task", {
          taskId: shared.id,
          title: "Edited while offline",
        });
        const offline = await command.invoke<SyncStatus>("get_ticket_sync_status", {
          projectId: commandProject.id,
        });
        const refusal = await command
          .invoke("start_coordinator_node_build_pipeline", {
            scope: coordinator.scope,
            requestId: "fleet-offline-build",
            nodeId: leafNodeId,
            input: {
              projectId: commandProject.id,
              taskId: shared.id,
              taskTitle: "Edited while offline",
              environmentType: "local",
              taskSnapshot: {
                title: "x",
                description: "",
                acceptanceCriteria: "",
                comments: [],
                images: [],
              },
              delegationBaseBranch: "main",
              delegationBaseCommit: baseCommit,
            },
          })
          .then(
            () => "started",
            (error: Error) => error.message,
          );
        expect(refusal).toContain("is not connected");
        expect(refusal).toContain("not queued");
        expect(refusal).toContain("You will get one message when it reconnects");

        const restartMs = await restartLeaf();
        leaf = gateway(leafProfile);
        await attachLeaf(command, leaf);
        const caughtUp = await waitFor(
          "the offline edits on the leaf",
          () => ticket(leaf, leafProject.id, shared.id),
          (found) => found?.title === "Edited while offline" && found.status === "review",
          120_000,
        );
        const woken = await waitFor(
          "the reconnect message in the coordinator's mailbox",
          () =>
            command.invoke<{
              messages: Array<{ id: string; subject?: string; placement?: string }>;
            }>("get_agent_mail_mailbox", { ...coordinator.mailbox, limit: 50 }),
          (mailbox) =>
            mailbox.messages.some(
              (message) => message.subject === `Machine ${LEAF_NAME} reconnected`,
            ),
          60_000,
        );
        const wakes = woken.value.messages.filter((message) =>
          message.subject?.endsWith("reconnected"),
        );
        expect(wakes).toHaveLength(1);
        // The mailbox lists metadata; the body is read like the agent reads it.
        const message = await command.invoke<{ body?: string }>("get_agent_mail_message", {
          ...coordinator.mailbox,
          messageId: wakes[0]!.id,
        });
        expect(message.body).toContain(`(nodeId ${leafNodeId}) is connected again`);
        expect(message.body).toContain("nothing was started or queued there");
        expect(message.body).toContain("get_launch_options");
        record("disconnect", {
          downMs: down.ms,
          offlineState: offline.nodes.find((node) => node.nodeId === leafNodeId)?.state,
          refused: true,
          leafRestartMs: restartMs,
          caughtUpMs: caughtUp.ms,
          reconnectWakes: wakes.length,
          reconnectWakeMs: woken.ms,
          reconnectWakePlacement: wakes[0]!.placement ?? null,
        });
      });

      await test.step("a build on the leaf with nodeId, linked there, then cancelled", async () => {
        const workflow = await command.invoke<{ id: string }>(
          "start_coordinator_node_build_pipeline",
          {
            scope: coordinator.scope,
            requestId: "fleet-remote-build",
            nodeId: leafNodeId,
            input: {
              projectId: commandProject.id,
              taskId: shared.id,
              taskTitle: "Edited while offline",
              environmentType: "local",
              agentType: "pi",
              taskSnapshot: {
                title: "Edited while offline",
                description: "Built on the leaf under the same id.",
                acceptanceCriteria: "",
                comments: [],
                images: [],
              },
              delegationBaseBranch: "main",
              delegationBaseCommit: baseCommit,
            },
          },
        );
        expect(workflow.id).toBeTruthy();
        const runsOn = await ticket(command, commandProject.id, shared.id);
        expect(runsOn?.sync?.work).toMatchObject({
          nodeId: leafNodeId,
          buildPipelineId: workflow.id,
        });
        const linked = await waitFor(
          "the leaf's ticket linked to the build",
          () => ticket(leaf, leafProject.id, shared.id),
          (found) => found?.buildPipelineId === workflow.id,
        );
        await leaf.invoke("cancel_build_pipeline", { pipelineId: workflow.id });
        // A cancel ends the pipeline as failed with "Build cancelled" and a cancelledAt.
        const cancelled = await waitFor(
          "the leaf's build to be cancelled",
          () =>
            leaf.invoke<{ snapshot: { phase: string; error?: string; cancelledAt?: string } }>(
              "get_build_pipeline",
              { pipelineId: workflow.id },
            ),
          (pipeline) => Boolean(pipeline.snapshot.cancelledAt),
        );
        expect(cancelled.value.snapshot.error).toBe("Build cancelled");
        const calls = (await (await fetch(`${model.origin}/__calls`)).json()) as {
          completions: number;
        };
        record("remoteBuild", {
          pipelineId: workflow.id,
          linkedMs: linked.ms,
          phase: cancelled.value.snapshot.phase,
          cancelled: true,
          fakeModelCompletions: calls.completions,
        });
      });

      record("finishedAt", new Date().toISOString());
    } finally {
      await stopChild(model.child);
    }
  });
});
