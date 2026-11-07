/**
 * git across versions (plan item 7006): a current renderer's `git` client
 * against each node of the pair, in a worker's worktree. The Files panel's
 * git status (bare and conditional) shows a file written for the scenario,
 * the diff-stat snapshot answers its bare and conditional forms, the
 * "Compare against" menu lists the checkout's branches, and a node that runs
 * change tracking answers the environment's change view. A node with the
 * domain gets version 1; a pre-contract node gets today's bodies through
 * version 0. Nothing here fetches, pushes or reaches GitHub.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { environmentChangeResourceKey } from "@orkestrator/protocol/change-resources";
import { gitClient } from "@orkestrator/protocol/contract/domains/git";
import { defineScenario } from "../scenario.ts";
import { expectedRendererAdapter, pairNodes, rendererClient } from "./renderer-client.ts";

const COMMON = [
  "get_local_git_status",
  "get_environment_diff_stats",
  "list_environment_diff_base_branches",
];

export default defineScenario({
  domain: "git",
  title:
    "Git status, diff stats, diff bases and the change view in a worktree, from a current renderer",
  requires: { command: COMMON, leaf: COMMON },
  async run(ctx) {
    for (const node of pairNodes(ctx.command, ctx.leaf)) {
      const tag = node.role === "command" ? "C" : "L";
      const worker = await ctx.fixtures.worker(node);
      const gitApi = rendererClient(node, gitClient);
      ctx.check(
        `GI-${tag}1`,
        `the renderer picks the adapter ${node.label}'s hello implies`,
        gitApi.version === expectedRendererAdapter(node, "git"),
        `picked ${gitApi.version}`,
      );
      const git = gitApi.client.api();

      const file = `qualification-git-${tag.toLowerCase()}.txt`;
      await writeFile(path.join(worker.worktree, file), "changed\n");
      const status = await git.get_local_git_status({
        worktreePath: worker.worktree,
        targetBranch: "main",
      });
      const conditional = await git.get_local_git_status({
        worktreePath: worker.worktree,
        targetBranch: "main",
        knownDigest: "",
      });
      ctx.check(
        `GI-${tag}2`,
        "the git status lists the new file bare, and answers conditionally with a digest",
        Array.isArray(status) &&
          status.some((change) => change.path === file) &&
          !Array.isArray(conditional) &&
          typeof conditional.digest === "string",
      );

      const stats = await git.get_environment_diff_stats({});
      const statsStamp =
        !Array.isArray(stats) && "entries" in stats && typeof stats.generation === "string"
          ? { generation: stats.generation, revision: stats.revision ?? 0 }
          : null;
      const statsAgain = statsStamp
        ? await git.get_environment_diff_stats({
            knownGeneration: statsStamp.generation,
            knownRevision: statsStamp.revision,
          })
        : null;
      ctx.check(
        `GI-${tag}3`,
        "the diff-stat snapshot reads bare, and conditionally when it is stamped",
        "entries" in stats &&
          Array.isArray(stats.entries) &&
          (statsAgain === null || "status" in statsAgain),
      );

      const branches = await git.list_environment_diff_base_branches({
        environmentId: worker.environmentId,
      });
      ctx.check(
        `GI-${tag}4`,
        "the Compare against menu lists the checkout's branches",
        branches.some((branch) => branch.name === "main" || branch.name.endsWith("/main")),
        branches.map((branch) => branch.name).join(", "),
      );

      const capabilities = await git.changes_get_capabilities({}).then(
        (answer) => answer,
        () => null,
      );
      if (capabilities) {
        const view = await git.changes_get_view({
          resourceKey: environmentChangeResourceKey(worker.environmentId),
        });
        ctx.check(
          `GI-${tag}5`,
          "a node with change tracking answers the environment's change view",
          typeof view.kind === "string",
          view.kind,
        );
      } else {
        ctx.note(`${node.role} change tracking`, { available: false });
      }

      ctx.note(`${node.role} git`, {
        adapter: gitApi.version,
        calls: Object.fromEntries(gitApi.calls),
      });
    }
  },
});
