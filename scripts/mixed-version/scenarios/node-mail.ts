/**
 * node-mail across versions (plan item 1010's pilot): coordinator mail down to
 * a worker with and without `steer`, a retry by `requestId`, and coordinator
 * mail up through the leaf's outbox (collect and ack).
 */
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import { repositoryHint } from "@orkestrator/protocol/node-summaries";

import { coordinatorScope, REPOSITORY_URL, type CoordinatorFixture } from "../fixtures.ts";
import { until, type PeerNode } from "../harness.ts";
import { defineScenario, type ScenarioContext } from "../scenario.ts";

type MailMessage = { id: string; requestId?: string; from?: { nodeId?: string } };

/** Messages that carry `tag` (each send's own requestId) in any field. */
const tagged = (messages: readonly MailMessage[], tag: string) =>
  messages.filter((message) => JSON.stringify(message).includes(tag));

async function mailbox(node: PeerNode, environmentId: string, tabId: string) {
  const snapshot = await node.invoke<{ messages: MailMessage[] }>("get_agent_mail_mailbox", {
    environmentId,
    tabId,
  });
  return snapshot.messages;
}

const coordinatorMailbox = (of: CoordinatorFixture) =>
  mailbox(of.node, coordinatorRuntimeId(of.coordinatorId, of.conversationId), of.tabId);

const capability = (node: PeerNode, name: string) =>
  node.build.kind === "current" || (node.hello.capabilities?.[name] ?? 0) >= 1;

async function adapterCheck(ctx: ScenarioContext) {
  const expected = ctx.expectedAdapter("node-mail");
  const v0 = await ctx.adapterCallsSince("node-mail", 0);
  if (expected === null || v0 === null) return;
  ctx.check(
    "NM-08",
    expected === 0
      ? "the command node reached the pre-contract leaf through the node-mail v0 adapter"
      : "the command node used node-mail v1 (no v0 adapter call)",
    expected === 0 ? v0 > 0 : v0 === 0,
    `v0 calls ${v0}`,
  );
}

