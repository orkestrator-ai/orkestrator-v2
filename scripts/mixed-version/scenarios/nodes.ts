/**
 * nodes across versions (plan item 7009): a current renderer's `nodes` client
 * against each node of the pair, reading the registry, the attachment and the
 * portal, routing one read through the command node to the leaf, and reading
 * the leaf-side details a command node's coordinator asks for. Nothing
 * attaches, detaches, forgets or hands over: the pair's link is the runner's.
 *
 * - The command node reports `command` mode and lists the leaf; its portal
 *   summaries name the leaf; `invoke_on_node` routes `get_node_status` to the
 *   leaf and answers the leaf's own identity.
 * - The leaf lists the command node among its controllers and answers a
 *   worker's details and its project's seed files.
 * - Both answer their machine profile.
 * - With this checkout as the command node, a coordinator's `list_nodes` tool
 *   (`coordinator-list-nodes.ts`) lists the leaf connected with its copy of
 *   the project; a leaf that serves `get_machine_load` reports its OS, size
 *   and load once it has a reading, and an older one is shown as
 *   `older-version` over the real link; the leaf's `buildCommit` is present
 *   and is the one its hello reports, `null` for a release before the field
 *   and for a build from source (to-do 1030 (retired) tasks 2 and 7). `self` is not
 *   checked: the handler runs in this runner, so its `self.buildCommit` is the
 *   runner's own `BUILD_COMMIT`, not the command node's.
 *
 * Version 1 decodes each answer with the definitions' schemas (a node that
 * advertises `nodes`); version 0 sends today's untyped calls.
 */
import { nodesClient } from "@orkestrator/protocol/contract/domains/nodes";
import { until } from "../harness.ts";
import { defineScenario, type ScenarioContext } from "../scenario.ts";
import {
  buildCommitCheck,
  coordinatorListNodes,
  hasReadings,
  machineEvidence,
} from "./coordinator-list-nodes.ts";
import { expectedRendererAdapter, pairNodes, rendererClient } from "./renderer-client.ts";

const NO_ARGS = undefined as never;

const BOTH = ["get_node_status", "get_backend_profile"];
const COMMAND = [...BOTH, "list_nodes", "get_node_summaries", "invoke_on_node"];
const LEAF = [...BOTH, "list_controllers", "read_environment_details", "get_project_seed_files"];

export default defineScenario({
  domain: "nodes",
  title: "Registry, attachment, portal and routed reads, from a current renderer",
  requires: { command: COMMAND, leaf: LEAF },
  async run(ctx) {
    for (const node of pairNodes(ctx.command, ctx.leaf)) {
      const tag = node.role === "command" ? "C" : "L";
      const { client, version } = rendererClient(node, nodesClient);
      const nodes = client.api();
      ctx.check(
        `NO-${tag}1`,
        `the renderer picks the adapter ${node.label}'s hello implies`,
        version === expectedRendererAdapter(node, "nodes"),
        `picked ${version}`,
      );

      const status = await nodes.get_node_status(NO_ARGS);
      const profile = await nodes.get_backend_profile(NO_ARGS);
      ctx.check(
        `NO-${tag}2`,
        "the node reports its identity, mode and machine profile",
        status.nodeId === node.id &&
          status.mode === (node.role === "command" ? "command" : "leaf") &&
          typeof profile.displayName === "string" &&
          Number.isInteger(profile.revision),
        `mode ${String(status.mode)}`,
      );

      if (node.role === "command") {
        const listed = await nodes.list_nodes(NO_ARGS);
        const summaries = await nodes.get_node_summaries({});
        ctx.check(
          "NO-C3",
          "the command node lists the leaf and its portal summaries name it",
          listed.nodes.some((entry) => entry.nodeId === ctx.leaf.id) &&
            summaries.selfId === node.id &&
            summaries.nodes.some((entry) => entry.nodeId === ctx.leaf.id),
          `${listed.nodes.length} nodes, ${summaries.nodes.length} summaries`,
        );
        const routed = await nodes.invoke_on_node({
          nodeId: ctx.leaf.id,
          command: "get_node_status",
          args: {},
          requestKey: `qualification-nodes-${Date.now()}`,
        });
        ctx.check(
          "NO-C4",
          "invoke_on_node routes a read to the leaf and answers the leaf's own status",
          routed.outcome === "ok" &&
            (routed.result as { nodeId?: unknown } | null)?.nodeId === ctx.leaf.id,
          `outcome ${routed.outcome}`,
        );
        if (node.has("get_portal_layout")) {
          const layout = await nodes.get_portal_layout(NO_ARGS);
          ctx.check(
            "NO-C5",
            "the portal layout reads",
            Number.isInteger(layout.revision) && Array.isArray(layout.machineOrder),
          );
        }
        if (node.build.kind === "current") await coordinatorListNodesChecks(ctx);
      } else {
        const controllers = await nodes.list_controllers(NO_ARGS);
        ctx.check(
          "NO-L3",
          "the leaf lists the command node among its controllers",
          controllers.some((entry) => entry.controllerId === ctx.command.id),
          `${controllers.length} controllers`,
        );
        const worker = await ctx.fixtures.worker(node);
        const project = await ctx.fixtures.project(node);
        const details = await nodes.read_environment_details({
          environmentId: worker.environmentId,
          include: [],
        });
        const seeds = await nodes.get_project_seed_files({ projectId: project.projectId });
        ctx.check(
          "NO-L4",
          "the leaf answers a worker's details and its project's seed files",
          details.environmentId === worker.environmentId &&
            Array.isArray(seeds) &&
            seeds.every((entry) => typeof entry.path === "string"),
          `${Array.isArray(seeds) ? seeds.length : 0} seed files`,
        );
      }
      ctx.note(`${node.label} nodes reads`, { adapter: version });
    }
  },
});

