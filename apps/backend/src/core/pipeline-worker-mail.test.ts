/**
 * Build pipeline workers as agent mailboxes, end to end through the real mail
 * store, coordinator command, drain and the pipeline's own side of delivery
 * (docs/architecture/coordinator.md, "Pipeline worker mailboxes").
 */
import { afterEach, describe, expect, test } from "bun:test";
import { COORDINATOR_MAIL_ADDRESS } from "@orkestrator/protocol/coordinator";
import { pipelineWorkerTabId } from "@orkestrator/protocol/pipeline-worker-mail";
import {
  BUILD_CANCELLED_ERROR,
  type BuildPipeline,
  type PipelineSession,
} from "@orkestrator/protocol/build-pipeline";
import { MailWorld } from "./agent-mail-world-test-support.js";
import { assertCallerMailbox } from "./agent-tools-messaging.js";
import {
  addPipelineEnvironment,
  endWorkerTurn,
  pipelineSnapshot,
  pipelineWorkerPort,
  savePipeline,
  ScriptedSteerProvider,
  stageSession,
  workerAddress,
} from "./pipeline-worker-mail-test-support.js";
import type { BuildPipelineContext } from "./build-pipeline-context.js";
import { readPipelineWorkerTranscript } from "./build-pipeline-worker-transcript.js";
import { pipelineWorkerTabForResultKey } from "./pipeline-worker-identity.js";

type Harness = {
  world: MailWorld;
  environmentId: string;
  provider: ScriptedSteerProvider;
  ctx: () => BuildPipelineContext;
  save(pipeline: BuildPipeline): Promise<void>;
};

let worlds: MailWorld[] = [];

afterEach(async () => {
  await Promise.all(worlds.map((world) => world.close()));
  worlds = [];
});

async function harness(): Promise<Harness> {
  const provider = new ScriptedSteerProvider();
  let ctx: BuildPipelineContext | null = null;
  const world = await MailWorld.create({
    pipelineWorkers: (storage) => {
      const port = pipelineWorkerPort(storage, provider);
      ctx = port.ctx;
      return port.workerMail;
    },
  });
  worlds.push(world);
  const environmentId = await addPipelineEnvironment(world);
  const bind = () => {
    ctx!.workerMailbox = {
      claim: (environment, tab, requestId) =>
        world.mail.claimPipelineWorkerMail(environment, tab, requestId),
      settle: (environment, tab, ids, outcome) =>
        world.mail.settlePipelineWorkerMail(environment, tab, ids, outcome),
    };
    return ctx!;
  };
  return {
    world,
    environmentId,
    provider,
    ctx: bind,
    save: (pipeline) => savePipeline(world.storage, pipeline),
  };
}

function worker(environmentId: string, session: PipelineSession) {
  return { environmentId, ...workerAddress(session) };
}

/** A build that is running its first turn. */
async function runningBuild(h: Harness) {
  const build = stageSession("build", { key: "build", label: "Build Session" });
  const pipeline = pipelineSnapshot(h.environmentId, h.world.projectId, [build]);
  await h.save(pipeline);
  return { build, pipeline };
}

/** A review step whose three reviewers run in parallel, after a finished build. */
function reviewPanel(h: Harness) {
  const build = stageSession("build", { key: "build", label: "Build Session", status: "idle" });
  const reviewers = [1, 2, 3].map((slot) =>
    stageSession("review", {
      key: `reviewer-${slot}`,
      label: `Independent Review ${slot}`,
    }),
  );
  const pipeline = pipelineSnapshot(h.environmentId, h.world.projectId, [build, ...reviewers], {
    phase: "reviewing",
    reviewFanout: {
      reviewers: reviewers.map((session, index) => ({
        id: `reviewer-${index + 1}`,
        status: "running",
        agent: "codex",
        model: "gpt-test",
        sessionKey: session.sessionKey,
        providerSessionId: session.sdkSessionId,
      })),
    },
  });
  return { build, reviewers, pipeline };
}

