/**
 * environments across versions (plan item 7003): a current renderer's
 * `environments` client against each node of the pair, on the worker's
 * (local) environment. The list, the snapshot list and the single reads
 * name the worker; its status, setup session, container lifecycle snapshot
 * and log storage read back; a port-mapping update and a PR record round
 * trip and are cleared again. Version 1 sends the envelope and decodes every
 * answer with the protocol schema (so a current node's records must match
 * `ClientEnvironmentSchema`); version 0 is today's call, answered as sent.
 * Nothing here starts, stops or replaces a container.
 */
import { environmentsClient } from "@orkestrator/protocol/contract/domains/environments";
import { defineScenario } from "../scenario.ts";
import { expectedRendererAdapter, pairNodes, rendererClient } from "./renderer-client.ts";

const COMMANDS = [
  "get_environments",
  "get_environment_snapshots",
  "get_environment",
  "get_environment_status",
  "get_container_lifecycle_snapshot",
  "await_environment_setup_session",
  "get_log_storage_stats",
  "update_port_mappings",
  "set_environment_pr",
  "clear_environment_pr",
];

export default defineScenario({
  domain: "environments",
  title: "Environment reads and reversible writes, from a current renderer",
  requires: { command: COMMANDS, leaf: COMMANDS },
  async run(ctx) {
    for (const node of pairNodes(ctx.command, ctx.leaf)) {
      const tag = node.role === "command" ? "C" : "L";
      const worker = await ctx.fixtures.worker(node);
      const { client, version, calls } = rendererClient(node, environmentsClient);
      const environments = client.api();
      ctx.check(
        `EN-${tag}1`,
        `the renderer picks the adapter ${node.label}'s hello implies`,
        version === expectedRendererAdapter(node, "environments"),
        `picked ${version}`,
      );

      const record = await environments.getEnvironment({ environmentId: worker.environmentId });
      const environment = record && !("finalPrState" in record) ? record : null;
      ctx.check(
        `EN-${tag}2`,
        "the worker's record reads back with its project",
        environment !== null && environment.id === worker.environmentId,
      );
      if (!environment) continue;

      const listed = await environments.getEnvironments({ projectId: environment.projectId });
      const snapshots = await environments.getEnvironmentSnapshots({
        projectId: environment.projectId,
      });
      ctx.check(
        `EN-${tag}3`,
        "the reconciled list and the snapshot list both name the worker",
        listed.some((entry) => entry.id === worker.environmentId) &&
          Array.isArray(snapshots) &&
          snapshots.some((entry) => entry.id === worker.environmentId),
      );

      const status = await environments.getEnvironmentStatus({
        environmentId: worker.environmentId,
      });
      const lifecycle = await environments.getContainerLifecycleSnapshot({
        environmentId: worker.environmentId,
      });
      const session = await environments.awaitEnvironmentSetupSession({
        environmentId: worker.environmentId,
        timeoutMs: 0,
      });
      const logs = await environments.getLogStorageStats({});
      ctx.check(
        `EN-${tag}4`,
        "status, lifecycle snapshot, setup session and log storage read back",
        typeof status === "string" &&
          typeof lifecycle.revision === "number" &&
          (session === null || session.environmentId === worker.environmentId) &&
          typeof logs.totalBytes === "number",
      );

      const mapping = { containerPort: 4173, hostPort: 0, protocol: "tcp", hostPortMode: "auto" };
      const mapped = await environments.updatePortMappings({
        environmentId: worker.environmentId,
        portMappings: [mapping],
      });
      const unmapped = await environments.updatePortMappings({
        environmentId: worker.environmentId,
        portMappings: environment.portMappings ?? [],
      });
      ctx.check(
        `EN-${tag}5`,
        "a port mapping is stored and the previous mappings restored",
        mapped.portMappings?.some((entry) => entry.containerPort === 4173) === true &&
          (unmapped.portMappings ?? []).every((entry) => entry.containerPort !== 4173),
      );

      const prUrl = "https://github.com/qualification/repository/pull/1";
      const withPr = await environments.setEnvironmentPr({
        environmentId: worker.environmentId,
        prUrl,
        prState: "open",
        hasMergeConflicts: null,
      });
      await environments.clearEnvironmentPr({ environmentId: worker.environmentId });
      const cleared = await environments.getEnvironment({ environmentId: worker.environmentId });
      // The receiver's own record, read by name, not through the client.
      const stored = (await node.invoke("get_environment", {
        environmentId: worker.environmentId,
      })) as { prUrl?: unknown } | null;
      ctx.check(
        `EN-${tag}6`,
        "a PR record is stored, then cleared on the receiving node",
        withPr.prUrl === prUrl &&
          cleared !== null &&
          !("finalPrState" in cleared) &&
          cleared.prUrl === null &&
          stored?.prUrl === null,
      );
      ctx.note(`${node.role} environments`, { adapter: version, calls: Object.fromEntries(calls) });
    }
  },
});