export default defineScenario({
  domain: "node-mail",
  title: "Coordinator mail down (steer, retry) and up through the leaf outbox",
  requires: {
    command: [
      "send_coordinator_node_mail",
      "ensure_project_coordinator",
      "assign_coordinator_conversation_agent",
      "get_agent_mail_mailbox",
      "get_agent_mail_message",
    ],
    leaf: ["deliver_node_mail", "collect_node_outbox", "ack_node_outbox", "get_agent_mail_mailbox"],
  },
  async run(ctx) {
    const { command, leaf, fixtures } = ctx;
    const from = await fixtures.coordinator(command);
    const worker = await fixtures.worker(leaf);
    const marker = `nm-${Date.now().toString(36)}`;

    // Down, no steer.
    const args = {
      scope: coordinatorScope(from),
      nodeId: leaf.id,
      requestId: `${marker}-plain`,
      toEnvironmentId: worker.environmentId,
      toTabId: worker.tabId,
      body: `Plain mail ${marker}.`,
    };
    const sent = await command.invoke<{ messageId?: string; placement?: string }>(
      "send_coordinator_node_mail",
      args,
    );
    ctx.note("down without steer", { placement: sent.placement, messageId: !!sent.messageId });
    const inbox = await until(
      "the worker's copy",
      () => mailbox(leaf, worker.environmentId, worker.tabId),
      (messages) => tagged(messages, `${marker}-plain`).length > 0,
      30_000,
    );
    const stored = tagged(inbox, `${marker}-plain`);
    ctx.check(
      "NM-01",
      "the leaf stored one message for the worker, under the id the command node reported",
      stored.length === 1 && (!sent.messageId || stored[0]!.id === sent.messageId),
      `${stored.length} stored`,
    );

    const retried = await command.invoke<{ messageId?: string }>(
      "send_coordinator_node_mail",
      args,
    );
    const afterRetry = tagged(
      await mailbox(leaf, worker.environmentId, worker.tabId),
      `${marker}-plain`,
    );
    ctx.check(
      "NM-02",
      "a retry with the same requestId delivers nothing new",
      afterRetry.length === 1 && retried.messageId === sent.messageId,
      `${afterRetry.length} stored`,
    );

    // Down, deliverNow (steer on a leaf that takes it).
    const steers = capability(leaf, "node-mail-steer");
    const steered = await command.invoke<{ messageId?: string; deliverNow?: unknown }>(
      "send_coordinator_node_mail",
      { ...args, requestId: `${marker}-steer`, body: `Steered mail ${marker}.`, deliverNow: true },
    );
    const steeredInbox = await until(
      "the steered copy",
      () => mailbox(leaf, worker.environmentId, worker.tabId),
      (messages) => tagged(messages, `${marker}-steer`).length > 0,
      30_000,
    );
    ctx.check(
      "NM-03",
      "mail sent with deliverNow reaches the worker's mailbox",
      tagged(steeredInbox, `${marker}-steer`).length === 1,
    );
    ctx.note("down with deliverNow", {
      leafTakesSteer: steers,
      leafOutcomeReported: steered.deliverNow !== undefined,
    });
    if (command.build.kind === "current") {
      ctx.check(
        "NM-04",
        steers
          ? "the leaf took steer and reported its deliverNow outcome"
          : "steer was left out for a leaf without node-mail-steer (no outcome reported)",
        steers ? steered.deliverNow !== undefined : steered.deliverNow === undefined,
        JSON.stringify(steered.deliverNow ?? null).slice(0, 200),
      );
    }

    // Up: the leaf's coordinator mails the command node's coordinator (older
    // releases have no upward coordinator mail).
    if (!leaf.has("send_coordinator_command_node_mail")) {
      ctx.note("up", { skipped: "the leaf has no send_coordinator_command_node_mail" });
    } else {
      const up = await fixtures.coordinator(leaf);
      const queued = await leaf.invoke<{ placement?: string }>(
        "send_coordinator_command_node_mail",
        {
          scope: coordinatorScope(up),
          requestId: `${marker}-up`,
          body: `Upward mail ${marker}.`,
        },
      );
      ctx.check(
        "NM-05",
        "the leaf queues upward coordinator mail in its outbox",
        queued.placement === "node-outbox",
        String(queued.placement),
      );
      const upward = async () => {
        const environmentId = coordinatorRuntimeId(from.coordinatorId, from.conversationId);
        const fromLeaf = (await coordinatorMailbox(from)).filter(
          (message) => message.from?.nodeId === leaf.id,
        );
        // The mailbox lists no bodies; read each message the leaf sent.
        const bodies = await Promise.all(
          fromLeaf.map((message) =>
            command
              .invoke<{ body?: string }>("get_agent_mail_message", {
                environmentId,
                tabId: from.tabId,
                messageId: message.id,
              })
              .then((read) => read?.body ?? ""),
          ),
        );
        return bodies.filter((body) => body.includes(`Upward mail ${marker}`)).length;
      };
      // Peeked the way the command node collects, with the keys both sides
      // take (a pre-contract leaf refuses an unknown key).
      const notices =
        capability(leaf, "coordinator-notices") && capability(command, "coordinator-notices");
      const hint = repositoryHint(REPOSITORY_URL);
      const queuedUp = () =>
        leaf
          .invoke<{ items: unknown[] }>("collect_node_outbox", {
            controllerId: command.id,
            after: 0,
            coordinatorMail: true,
            ...(notices ? { coordinatorNotices: { repositoryHints: hint ? [hint] : [] } } : {}),
          })
          .then((outbox) => JSON.stringify(outbox.items).includes(marker));

      if (!capability(command, "node-coordinator-mail")) {
        // A command node without coordinator mail never asks for it, so the
        // leaf keeps it queued for when that node is updated.
        await Bun.sleep(10_000);
        const held = await queuedUp();
        const delivered = await upward();
        ctx.note("up to a command node without node-coordinator-mail", { held, delivered });
        ctx.check(
          "NM-06",
          "for a command node without node-coordinator-mail, the leaf keeps the mail queued (not delivered, not dropped)",
          held && delivered === 0,
          `held ${held}, delivered ${delivered}`,
        );
      } else {
        const arrived = await until(
          "the command node collecting the upward mail",
          upward,
          (count) => count > 0,
          120_000,
        ).catch(() => 0);
        ctx.check(
          "NM-06",
          "the command node collected the leaf's outbox mail into its coordinator's mailbox",
          arrived === 1,
          `${arrived} copies`,
        );
        const stillQueued = await until(
          "the leaf's outbox to drop the acked mail",
          queuedUp,
          (queuedNow) => !queuedNow,
          30_000,
        ).catch((error: unknown) => String(error).slice(0, 200));
        ctx.check(
          "NM-07",
          "the leaf's outbox no longer holds the collected mail (acked)",
          stillQueued === false,
          String(stillQueued),
        );
      }
    }

    await adapterCheck(ctx);
  },
});