describe("pipeline worker mailboxes", () => {
  test("every worker gets its own mailbox, and parallel reviewers each have one", async () => {
    const h = await harness();
    const { reviewers, pipeline } = reviewPanel(h);
    await h.save(pipeline);
    const listed = await h.world.storage.listAgentMailboxes({ environmentId: h.environmentId });
    const workers = listed.mailboxes.map((mailbox) => ({
      tabId: mailbox.tabId,
      kind: mailbox.kind,
      step: mailbox.pipelineWorker?.step,
      slot: mailbox.pipelineWorker?.slot,
      round: mailbox.pipelineWorker?.round,
      status: mailbox.pipelineWorker?.status,
      agent: mailbox.agent,
      model: mailbox.pipelineWorker?.model,
    }));
    expect(workers).toEqual([
      {
        tabId: pipelineWorkerTabId(pipeline.sessions[0]!.sessionKey),
        kind: "pipeline",
        step: "build",
        slot: undefined,
        round: 1,
        status: "finished",
        agent: "codex",
        model: "gpt-test",
      },
      ...reviewers.map((session, index) => ({
        tabId: pipelineWorkerTabId(session.sessionKey),
        kind: "pipeline" as const,
        step: "review",
        slot: index + 1,
        round: 1,
        status: "running" as const,
        agent: "codex" as const,
        model: "gpt-test",
      })),
    ]);
    // The pipeline's own tab is not a mailbox.
    expect(listed.mailboxes.some((mailbox) => mailbox.tabId === "build")).toBe(false);

    // Each reviewer is messaged independently.
    const main = await h.world.main();
    for (const [index, session] of reviewers.entries()) {
      const sent = await h.world.delegate(main, worker(h.environmentId, session), `slot ${index}`);
      expect(sent.toTabId).toBe(pipelineWorkerTabId(session.sessionKey));
      expect(sent.placement).toBe("pending-inject");
    }
    for (const [index, session] of reviewers.entries()) {
      const inbox = await h.world.storage.getAgentMailMailbox(
        h.environmentId,
        pipelineWorkerTabId(session.sessionKey),
      );
      expect(inbox.messages.map((message) => message.toTabId)).toEqual([
        pipelineWorkerTabId(session.sessionKey),
      ]);
      expect(inbox.total).toBe(1);
      expect(index).toBeGreaterThanOrEqual(0);
    }
  });

  test("a send naming only the pipeline environment is refused with the worker list", async () => {
    const h = await harness();
    const { reviewers, pipeline } = reviewPanel(h);
    await h.save(pipeline);
    const main = await h.world.main();
    const refused = h.world.delegate(main, { environmentId: h.environmentId, tabId: "" }, "hi");
    await expect(refused).rejects.toThrow(/runs a build pipeline/);
    await expect(refused).rejects.toThrow(pipelineWorkerTabId(reviewers[2]!.sessionKey));
    const inbox = await h.world.storage.listAgentMailboxes({ environmentId: h.environmentId });
    expect(inbox.mailboxes.every((mailbox) => mailbox.pendingInjectCount === 0)).toBe(true);
  });

  test("cancelled fan-out workers expire each queued inbox", async () => {
    const h = await harness();
    const { reviewers, pipeline } = reviewPanel(h);
    await h.save(pipeline);
    const main = await h.world.main();
    const sent = [];
    for (const session of reviewers)
      sent.push(await h.world.delegate(main, worker(h.environmentId, session), "queued"));
    pipeline.phase = "failed";
    pipeline.error = BUILD_CANCELLED_ERROR;
    await h.save(pipeline);
    for (const message of sent) {
      const expired = await h.world.storage.getAgentMailMessage(
        h.environmentId,
        message.toTabId,
        message.id,
      );
      expect(expired.placement).toBe("expired");
      expect(expired.placementReason).toBe("worker-cancelled");
    }
  });

  test("environment-only sends refuse even after multiple worker delegations", async () => {
    const h = await harness();
    const { reviewers, pipeline } = reviewPanel(h);
    await h.save(pipeline);
    const main = await h.world.main();
    for (const session of reviewers.slice(0, 2)) {
      await h.world.delegate(main, worker(h.environmentId, session), "explicit");
      await expect(
        h.world.delegate(main, { environmentId: h.environmentId, tabId: "" }, "implicit"),
      ).rejects.toThrow(/runs a build pipeline/);
    }
  });

  test("a ride-along notice alone is no worker turn, and rides in with the next mail", async () => {
    const h = await harness();
    const { build } = await runningBuild(h);
    const address = worker(h.environmentId, build);
    const rider = await h.world.storage.sendAgentMail(
      {
        kind: "system",
        projectId: h.world.projectId,
        source: "workflow",
        resourceId: "account-auto-switch:codex",
      },
      {
        requestId: "rider-for-worker",
        toEnvironmentId: address.environmentId,
        toTabId: address.tabId,
        subject: "Codex moved to b@example.invalid",
        body: "Automatic account switching moved Codex.",
      },
      {
        notice: {
          resource: { kind: "account-switch", id: "codex", label: "mini" },
          accountSwitch: { provider: "Codex", from: "a@example.invalid", to: "b@example.invalid" },
          state: "account-switched",
          tone: "info",
        },
        rideAlong: true,
      },
    );
    expect(rider.placement).toBe("pending-inject");
    expect(
      await h.world.mail.claimPipelineWorkerMail(address.environmentId, address.tabId, "alone"),
    ).toBeNull();
    const main = await h.world.main();
    const sent = await h.world.delegate(main, address, "the actual work");
    const claim = await h.world.mail.claimPipelineWorkerMail(
      address.environmentId,
      address.tabId,
      "with-work",
    );
    expect(claim?.messageIds.toSorted()).toEqual([rider.id, sent.id].toSorted());
  });

  test("a journaled claim survives restart without returning to the queue", async () => {
    const h = await harness();
    const { build, pipeline } = await runningBuild(h);
    const main = await h.world.main();
    const sent = await h.world.delegate(main, worker(h.environmentId, build), "journaled");
    await h.world.mail.claimPipelineWorkerMail(h.environmentId, sent.toTabId, "owned-request");
    build.mailDeliveries = ["owned-request"];
    await h.save(pipeline);
    await h.world.restart();
    const recovered = await h.world.storage.getAgentMailMessage(
      h.environmentId,
      sent.toTabId,
      sent.id,
    );
    expect(recovered.placement).toBe("injected");
    expect(
      await h.world.mail.claimPipelineWorkerMail(h.environmentId, sent.toTabId, "again"),
    ).toBeNull();
  });

  test.each(["address", "verify"] as const)(
    "mail renews the %s result authority",
    async (phase) => {
      const h = await harness();
      const session = {
        ...stageSession(phase, { key: phase }),
        structuredRequestId: "old-result",
        resultTransport: "tool-v1" as const,
        structuredResultStatus: "accepted" as const,
      };
      await h.save(
        pipelineSnapshot(h.environmentId, h.world.projectId, [session], {
          phase: phase === "verify" ? "verifying" : "addressing",
        }),
      );
      const main = await h.world.main();
      await h.world.delegate(main, worker(h.environmentId, session), "Correct the verdict");
      const turn = await endWorkerTurn(h.world.storage, h.ctx(), session);
      expect(turn.started).toBe(true);
      const renewed = turn.pipeline.sessions[0]!;
      expect(renewed.structuredRequestId).not.toBe("old-result");
      expect(renewed.structuredResultStatus).toBe("pending");
      expect(turn.pipeline.pendingPromptAttempt).toMatchObject({
        structuredReview: true,
        resultTransport: "tool-v1",
        requestId: renewed.structuredRequestId,
      });
    },
  );

  test("mail for a running worker waits for its turn to end, then is its next turn", async () => {
    const h = await harness();
    const { build } = await runningBuild(h);
    const main = await h.world.main();
    const sent = await h.world.delegate(main, worker(h.environmentId, build), "Also add docs.");
    expect(sent.placement).toBe("pending-inject");
    await h.world.deliver();
    // Still queued: the drain never starts a turn for a pipeline worker.
    const queued = await h.world.storage.getAgentMailMessage(
      h.environmentId,
      sent.toTabId,
      sent.id,
    );
    expect(queued.placement).toBe("pending-inject");
    expect(h.provider.steers).toEqual([]);

    const turn = await endWorkerTurn(h.world.storage, h.ctx(), build);
    expect(turn.started).toBe(true);
    expect(turn.sent).toHaveLength(1);
    expect(turn.sent[0]).toContain("Also add docs.");
    expect(turn.sent[0]).toContain("You are a build pipeline step.");
    const session = turn.pipeline.sessions[0]!;
    expect(session.mailDeliveries).toEqual([turn.pipeline.pendingPromptAttempt!.requestId]);
    const delivered = await h.world.storage.getAgentMailMessage(
      h.environmentId,
      sent.toTabId,
      sent.id,
    );
    expect(delivered.placement).toBe("injected");
    // Nothing left: the next turn end starts no second mail turn.
    expect((await endWorkerTurn(h.world.storage, h.ctx(), build)).started).toBe(false);
  });

  test("deliverNow steers into the worker's running turn", async () => {
    const h = await harness();
    const { build } = await runningBuild(h);
    const main = await h.world.main();
    const sent = await h.world.delegate(
      main,
      worker(h.environmentId, build),
      "Stop: the requirement changed.",
      { deliverNow: true },
    );
    expect(sent.deliverNow).toBe("steered");
    expect(sent.placement).toBe("injected");
    expect(sent.injectedVia).toBe("steer");
    expect(h.provider.steers).toHaveLength(1);
    expect(h.provider.steers[0]!.sessionId).toBe(build.sdkSessionId);
    expect(h.provider.steers[0]!.text).toContain("Stop: the requirement changed.");
  });

  test("deliverNow on an agent that cannot steer is queued for the turn end", async () => {
    const h = await harness();
    h.provider.steerable = false;
    const { build } = await runningBuild(h);
    const main = await h.world.main();
    const sent = await h.world.delegate(main, worker(h.environmentId, build), "Course change.", {
      deliverNow: true,
    });
    expect(sent.placement).toBe("pending-inject");
    expect(sent.deliverNow).toBe("unsupported, queued");
    expect(h.provider.steers).toEqual([]);
    const turn = await endWorkerTurn(h.world.storage, h.ctx(), build);
    expect(turn.sent[0]).toContain("Course change.");
  });

  test("a worker that has ended refuses new mail with its state", async () => {
    const h = await harness();
    const { build, pipeline } = reviewPanel(h);
    await h.save(pipeline);
    const main = await h.world.main();
    await expect(h.world.delegate(main, worker(h.environmentId, build), "late")).rejects.toThrow(
      /has finished and takes no more mail/,
    );
  });

  test("mail queued for a worker that ends expires, and the sender is told", async () => {
    const h = await harness();
    const { build, pipeline } = await runningBuild(h);
    const main = await h.world.main();
    const sent = await h.world.delegate(main, worker(h.environmentId, build), "Never read.");
    // The build ends without another turn and the pipeline moves on.
    const verify = stageSession("verify", { key: "verify", label: "Verify Session" });
    await h.save({
      ...pipeline,
      phase: "verifying",
      sessions: [{ ...build, status: "idle" }, verify],
      currentSessionIndex: 1,
    });
    const expired = await h.world.storage.getAgentMailMessage(
      h.environmentId,
      sent.toTabId,
      sent.id,
    );
    expect(expired.placement).toBe("expired");
    expect(expired.placementReason).toBe("worker-finished");
    // Not re-routed: the Verify worker's inbox is empty.
    const verifyInbox = await h.world.storage.getAgentMailMailbox(
      h.environmentId,
      pipelineWorkerTabId(verify.sessionKey),
    );
    expect(verifyInbox.total).toBe(0);
    const coordinatorInbox = await h.world.storage.getAgentMailMailbox(
      main.environmentId,
      main.tabId,
    );
    const notice = coordinatorInbox.messages.find(
      (message) => message.notice?.state === "mail-expired",
    );
    expect(notice?.from.kind).toBe("system");
    expect(notice?.subject).toContain("Undelivered");
    const body = await h.world.storage.getAgentMailMessage(
      main.environmentId,
      main.tabId,
      notice!.id,
    );
    expect(body.body).toContain(sent.id);
    expect(body.body).toContain("finished");
  });

  test("a worker replies to, sends to and acks its coordinator's mail as itself", async () => {
    const h = await harness();
    const { build } = await runningBuild(h);
    const main = await h.world.main();
    const asked = await h.world.delegate(main, worker(h.environmentId, build), "Status?");
    const address = pipelineWorkerTabId(build.sessionKey);
    const scope = {
      environmentId: h.environmentId,
      projectId: h.world.projectId,
      tabId: address,
    };
    const { identity } = await assertCallerMailbox(h.world.storage, scope);
    expect(identity.tabId).toBe(address);
    // An environment-wide credential cannot claim a worker's mailbox.
    await expect(
      assertCallerMailbox(
        h.world.storage,
        { environmentId: h.environmentId, projectId: h.world.projectId },
        address,
      ),
    ).rejects.toThrow(/not a live pull-capable mailbox/);

    const sender = {
      kind: "tab" as const,
      environmentId: h.environmentId,
      projectId: h.world.projectId,
      tabId: address,
    };
    const reply = await h.world.storage.replyAgentMail(sender, asked.id, "r1", "Halfway done.");
    expect(reply.toEnvironmentId).toBe(main.environmentId);
    await h.world.storage.ackAgentMail(h.environmentId, address, asked.id);
    const report = await h.world.storage.sendAgentMail(sender, {
      requestId: "r2",
      toEnvironmentId: COORDINATOR_MAIL_ADDRESS,
      toTabId: "",
      body: "Done.",
    });
    expect(report.from).toMatchObject({
      kind: "tab",
      environmentId: h.environmentId,
      tabId: address,
    });
    const coordinatorInbox = await h.world.storage.getAgentMailMailbox(
      main.environmentId,
      main.tabId,
    );
    expect(coordinatorInbox.messages.map((message) => message.id)).toEqual(
      expect.arrayContaining([reply.id, report.id]),
    );
    const acked = await h.world.storage.getAgentMailMessage(h.environmentId, address, asked.id);
    expect(acked.ackedAt).toBeDefined();
  });

  test("mailboxes and queued mail survive a backend restart", async () => {
    const h = await harness();
    const { build } = await runningBuild(h);
    const main = await h.world.main();
    const sent = await h.world.delegate(main, worker(h.environmentId, build), "Keep me.");
    await h.world.restart();
    const listed = await h.world.storage.listAgentMailboxes({ environmentId: h.environmentId });
    expect(listed.mailboxes.map((mailbox) => mailbox.tabId)).toEqual([sent.toTabId]);
    expect(listed.mailboxes[0]!.pendingInjectCount).toBe(1);
    const turn = await endWorkerTurn(h.world.storage, h.ctx(), build);
    expect(turn.sent[0]).toContain("Keep me.");
  });

  test("a delivery claimed before a restart is reconciled against the pipeline", async () => {
    const h = await harness();
    const { build } = await runningBuild(h);
    const main = await h.world.main();
    const sent = await h.world.delegate(main, worker(h.environmentId, build), "Claimed.");
    // The claim is taken, then the backend stops before the pipeline saves.
    const claim = await h.world.mail.claimPipelineWorkerMail(
      h.environmentId,
      sent.toTabId,
      "lost-request",
    );
    expect(claim?.messageIds).toEqual([sent.id]);
    await h.world.restart();
    const back = await h.world.storage.getAgentMailMessage(h.environmentId, sent.toTabId, sent.id);
    expect(back.placement).toBe("pending-inject");
  });

  test.each(["dispatched", "absent", "unknown"] as const)(
    "interrupted steer reconciles %s without resending",
    async (outcome) => {
      const h = await harness();
      const { build } = await runningBuild(h);
      const main = await h.world.main();
      const sent = await h.world.delegate(main, worker(h.environmentId, build), "steered");
      const inbox = await h.world.storage.getAgentMailMailbox(h.environmentId, sent.toTabId);
      await h.world.storage.beginAgentMailInject(
        inbox.descriptor.mailboxId,
        sent.id,
        inbox.descriptor.incarnationId,
        undefined,
        { steerRequestId: "steer-recovery" },
      );
      await h.world.storage.recordAgentMailInjectRequest(
        inbox.descriptor.mailboxId,
        [sent.id],
        "steer-recovery",
      );
      h.provider.recoveredSteer = outcome;
      await h.world.restart();
      const recovered = await h.world.storage.getAgentMailMessage(
        h.environmentId,
        sent.toTabId,
        sent.id,
      );
      expect(recovered.placement).toBe(
        outcome === "dispatched"
          ? "injected"
          : outcome === "absent"
            ? "pending-inject"
            : "inject_failed",
      );
      expect(h.provider.steers).toHaveLength(0);
    },
  );

  test("a command node's coordinator reaches one worker on this leaf, steered", async () => {
    const h = await harness();
    const { build } = await runningBuild(h);
    // What `deliver_node_mail` does on the leaf for a send with nodeId.
    const sent = await h.world.storage.sendAgentMail(
      {
        kind: "node",
        nodeId: "bk_cmd",
        nodeName: "Office desktop",
        role: "coordinator",
        projectId: h.world.projectId,
        environmentId: "coordinator:remote:main",
        tabId: "coord-tab",
        title: null,
      },
      {
        requestId: "node-1",
        toEnvironmentId: h.environmentId,
        toTabId: pipelineWorkerTabId(build.sessionKey),
        body: "From the command node.",
      },
      { newDelegation: true, steer: true },
    );
    expect(sent.placement).toBe("pending-inject");
    await h.world.deliver();
    const steered = await h.world.storage.getAgentMailMessage(
      h.environmentId,
      sent.toTabId,
      sent.id,
    );
    expect(steered.placement).toBe("injected");
    expect(steered.injectedVia).toBe("steer");
    expect(h.provider.steers[0]!.text).toContain("From the command node.");
  });

  test("a worker's own transcript reads the same running or finished", async () => {
    const h = await harness();
    const rows = Array.from({ length: 5 }, (_, index) => ({
      id: `m${index}`,
      role: index === 0 ? "user" : "assistant",
      content: `row ${index}`,
    }));
    const build = stageSession("build", {
      key: "build",
      label: "Build Session",
      status: "idle",
      messages: rows,
    });
    const verify = stageSession("verify", { key: "verify", label: "Verify Session" });
    await h.save(
      pipelineSnapshot(h.environmentId, h.world.projectId, [build, verify], {
        phase: "verifying",
      }),
    );
    const finished = await readPipelineWorkerTranscript(h.world.storage, {
      environmentId: h.environmentId,
      ...workerAddress(build),
      limit: 2,
    });
    expect(finished.worker).toMatchObject({ step: "build", status: "finished" });
    expect((finished.messages as Array<{ id: string }>).map((row) => row.id)).toEqual(["m3", "m4"]);
    const running = await readPipelineWorkerTranscript(h.world.storage, {
      environmentId: h.environmentId,
      ...workerAddress(verify),
    });
    expect(running.worker).toMatchObject({ step: "verify", status: "running" });
    expect(running.messages).toEqual([]);
    await expect(
      readPipelineWorkerTranscript(h.world.storage, {
        environmentId: "other-environment",
        ...workerAddress(build),
      }),
    ).rejects.toThrow(/No build pipeline worker/);
  });

  test("a turn credential's result key names its own worker and no other", async () => {
    const h = await harness();
    const verify = {
      ...stageSession("verify", { key: "verify", label: "Verify Session" }),
      structuredRequestId: "result-verify",
    };
    const reviewer = stageSession("review", { key: "r1", label: "Independent Review 1" });
    await h.save(
      pipelineSnapshot(h.environmentId, h.world.projectId, [reviewer, verify], {
        phase: "verifying",
        reviewFanout: {
          reviewers: [
            {
              id: "r1",
              status: "running",
              agent: "codex",
              model: "gpt-test",
              sessionKey: reviewer.sessionKey,
              requestId: "result-reviewer",
            },
          ],
        },
      }),
    );
    const scope = { environmentId: h.environmentId, projectId: h.world.projectId };
    expect(await pipelineWorkerTabForResultKey(h.world.storage, scope, "result-verify")).toBe(
      pipelineWorkerTabId(verify.sessionKey),
    );
    expect(await pipelineWorkerTabForResultKey(h.world.storage, scope, "result-reviewer")).toBe(
      pipelineWorkerTabId(reviewer.sessionKey),
    );
    expect(await pipelineWorkerTabForResultKey(h.world.storage, scope, "unknown")).toBeNull();
    expect(
      await pipelineWorkerTabForResultKey(
        h.world.storage,
        { ...scope, environmentId: "another" },
        "result-verify",
      ),
    ).toBeNull();
  });
});

