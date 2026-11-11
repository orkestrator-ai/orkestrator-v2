/**
 * Coordinator-to-coordinator node mail between two real `dev:test` profiles
 * on one host, with a scripted loopback model (to-do 2900 tasks 1 and 2). Run
 * it with `mise run test:agent:coordinator:node-mail-fake`, which starts two
 * disposable credential-free profiles that offer only Pi, runs this file and
 * resets both.
 *
 * Opt-in: skipped unless `ORKESTRATOR_AGENT_TEST_COORDINATOR_NODE_MAIL_FAKE=1`.
 * `ORKESTRATOR_AGENT_TEST_PROFILE` is the command node ("desk") and
 * `ORKESTRATOR_AGENT_TEST_NODE_MAIL_LEAF_PROFILE` the leaf. Nothing is billed
 * and nothing logs in: every model call either profile's Pi bridge makes goes
 * to `coordinator-node-mail-fake-model.ts` on loopback, which each profile's
 * isolated Pi `models.json` names (never `~/.pi`). The real backends, node
 * link (the desk attaches the leaf over the leaf's real gateway with its
 * gateway token, as `add_node` does for a real machine), coordinator context
 * and policy, Control MCP, Pi bridges and SDK, agent mail, the leaf's outbox
 * and the desk's collector all run; only the model is fake.
 *
 * - **Round trip.** The desk's coordinator asks `list_mailboxes` with the
 *   leaf's `nodeId` (reachable), then `send_message` with `nodeId` and
 *   `toEnvironmentId: "coordinator"`. The leaf's coordinator is woken with it
 *   framed as the command node's coordinator's request and answers with
 *   `replyToMessageId`; the answer goes through the leaf's outbox, the desk
 *   collects it and its coordinator is woken with it framed as an answer from
 *   the leaf's coordinator.
 * - **Loop bound.** Both profiles' unattended budget is 3. The desk's
 *   coordinator asks a new question every time an answer wakes it; the leaf
 *   answers each. Three answers wake the desk, the fourth is held
 *   (`loop-budget-exhausted`) with one budget notice, the leaf was woken four
 *   times, and nothing more happens.
 *
 * What it cannot prove: the fake decides what to send, so whether a real
 * model replies rather than starting new threads, or stops on the budget
 * notice, needs billed turns. One host shares a kernel and loopback, so a
 * slow, SSH-forwarded or dropped link is not exercised.
 *
 * Writes a content-free summary to
 * `output/agent-testing/<run>/coordinator-node-mail-fake/summary.json`.
 */
import { expect, test } from "./browser-test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  coordinatorMainConversation,
  coordinatorRuntimeId,
  type CoordinatorSnapshot,
} from "@orkestrator/protocol/coordinator";
import {
  attachLeaf,
  pointPiAt,
  sharedProject,
  signIn,
  until,
  type Profile,
} from "./coordinator-two-node-support";
import {
  qaPrompt,
  type CarrierFacts,
  type QaMode,
} from "./coordinator-node-mail-fake-model-script";
import { repositoryRoot, type Invoke } from "./slash-command-live-support";

const LIVE = process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_NODE_MAIL_FAKE === "1";
const deskProfile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "qa-node-mail-desk";
const leafProfile =
  process.env.ORKESTRATOR_AGENT_TEST_NODE_MAIL_LEAF_PROFILE ?? "qa-node-mail-leaf";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? deskProfile;

const PI_PROVIDER = "node-mail-fake";
const PI_MODEL = "node-mail-1";
const MODEL_REF = `${PI_PROVIDER}/${PI_MODEL}`;
const PI = {
  id: PI_PROVIDER,
  name: "Coordinator node mail fake",
  model: PI_MODEL,
  modelName: "Node mail 1",
  apiKey: "node-mail-fake-not-a-key",
};
const CHECKOUT = "node-mail-qa";
/** The same repository on both profiles, which is how each finds the other's copy. */
const SHARED_GIT_URL = "https://github.com/orkestrator-qa/node-mail.git";
const BUDGET = 3;

