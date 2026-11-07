/**
 * Transcript artifacts and media across versions (plan item 7004): a current
 * renderer's `transcripts` client (the artifact part) against each node of
 * the pair, in a worker's environment, without an agent turn. The artifact
 * capabilities answer, the worker conversation lists no drafts and no
 * publications (owner-scoped reads of an empty conversation), a workflow run
 * that does not exist reads as unavailable, and a media pin of the worker's
 * own file returns its bytes and pins them.
 */
import { transcriptsClient } from "@orkestrator/protocol/contract/domains/transcripts";
import path from "node:path";
import { defineScenario } from "../scenario.ts";
import { expectedRendererAdapter, pairNodes, rendererClient } from "./renderer-client.ts";

const COMMANDS = [
  "transcript_artifact_capabilities",
  "transcript_artifact_list_drafts",
  "transcript_artifact_list_publications",
  "transcript_artifact_workflow_live_snapshot",
];

export default defineScenario({
  domain: "transcripts",
  title: "Transcript artifact reads and media pins, from a current renderer",
  requires: { command: COMMANDS, leaf: COMMANDS },
  async run(ctx) {
    for (const node of pairNodes(ctx.command, ctx.leaf)) {
      const tag = node.role === "command" ? "C" : "L";
      const worker = await ctx.fixtures.worker(node);
      const { client, version, calls } = rendererClient(node, transcriptsClient);
      const artifacts = client.api();
      ctx.check(
        `TA-${tag}1`,
        `the renderer picks the adapter ${node.label}'s hello implies`,
        version === expectedRendererAdapter(node, "transcripts"),
        `picked ${version}`,
      );

      const capabilities = await artifacts.artifactCapabilities({});
      ctx.check(
        `TA-${tag}2`,
        "the artifact capabilities name the backend and its rollout flags",
        typeof capabilities.backendId === "string" &&
          typeof capabilities.rolloutFlags?.artifactPublication === "boolean",
      );

      const scope = {
        environmentId: worker.environmentId,
        logicalSessionKey: `env-${worker.environmentId}:${worker.tabId}`,
      };
      const drafts: unknown = await artifacts.listDrafts(scope);
      const publications = await artifacts.listPublications(scope);
      ctx.check(
        `TA-${tag}3`,
        "an empty conversation lists no drafts and no publications",
        Array.isArray((drafts as { drafts?: unknown }).drafts) &&
          (drafts as { drafts: unknown[] }).drafts.length === 0 &&
          Array.isArray(publications.publications) &&
          publications.publications.length === 0,
      );

      const snapshot = await artifacts.workflowLiveSnapshot({
        environmentId: worker.environmentId,
        workflowId: "qualification-missing",
        runId: "qualification-missing",
      });
      ctx.check(
        `TA-${tag}4`,
        "a workflow run that does not exist reads as unavailable",
        snapshot.status === "unavailable",
      );

      if (node.has("transcript_media_pin")) {
        const pinned = await artifacts.pinMedia({
          ...scope,
          messageId: `qualification-${tag.toLowerCase()}`,
          path: path.join(worker.worktree, "README.md"),
        });
        ctx.check(
          `TA-${tag}5`,
          "a media pin of the worker's own file returns its bytes",
          typeof pinned.dataBase64 === "string" && pinned.byteLength > 0,
        );
      }
      ctx.note(`${node.role} transcript artifacts`, {
        adapter: version,
        calls: Object.fromEntries(calls),
      });
    }
  },
});