test.each(["dispatched", "absent"] as const)(
  "terminal pipeline reconciles an interrupted steer as %s",
  async (outcome) => {
    const h = await harness();
    const { build, pipeline } = await runningBuild(h);
    const main = await h.world.main();
    const sent = await h.world.delegate(main, worker(h.environmentId, build), "Interrupted steer");
    const inbox = await h.world.storage.getAgentMailMailbox(h.environmentId, sent.toTabId);
    await h.world.storage.beginAgentMailInject(
      inbox.descriptor.mailboxId,
      sent.id,
      inbox.descriptor.incarnationId,
      undefined,
      { steerRequestId: "terminal-steer" },
    );
    await h.world.storage.recordAgentMailInjectRequest(
      inbox.descriptor.mailboxId,
      [sent.id],
      "terminal-steer",
    );
    pipeline.phase = "failed";
    await h.save(pipeline);
    expect(
      (await h.world.storage.listInterruptedAgentMailInjects()).map((item) => item.message.id),
    ).toContain(sent.id);
    h.provider.recoveredSteer = outcome;
    await h.world.restart();
    const recovered = await h.world.storage.getAgentMailMessage(
      h.environmentId,
      sent.toTabId,
      sent.id,
    );
    expect(recovered.placement).toBe(outcome === "dispatched" ? "injected" : "expired");
    const notices = (
      await h.world.storage.getAgentMailMailbox(main.environmentId, main.tabId)
    ).messages.filter((message) => message.notice?.state === "mail-expired");
    expect(notices).toHaveLength(outcome === "absent" ? 1 : 0);
    expect(h.provider.steers).toHaveLength(0);
  },
);

