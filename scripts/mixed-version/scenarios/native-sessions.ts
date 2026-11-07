/**
 * native-sessions across versions (plan item 7001): a current renderer's
 * `native-sessions` client against each node of the pair, in a worker's
 * environment, without starting an agent turn. A terminal session record is
 * created, listed, renamed and deleted; a compose draft and a file draft are
 * saved, read back and deleted at their revision; and both capability reads
 * answer: version 1 from the domain itself (every handoff capability, sync
 * protocol 1), version 0 from the node's own capability commands. The
 * renderer client is this module's own (7002's shared `renderer-client.ts`
 * can replace it once committed).
 */
import { createDomainClient } from "@orkestrator/protocol/contract/client";
import { nativeSessionsClient } from "@orkestrator/protocol/contract/domains/native-sessions";
import { InvokeError, type PeerNode } from "../harness.ts";
import { defineScenario } from "../scenario.ts";

/**
 * A current renderer's `native-sessions` client over `node`'s HTTP invoke,
 * with the envelope in the body as the web gateway client sends it; the
 * adapter is picked from the node's hello `domains`. Calls are counted per
 * adapter version here, since a renderer counts in its own window.
 */
function rendererClient(node: PeerNode) {
  const calls = new Map<number, number>();
  const client = createDomainClient(nativeSessionsClient, {
    call: async (command, args, envelope) => {
      const version = envelope?.version ?? 0;
      calls.set(version, (calls.get(version) ?? 0) + 1);
      const { status, json } = await node.request("/__orkestrator/invoke", {
        body: { command: command.name, args, ...envelope },
      });
      const payload = json as { result?: unknown; error?: unknown } | null;
      if (status !== 200) {
        const message =
          typeof payload?.error === "string" ? payload.error : JSON.stringify(payload ?? null);
        throw new InvokeError(command.name, { status, message: message.slice(0, 500) });
      }
      return payload?.result;
    },
    domains: node.hello.domains ?? null,
    invoke: (command, args) => node.invoke(command, { ...args }),
  });
  return { client, version: client.version(), calls };
}

/** 1 when `node`'s hello advertises `native-sessions` version 1, else 0. */
function expectedAdapter(node: PeerNode): 0 | 1 {
  const range = node.hello.domains?.["native-sessions"];
  return range && range.min <= 1 && range.max >= 1 ? 1 : 0;
}

const COMMANDS = [
  "create_session",
  "get_sessions_by_environment",
  "rename_session",
  "delete_session",
  "save_compose_draft",
  "get_compose_draft",
  "delete_compose_draft",
  "save_file_draft",
  "get_file_draft",
  "delete_file_draft",
  "get_native_agent_sync_capabilities",
];

export default defineScenario({
  domain: "native-sessions",
  title: "Session records, drafts and capability reads, from a current renderer",
  requires: { command: COMMANDS, leaf: COMMANDS },
  async run(ctx) {
    const nodes =
      ctx.command.build.kind === "current" ? [ctx.leaf, ctx.command] : [ctx.command, ctx.leaf];
    for (const node of nodes) {
      const tag = node.role === "command" ? "C" : "L";
      const worker = await ctx.fixtures.worker(node);
      const { client, version, calls } = rendererClient(node);
      const native = client.api();
      ctx.check(
        `NS-${tag}1`,
        `the renderer picks the adapter ${node.label}'s hello implies`,
        version === expectedAdapter(node),
        `picked ${version}`,
      );

      const tabId = `qualification-${tag.toLowerCase()}`;
      const session = await native.create_session({
        environmentId: worker.environmentId,
        containerId: "",
        tabId,
        sessionType: "plain",
      });
      const listed = await native.get_sessions_by_environment({
        environmentId: worker.environmentId,
      });
      const renamed = await native.rename_session({
        sessionId: String(session.id),
        name: "Qualification",
      });
      await native.delete_session({ sessionId: String(session.id) });
      const after = await native.get_sessions_by_environment({
        environmentId: worker.environmentId,
      });
      ctx.check(
        `NS-${tag}2`,
        "a terminal session record is created, listed, renamed and deleted",
        Array.isArray(listed) &&
          listed.some((entry) => entry.id === session.id) &&
          renamed.name === "Qualification" &&
          Array.isArray(after) &&
          !after.some((entry) => entry.id === session.id),
      );

      const draftKey = `qualification-compose-${tag.toLowerCase()}`;
      const saved = await native.save_compose_draft({
        draftKey,
        ownerType: "environment",
        ownerId: worker.environmentId,
        value: { text: "draft" },
      });
      const read = await native.get_compose_draft({ draftKey });
      await native.delete_compose_draft({
        draftKey,
        ...(typeof saved.revision === "number" ? { expectedRevision: saved.revision } : {}),
      });
      const gone = await native.get_compose_draft({ draftKey });
      ctx.check(
        `NS-${tag}3`,
        "a compose draft is saved, read back and deleted at its revision",
        read?.draftKey === draftKey && gone === null,
      );

      const fileKey = `qualification-file-${tag.toLowerCase()}`;
      const file = await native.save_file_draft({
        draftKey: fileKey,
        environmentId: worker.environmentId,
        filePath: "README.md",
        content: "changed\n",
        originalContent: "original\n",
      });
      const fileRead = await native.get_file_draft({ draftKey: fileKey });
      await native.delete_file_draft({
        draftKey: fileKey,
        ...(typeof file.revision === "number" ? { expectedRevision: file.revision } : {}),
      });
      ctx.check(
        `NS-${tag}4`,
        "a file draft is saved, read back and deleted at its revision",
        fileRead?.content === "changed\n" &&
          (await native.get_file_draft({ draftKey: fileKey })) === null,
      );

      const sync = (await native.syncCapabilities()) as {
        projectionSyncVersions?: unknown;
      } | null;
      const handoffs = await native.handoffCapabilities();
      ctx.check(
        `NS-${tag}5`,
        "the sync protocol and handoff capabilities answer (version 1: from the domain)",
        Array.isArray(sync?.projectionSyncVersions) &&
          sync.projectionSyncVersions.includes(1) &&
          (version !== 1 || (handoffs.create && handoffs.delivery && handoffs.pruning)),
      );
      ctx.note(`${node.role} native-sessions`, {
        adapter: version,
        calls: Object.fromEntries(calls),
        handoffs,
      });
    }
  },
});