type NodeCalls = {
  completions: number;
  toolCalls: Record<string, number>;
  wakes: CarrierFacts[][];
};
type Calls = { refused: number; desk: NodeCalls; leaf: NodeCalls };
type MailSummary = {
  id: string;
  from: { kind: string; role?: string; nodeId?: string };
  trust?: string;
  placement: string;
  placementReason?: string;
  injectedAt?: string;
  subject?: string;
  replyToMessageId?: string;
};
type Coordinator = {
  invoke: Invoke;
  projectId: string;
  conversationId: string;
  environmentId: string;
  tabId: string;
  logicalSessionKey: string;
};

test.describe.configure({ mode: "serial" });
test.use({ trace: "off" });

async function startFakeModel(): Promise<{ origin: string; child: ChildProcess }> {
  const child = spawn(
    "bun",
    [path.join(import.meta.dirname, "coordinator-node-mail-fake-model.ts")],
    {
      stdio: ["ignore", "pipe", "inherit"],
    },
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

/** Pi as the coordinator's agent on the fake model, and the unattended budget lowered. */
async function configure(invoke: Invoke): Promise<() => Promise<void>> {
  const config = await invoke<{ global: Record<string, unknown> }>("get_config");
  const previous = {
    coordinatorProviderTiers: config.global.coordinatorProviderTiers,
    agentSettings: config.global.agentSettings,
    agentMessaging: config.global.agentMessaging,
  };
  const agentSettings = (config.global.agentSettings ?? {}) as Record<string, unknown>;
  const platforms = (agentSettings.platforms ?? {}) as Record<string, unknown>;
  const messaging = (config.global.agentMessaging ?? {}) as Record<string, unknown>;
  await invoke("update_global_config", {
    global: {
      ...config.global,
      coordinatorProviderTiers: "provider-configured",
      agentSettings: {
        ...agentSettings,
        platforms: { ...platforms, pi: { mode: "native", model: MODEL_REF } },
      },
      agentMessaging: { ...messaging, autonomousWakeBudget: BUDGET },
    },
  });
  return async () => {
    const current = await invoke<{ global: Record<string, unknown> }>("get_config");
    await invoke("update_global_config", { global: { ...current.global, ...previous } });
  };
}

/** A fresh Pi main coordinator conversation with its session started. */
async function piCoordinator(invoke: Invoke, projectId: string): Promise<Coordinator> {
  let snapshot = await invoke<CoordinatorSnapshot>("ensure_project_coordinator", { projectId });
  const earlier = coordinatorMainConversation(snapshot.workspace);
  if (earlier?.agent) {
    snapshot = await invoke<CoordinatorSnapshot>("close_coordinator_conversation", {
      projectId,
      conversationId: earlier.id,
    });
  }
  if (!coordinatorMainConversation(snapshot.workspace)) {
    snapshot = await invoke<CoordinatorSnapshot>("create_coordinator_conversation", { projectId });
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
  const environmentId = coordinatorRuntimeId(snapshot.workspace.id, conversation.id);
  await invoke("ensure_native_agent_session", {
    environmentId,
    agent: "pi",
    logicalSessionKey: conversation.logicalSessionKey,
    model: MODEL_REF,
  });
  return {
    invoke,
    projectId,
    conversationId: conversation.id,
    environmentId,
    tabId: conversation.tabId,
    logicalSessionKey: conversation.logicalSessionKey,
  };
}

async function mailbox(coordinator: Coordinator): Promise<MailSummary[]> {
  const snapshot = await coordinator.invoke<{ messages: MailSummary[] }>("get_agent_mail_mailbox", {
    environmentId: coordinator.environmentId,
    tabId: coordinator.tabId,
  });
  return snapshot.messages;
}

async function prompt(coordinator: Coordinator, mode: QaMode, nodeId: string) {
  await coordinator.invoke("dispatch_native_agent_intent", {
    environmentId: coordinator.environmentId,
    agent: "pi",
    logicalSessionKey: coordinator.logicalSessionKey,
    prompt: qaPrompt(mode, nodeId),
    requestId: `node-mail-qa-${mode}-${Date.now()}`,
    mode: "build",
  });
}

/** Waits until neither profile's Pi has called the model for 15 s; returns the counts. */
async function settle(origin: string): Promise<Calls> {
  let settled = await calls(origin);
  for (let quiet = 0; quiet < 3;) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const next = await calls(origin);
    quiet =
      next.desk.completions === settled.desk.completions &&
      next.leaf.completions === settled.leaf.completions
        ? quiet + 1
        : 0;
    settled = next;
  }
  return settled;
}

const nodeMail = (messages: MailSummary[]) => messages.filter((m) => m.from.kind === "node");
const toolCount = (counts: NodeCalls, tool: string) =>
  Object.entries(counts.toolCalls)
    .filter(([name]) => name === tool || name.endsWith(`_${tool}`))
    .reduce((sum, [, count]) => sum + count, 0);
const answerWakes = (counts: NodeCalls) =>
  counts.wakes.flat().filter((facts) => facts.answer !== undefined);
const questionWakes = (counts: NodeCalls) =>
  counts.wakes.flat().filter((facts) => facts.question !== undefined);

function writeSummary(summary: Record<string, unknown>): void {
  const directory = path.join(
    repositoryRoot,
    "output",
    "agent-testing",
    runId,
    "coordinator-node-mail-fake",
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
}

test.describe("coordinator node mail between two profiles on a fake model", () => {
  test.skip(
    !LIVE,
    "opt-in: set ORKESTRATOR_AGENT_TEST_COORDINATOR_NODE_MAIL_FAKE=1 (fake model, no billing)",
  );
  test.setTimeout(25 * 60_000);

  test("a command node's coordinator asks a leaf's coordinator, gets its answer, and the budget bounds a loop", async ({
    page,
    browser,
  }) => {
    page.setDefaultTimeout(30_000);
    const summary: Record<string, unknown> = {
      version: 1,
      verdict: "failed",
      budget: BUDGET,
      startedAt: new Date().toISOString(),
    };
    const started = Date.now();
    const desk = await signIn(page, deskProfile);
    // A second browser context: both gateways are on 127.0.0.1, whose
    // cookies do not tell ports apart.
    const leafContext = await browser.newContext();
    const leaf = await signIn(await leafContext.newPage(), leafProfile);
    const model = await startFakeModel();
    const cleanup: Array<() => Promise<unknown>> = [];
    let fake: Calls | undefined;
    try {
      // Named before any Pi bridge starts, so the first one reads it.
      const restoreDesk = pointPiAt(desk.status, `${model.origin}/desk/v1`, PI);
      const restoreLeaf = pointPiAt(leaf.status, `${model.origin}/leaf/v1`, PI);
      cleanup.push(
        async () => restoreDesk(),
        async () => restoreLeaf(),
      );
      cleanup.push(await configure(desk.invoke), await configure(leaf.invoke));

      const deskProjectId = (await sharedProject(desk, CHECKOUT, SHARED_GIT_URL)).id;
      const leafProjectId = (await sharedProject(leaf, CHECKOUT, SHARED_GIT_URL)).id;

      // The desk attaches the leaf over the leaf's real gateway.
      const nodeId = await attachLeaf(desk, leaf, (attached) =>
        cleanup.push(() => desk.invoke("forget_node", { nodeId: attached })),
      );
      summary.attached = true;

      let deskCoordinator = await piCoordinator(desk.invoke, deskProjectId);
      const leafCoordinator = await piCoordinator(leaf.invoke, leafProjectId);
      cleanup.push(
        () =>
          desk.invoke("close_coordinator_conversation", {
            projectId: deskCoordinator.projectId,
            conversationId: deskCoordinator.conversationId,
          }),
        () =>
          leaf.invoke("close_coordinator_conversation", {
            projectId: leafCoordinator.projectId,
            conversationId: leafCoordinator.conversationId,
          }),
      );
      // On a reused profile, mail a closed earlier main still held moves to
      // this one; it must stay held and wake nothing (see step 3).
      await settle(model.origin);
      const carried = nodeMail(await mailbox(deskCoordinator));
      summary.carriedFromEarlierRun = carried.map(({ placement, placementReason }) => ({
        placement,
        placementReason,
      }));
      expect(carried.filter((m) => m.placement === "injected")).toEqual([]);
      expect((await calls(model.origin)).desk.completions, "carried mail woke the desk").toBe(0);
      const carriedIds = new Set(carried.map((m) => m.id));
      const fresh = (messages: MailSummary[]) =>
        nodeMail(messages).filter((m) => !carriedIds.has(m.id));

      // 1. Round trip.
      await prompt(deskCoordinator, "round-trip", nodeId);
      const leafQuestion = await until(
        "the question in the leaf coordinator's inbox",
        () => mailbox(leafCoordinator),
        (messages) => nodeMail(messages).some((m) => m.injectedAt),
      );
      const deskAnswer = await until(
        "the leaf coordinator's answer to wake the desk's coordinator",
        () => mailbox(deskCoordinator),
        (messages) => fresh(messages).some((m) => m.injectedAt),
      );
      fake = await until(
        "the desk model to observe the round-trip answer",
        () => calls(model.origin),
        (counts) => answerWakes(counts.desk).length > 0,
      );
      await until(
        "the desk answer turn to finish",
        () =>
          deskCoordinator.invoke<{ turn: { phase: string } } | null>(
            "get_native_agent_projection",
            {
              environmentId: deskCoordinator.environmentId,
              agent: "pi",
              logicalSessionKey: deskCoordinator.logicalSessionKey,
            },
          ),
        (session) => session?.turn.phase === "idle",
      );
      const roundTrip = {
        leafQuestion: nodeMail(leafQuestion).map(({ from, trust, placement }) => ({
          fromKind: from.kind,
          fromRole: from.role,
          trust,
          placement,
        })),
        deskAnswer: fresh(deskAnswer).map(({ from, trust, placement }) => ({
          fromKind: from.kind,
          fromRole: from.role,
          fromNode: from.nodeId === nodeId,
          trust,
          placement,
        })),
        deskListMailboxes: toolCount(fake.desk, "list_mailboxes"),
        deskSends: toolCount(fake.desk, "send_message"),
        leafSends: toolCount(fake.leaf, "send_message"),
        leafWakes: fake.leaf.wakes,
        deskWakes: fake.desk.wakes,
      };
      summary.roundTrip = roundTrip;
      // The leaf took it as the command node's coordinator's request.
      expect(roundTrip.leafQuestion).toEqual([
        { fromKind: "node", fromRole: "coordinator", trust: "same-project", placement: "injected" },
      ]);
      expect(questionWakes(fake.leaf)).toEqual([
        expect.objectContaining({
          fromKind: "node",
          fromRole: "coordinator",
          question: 0,
          framedAsNodeCoordinator: true,
        }),
      ]);
      // The desk took the answer as an agent's mail from the leaf's coordinator.
      expect(roundTrip.deskAnswer).toEqual([
        {
          fromKind: "node",
          fromRole: "agent",
          fromNode: true,
          trust: "same-project",
          placement: "injected",
        },
      ]);
      expect(answerWakes(fake.desk)).toEqual([
        expect.objectContaining({
          fromKind: "node",
          fromRole: "agent",
          answer: 0,
          framedAsNodeCoordinator: true,
          framedAsAnswer: true,
        }),
      ]);
      expect(roundTrip.deskListMailboxes).toBe(1);
      expect(roundTrip.deskSends).toBe(1);
      expect(roundTrip.leafSends).toBe(1);

      // 2. Loop bound: a new prompt starts a fresh budget on the desk.
      const before = await calls(model.origin);
      await prompt(deskCoordinator, "loop", nodeId);
      const held = await until(
        "the leaf coordinator's mail to be held by the desk's budget",
        () => mailbox(deskCoordinator),
        (messages) =>
          fresh(messages).some(
            (m) => m.placement === "inject-held" && m.placementReason === "loop-budget-exhausted",
          ),
        300_000,
      );
      // Nothing further happens once the budget holds the leaf's mail.
      fake = await settle(model.origin);
      const deskAfter = await mailbox(deskCoordinator);
      // The mailbox lists newest first; the round trip's answer is left out by id.
      const roundTripIds = new Set(fresh(deskAnswer).map((m) => m.id));
      const loopMail = fresh(deskAfter).filter((m) => !roundTripIds.has(m.id));
      const loopAnswers = answerWakes(fake.desk).slice(answerWakes(before.desk).length);
      const loopQuestions = questionWakes(fake.leaf).slice(questionWakes(before.leaf).length);
      const notices = deskAfter.filter(
        (m) => m.from.kind === "system" && m.subject?.includes("loop budget"),
      );
      const loop = {
        answersDelivered: loopMail.filter((m) => m.placement === "injected").length,
        answersHeld: loopMail
          .filter((m) => m.placement !== "injected")
          .map((m) => ({ placement: m.placement, placementReason: m.placementReason })),
        deskWokenByAnswers: loopAnswers.map((facts) => facts.answer),
        leafWokenByQuestions: loopQuestions.map((facts) => facts.question),
        deskSends: toolCount(fake.desk, "send_message") - toolCount(before.desk, "send_message"),
        leafSends: toolCount(fake.leaf, "send_message") - toolCount(before.leaf, "send_message"),
        budgetNotices: notices.length,
        budgetNoticeReachedModel: fake.desk.wakes.flat().filter((facts) => facts.budgetNotice)
          .length,
        heldAtFirstRead: fresh(held).filter((m) => m.placement === "inject-held").length,
      };
      summary.loop = loop;
      expect(loop.answersDelivered).toBe(BUDGET);
      expect(loop.answersHeld).toEqual([
        { placement: "inject-held", placementReason: "loop-budget-exhausted" },
      ]);
      expect(loop.deskWokenByAnswers).toEqual([0, 1, 2]);
      // Each new question is a fresh request on the leaf, which answers all four.
      expect(loop.leafWokenByQuestions).toEqual([0, 1, 2, 3]);
      expect(loop.deskSends).toBe(BUDGET + 1);
      expect(loop.leafSends).toBe(BUDGET + 1);
      expect(loop.budgetNotices).toBe(1);
      expect(loop.budgetNoticeReachedModel).toBe(1);
      expect(fake.refused).toBe(0);

      // 3. The user replaces the desk's main: the held answer moves to the new
      // main still held, and wakes nothing until the user resumes it.
      const heldIds = loopMail.filter((m) => m.placement !== "injected").map((m) => m.id);
      const beforeReplace = fake;
      await desk.invoke("close_coordinator_conversation", {
        projectId: deskCoordinator.projectId,
        conversationId: deskCoordinator.conversationId,
      });
      deskCoordinator = await piCoordinator(desk.invoke, deskProjectId);
      fake = await settle(model.origin);
      const replaced = await mailbox(deskCoordinator);
      const moved = nodeMail(replaced).filter((m) => heldIds.includes(m.id));
      const replace = {
        moved: moved.map(({ placement, placementReason }) => ({ placement, placementReason })),
        deskCompletionsAfterReplace: fake.desk.completions - beforeReplace.desk.completions,
        leafCompletionsAfterReplace: fake.leaf.completions - beforeReplace.leaf.completions,
      };
      summary.replace = replace;
      expect(replace.moved).toEqual([
        { placement: "inject-held", placementReason: "loop-budget-exhausted" },
      ]);
      expect(replace.deskCompletionsAfterReplace).toBe(0);
      expect(replace.leafCompletionsAfterReplace).toBe(0);
      summary.verdict = "passed";
    } catch (error) {
      summary.reason = error instanceof Error ? error.message.slice(0, 2_000) : String(error);
      throw error;
    } finally {
      const failures: string[] = [];
      for (const step of cleanup.reverse()) {
        await step().catch((error: unknown) =>
          failures.push(error instanceof Error ? error.message.slice(0, 300) : String(error)),
        );
      }
      if (failures.length > 0) summary.cleanupFailures = failures;
      fake ??= await calls(model.origin).catch(() => undefined);
      summary.fakeModel = fake ?? null;
      summary.durationMs = Date.now() - started;
      writeSummary(summary);
      await stopChild(model.child);
      await leafContext.close();
    }
  });
});