test.each(["accepted", "returned"] as const)(
  "a claim settling %s after terminal synchronization keeps its outcome",
  async (outcome) => {
    const h = await harness();
    const { build, pipeline } = await runningBuild(h);
    const main = await h.world.main();
    const sent = await h.world.delegate(main, worker(h.environmentId, build), "Racing closure");
    // This test owns directory synchronization explicitly. Drain timer work
    // first so a competing sync cannot publish expiry before its notice finishes.
    await h.world.mail.shutdown();
    await h.world.mail.claimPipelineWorkerMail(h.environmentId, sent.toTabId, "terminal-claim");
    pipeline.phase = "complete";
    await h.save(pipeline);
    await h.world.mail.settlePipelineWorkerMail(h.environmentId, sent.toTabId, [sent.id], outcome);
    expect(
      (await h.world.storage.getAgentMailMessage(h.environmentId, sent.toTabId, sent.id)).placement,
    ).toBe(outcome === "accepted" ? "injected" : "expired");
    const notices = (
      await h.world.storage.getAgentMailMailbox(main.environmentId, main.tabId)
    ).messages.filter((message) => message.notice?.state === "mail-expired");
    expect(notices).toHaveLength(outcome === "returned" ? 1 : 0);
  },
);

test("expired command-node mail sends a notice through the node outbox", async () => {
  const h = await harness();
  const { build, pipeline } = await runningBuild(h);
  const routed: unknown[] = [];
  const outbox: unknown[] = [];
  h.world.storage.nodeMailRouter = {
    route: async (input) => {
      routed.push(input);
      return { controllerId: "bk_cmd" };
    },
    enqueue: async (destination, item) => {
      outbox.push({ destination, item });
      return { seq: 1 };
    },
  };
  const sent = await h.world.storage.sendAgentMail(
    {
      kind: "node",
      nodeId: "bk_cmd",
      nodeName: "Command node",
      role: "coordinator",
      projectId: h.world.projectId,
      environmentId: "coordinator:remote:main",
      tabId: "coord-tab",
      title: null,
    },
    {
      requestId: "node-expiry",
      toEnvironmentId: h.environmentId,
      toTabId: pipelineWorkerTabId(build.sessionKey),
      body: "Queued remote request",
    },
    { newDelegation: true },
  );
  pipeline.phase = "failed";
  await h.save(pipeline);
  expect(
    (await h.world.storage.getAgentMailMessage(h.environmentId, sent.toTabId, sent.id)).placement,
  ).toBe("expired");
  expect(routed).toEqual([
    {
      fromEnvironmentId: h.environmentId,
      fromTabId: sent.toTabId,
      toEnvironmentId: "",
      replyToMessageId: sent.id,
    },
  ]);
  expect(outbox).toEqual([
    {
      destination: { controllerId: "bk_cmd" },
      item: {
        requestId: `pipeline-worker-mail-expired:${sent.id}`,
        fromEnvironmentId: h.environmentId,
        fromTabId: sent.toTabId,
        subject: "Undelivered: your message",
        body: expect.stringContaining(sent.id),
      },
    },
  ]);
  await h.world.storage.synchronizeAgentMailboxes();
  expect(outbox).toHaveLength(1);
});