/** NO-C6 to NO-C8: what a coordinator on this checkout's command node reads in `list_nodes`. */
async function coordinatorListNodesChecks(ctx: ScenarioContext): Promise<void> {
  const project = await ctx.fixtures.project(ctx.command);
  await ctx.fixtures.pairedOn(ctx.command, ctx.leaf);
  const servesLoad = ctx.leaf.has("get_machine_load");
  // A backend takes its first reading 15 s after it starts.
  const listed = await until(
    `list_nodes to report ${ctx.leaf.label}'s ${servesLoad ? "first load reading" : "load answer"}`,
    () => coordinatorListNodes(ctx.command, project.projectId),
    (value) => {
      const machine = value.nodes.find((entry) => entry.nodeId === ctx.leaf.id)?.machine;
      return servesLoad
        ? hasReadings(machine) && hasReadings(value.self.machine)
        : machine?.status === "unavailable";
    },
    90_000,
  );
  const leaf = listed.nodes.find((entry) => entry.nodeId === ctx.leaf.id);
  ctx.check(
    "NO-C6",
    "a coordinator's list_nodes lists the leaf connected, at its version, with its copy of the project",
    leaf?.available === true &&
      leaf.state === "connected" &&
      leaf.version === ctx.leaf.version &&
      leaf.hasProject === true,
    `${leaf?.state ?? "absent"} ${leaf?.version ?? "?"} hasProject ${String(leaf?.hasProject)}`,
  );
  ctx.check(
    "NO-C7",
    servesLoad
      ? "list_nodes reports the leaf's OS, size and load readings, and this node's"
      : "list_nodes shows an older leaf's load as older-version, over the real link",
    servesLoad
      ? hasReadings(leaf?.machine)
      : leaf?.machine.status === "unavailable" && leaf.machine.reason === "older-version",
    JSON.stringify(machineEvidence(leaf?.machine)).slice(0, 300),
  );
  // Only the leaf: `self` comes from the handler, which runs in this runner, so
  // its buildCommit is the runner's BUILD_COMMIT and would always match.
  const commit = buildCommitCheck(leaf, ctx.leaf.hello.buildCommit);
  ctx.check(
    "NO-C8",
    "list_nodes reports the leaf's buildCommit as its hello does: present, and null when the build reports none",
    commit.passed,
    `leaf ${String(commit.observed)}, hello ${String(commit.expected)}`,
  );
  ctx.note("coordinator list_nodes", {
    self: {
      version: listed.self.version,
      runnerBuildCommit: listed.self.buildCommit,
      machine: machineEvidence(listed.self.machine),
    },
    command: { helloBuildCommit: ctx.command.hello.buildCommit ?? null },
    leaf: {
      version: leaf?.version ?? null,
      buildCommit: commit.observed,
      helloBuildCommit: commit.expected,
      machine: machineEvidence(leaf?.machine),
    },
  });
}
