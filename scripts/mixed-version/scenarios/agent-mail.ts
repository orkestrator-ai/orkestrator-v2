/**
 * agent-mail across versions (plan item 7008): a current renderer's
 * `agent-mail` client against each node of the pair, on a worker tab of the
 * node's own fixture project. No agent is woken: the worker's mailbox is set
 * to inject nothing (`inject: "off"`) before the person's mail is sent, and
 * restored to the inherited policy at the end (the runtime is `agent-test`,
 * which starts none either).
 *
 * On each node: the agent registry lists the worker tab and the directory its
 * mailbox; the person's mail is sent, and a retry with the same `requestId`
 * returns the same message; the worker's mailbox lists it, its body reads
 * back, it is marked seen and acknowledged; the person's sent mail and the
 * conversations list it; the messaging settings and summary are read. A
 * pre-contract node gets today's calls through version 0. Commands a release
 * predates are skipped, by name.
 */
import { agentMailClient } from "@orkestrator/protocol/contract/domains/agent-mail";
import { defineScenario } from "../scenario.ts";
import { expectedRendererAdapter, pairNodes, rendererClient } from "./renderer-client.ts";

const COMMANDS = [
  "get_agent_registry",
  "list_agent_mailboxes",
  "mute_agent_mail",
  "send_agent_mail",
  "get_agent_mail_mailbox",
  "get_agent_mail_message",
  "mark_agent_mail_seen",
  "ack_agent_mail",
];

export default defineScenario({
  domain: "agent-mail",
  title:
    "Registry, directory, the person's mail to a worker and its reading, from a current renderer",
  requires: { command: COMMANDS, leaf: COMMANDS },
  async run(ctx) {
    for (const node of pairNodes(ctx.command, ctx.leaf)) {
      const tag = node.role === "command" ? "C" : "L";
      const worker = await ctx.fixtures.worker(node);
      const { client, version, calls } = rendererClient(node, agentMailClient);
      const mail = client.api();
      const skipped: string[] = [];
      const has = (command: string) => {
        if (node.has(command)) return true;
        skipped.push(command);
        return false;
      };
      ctx.check(
        `AM-${tag}1`,
        `the renderer picks the adapter ${node.label}'s hello implies`,
        version === expectedRendererAdapter(node, "agent-mail"),
        `picked ${version}`,
      );

      const registry = await mail.get_agent_registry({ environmentId: worker.environmentId });
      const directory = await mail.list_agent_mailboxes({ environmentId: worker.environmentId });
      ctx.check(
        `AM-${tag}2`,
        "the registry lists the worker tab and the directory its mailbox",
        registry.entries.some((entry) => entry.tabId === worker.tabId) &&
          directory.mailboxes.some((entry) => entry.tabId === worker.tabId),
        `${registry.entries.length} tabs, ${directory.mailboxes.length} mailboxes`,
      );

      const address = { environmentId: worker.environmentId, tabId: worker.tabId };
      const held = await mail.mute_agent_mail({ ...address, inject: "off" });
      const requestId = `qualification-mail-${tag}-${Date.now()}`;
      const send = {
        requestId,
        toEnvironmentId: worker.environmentId,
        toTabId: worker.tabId,
        subject: "Qualification",
        body: `qualification mail ${tag}`,
      };
      const sent = await mail.send_agent_mail(send);
      const again = await mail.send_agent_mail(send);
      ctx.check(
        `AM-${tag}3`,
        "the person's mail is accepted without waking the worker, and a retry by requestId is the same message",
        held.injectPolicy === "off" && again.id === sent.id && sent.requestId === requestId,
        `placement ${sent.placement}`,
      );

      const page = await mail.get_agent_mail_mailbox({ ...address, limit: 200 });
      const read = await mail.get_agent_mail_message({ ...address, messageId: sent.id });
      ctx.check(
        `AM-${tag}4`,
        "the worker's mailbox lists the message and its body reads back",
        page.messages.some((entry) => entry.id === sent.id) && read.body === send.body,
      );

      const seen = await mail.mark_agent_mail_seen({ ...address, messageId: sent.id });
      const acked = await mail.ack_agent_mail({ ...address, messageId: sent.id });
      ctx.check(
        `AM-${tag}5`,
        "the message is marked seen by the person and acknowledged for the agent",
        seen.id === sent.id && acked.id === sent.id && typeof acked.ackedAt === "string",
      );

      if (has("list_agent_mail_sent") && has("list_agent_mail_conversations")) {
        const outbox = await mail.list_agent_mail_sent({});
        const conversations = await mail.list_agent_mail_conversations({});
        ctx.check(
          `AM-${tag}6`,
          "the person's sent mail and the conversations list it",
          outbox.some((entry) => entry.id === sent.id) &&
            conversations.conversations.some((entry) => entry.lastMessage.id === sent.id),
        );
      }
      if (has("get_agent_messaging_settings") && has("get_agent_mail_summary")) {
        const settings = await mail.get_agent_messaging_settings({});
        const summary = await mail.get_agent_mail_summary({});
        ctx.check(
          `AM-${tag}7`,
          "the messaging settings and the summary are read",
          settings.enabled && summary.mailboxes.some((entry) => entry.tabId === worker.tabId),
        );
      }
      await mail.mute_agent_mail({ ...address, inject: "inherit" });
      ctx.note(`${node.role} agent-mail`, {
        adapter: version,
        calls: Object.fromEntries(calls),
        skipped,
      });
    }
  },
});