test.each(["complete", "failed"] as const)(
  "transcripts remain readable after pipeline %s",
  async (phase) => {
    const h = await harness();
    const build = stageSession("build", {
      key: "terminal-build",
      messages: [{ id: "retained", role: "assistant", content: "Retained result" }],
    });
    const pipeline = pipelineSnapshot(h.environmentId, h.world.projectId, [build]);
    await h.save(pipeline);
    pipeline.phase = phase;
    await h.save(pipeline);
    await h.world.restart();
    const mailbox = await h.world.storage.getAgentMailMailbox(
      h.environmentId,
      pipelineWorkerTabId(build.sessionKey),
    );
    expect(mailbox.descriptor.tombstonedAt).toBeDefined();
    const transcript = await readPipelineWorkerTranscript(h.world.storage, {
      environmentId: h.environmentId,
      ...workerAddress(build),
    });
    expect(transcript.messages).toEqual(build.messages);
    expect(transcript.worker).toMatchObject({
      status: phase === "complete" ? "finished" : "failed",
    });
  },
);

test.each(["applied", "rejected"] as const)(
  "steer %s settles across terminal directory sync",
  async (outcome) => {
    const h = await harness();
    const { build, pipeline } = await runningBuild(h);
    const originalProvider = h.provider.provider.bind(h.provider);
    h.provider.provider = () => ({
      ...originalProvider(),
      performSessionAction: async (_sessionId, action) => {
        if (action.kind !== "steer") throw new Error("Expected a steer action");
        pipeline.phase = "failed";
        await h.save(pipeline);
        return outcome === "rejected"
          ? { outcome, reason: "steer-capacity-exceeded", requestId: action.requestId! }
          : { outcome };
      },
    });
    const main = await h.world.main();
    const sent = await h.world.delegate(
      main,
      worker(h.environmentId, build),
      "Race with termination",
      { deliverNow: true },
    );
    const message = await h.world.storage.getAgentMailMessage(
      h.environmentId,
      sent.toTabId,
      sent.id,
    );
    expect(message.placement).toBe(outcome === "applied" ? "injected" : "expired");
    const notices = (
      await h.world.storage.getAgentMailMailbox(main.environmentId, main.tabId)
    ).messages.filter((item) => item.notice?.state === "mail-expired");
    expect(notices).toHaveLength(outcome === "rejected" ? 1 : 0);
  },
);
