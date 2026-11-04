/**
 * Real-stack QA for command nodes (docs/development/command-nodes-plan.md,
 * "Final verification").
 *
 * Starts four isolated backends from source, each with a temporary data
 * directory, a loopback listener on an ephemeral port and a private random
 * gateway token (never printed):
 *
 *   - Desk:   the command node (--command-node);
 *   - Leaf:   a standalone node Desk attaches;
 *   - Middle: a command node with its own subordinate, which Desk attaches,
 *             so Middle switches to leaf mode;
 *   - Sub:    Middle's subordinate.
 *
 * Then it checks, asserting each step, the behaviour the requirement matrix
 * names (AT, RM, PT, DP, CO, FL, SC rows). Only processes this script started
 * are stopped; nothing else is touched. Logs of every backend are scanned for
 * the tokens and the `.env` values it used.
 *
 * Run: bun scripts/qa-command-nodes.ts
 */
import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import {
  addNode,
  children,
  invoke,
  makeNode,
  project,
  qaRun,
  request,
  start,
  stop,
  until,
} from "./qa-command-nodes-support.js";

const { check, results, log } = qaRun("command-nodes-qa");

const ENV_SECRET_DESK = `desk-secret-${randomBytes(6).toString("hex")}`;
const ENV_SECRET_LEAF = `leaf-secret-${randomBytes(6).toString("hex")}`;

async function main() {
  const desk = await makeNode("Desk", true);
  const leaf = await makeNode("Leaf", false);
  const middle = await makeNode("Middle", false);
  const sub = await makeNode("Sub", false);
  const nodes = [desk, leaf, middle, sub];
  try {
    await Promise.all(nodes.map((node) => start(node)));
    for (const node of nodes) {
      node.id = (await invoke<{ nodeId: string }>(node, "get_node_status")).nodeId;
      const profile = await invoke<{ revision: number }>(node, "get_backend_profile");
      await invoke(node, "update_backend_profile", {
        expectedRevision: profile.revision,
        displayName: node.name,
      });
    }
    log("four backends started");

    const deskProject = await project(desk, {
      ".env": `API_KEY=${ENV_SECRET_DESK}\nSHARED=1\n`,
      "fixtures/data.json": '{"from":"desk"}',
    });
    const leafProject = await project(leaf, {
      ".env": `API_KEY=${ENV_SECRET_LEAF}\nSHARED=1\nLEAF_ONLY=1\n`,
    });
    const leafEnvironment = await invoke<{ id: string }>(leaf, "create_environment", {
      projectId: leafProject.id,
      name: "feature-a",
      environmentType: "local",
    });

    // RM-02 / RM-07: a standalone node needs the setting; then Middle commands Sub.
    let refused = "";
    try {
      await addNode(middle, sub);
    } catch (error) {
      refused = String(error);
    }
    check(
      "RM-02",
      "a standalone node cannot register nodes until the setting is on",
      refused.includes("registration-disabled"),
    );
    await invoke(middle, "set_command_node_enabled", { enabled: true });
    await addNode(middle, sub);
    check(
      "RM-01",
      "Middle becomes a command node by registering Sub",
      (await invoke<{ mode: string }>(middle, "get_node_status")).mode === "command",
    );

    // AT-01 / AT-03 / AT-04: Desk attaches Leaf.
    const leafView = await addNode(desk, leaf);
    check(
      "AT-01",
      "Desk attaches Leaf over a verified route",
      leafView.connection.state === "connected",
    );
    const leafStatus = await invoke<{ mode: string; controllers: Array<{ controllerId: string }> }>(
      leaf,
      "get_node_status",
    );
    check(
      "AT-01",
      "Leaf records Desk as its controller and is in leaf mode",
      leafStatus.mode === "leaf" && leafStatus.controllers[0]?.controllerId === desk.id,
    );

    // RM-03 / MG-02: Desk attaches Middle, which switches to leaf mode.
    const middleView = await addNode(desk, middle);
    const middleStatus = await invoke<{ mode: string; suspendedSubordinateCount: number }>(
      middle,
      "get_node_status",
    );
    check(
      "RM-03",
      "Middle switches to leaf mode and suspends its subordinate",
      middleView.connection.remoteMode === "leaf" &&
        middleStatus.mode === "leaf" &&
        middleStatus.suspendedSubordinateCount === 1,
    );
    const middleNodes = await invoke<{ nodes: Array<{ connection: { state: string } }> }>(
      middle,
      "list_nodes",
    );
    check(
      "RM-03",
      "Middle keeps Sub registered but does not control it",
      middleNodes.nodes[0]?.connection.state === "suspended",
    );
    refused = "";
    try {
      await addNode(middle, leaf);
    } catch (error) {
      refused = String(error);
    }
    check(
      "RM-07",
      "a node in leaf mode cannot register nodes",
      refused.includes("node-is-subordinate"),
    );

    // PT-01 / PT-02: the portal shows Leaf's environment, node-qualified.
    const summaries = await until(
      "Leaf summaries on Desk",
      () =>
        invoke<{
          nodes: Array<{
            nodeId: string;
            environments: Array<{ ref: { backendId: string; environmentId: string } }>;
          }>;
        }>(desk, "get_node_summaries"),
      (value) =>
        value.nodes.some((node) => node.nodeId === leaf.id && node.environments.length === 1),
    );
    const leafSummary = summaries.nodes.find((node) => node.nodeId === leaf.id)!;
    check(
      "PT-02",
      "Leaf's environment is node-qualified in Desk's portal",
      leafSummary.environments[0]!.ref.backendId === leaf.id &&
        leafSummary.environments[0]!.ref.environmentId === leafEnvironment.id,
    );
    const middleSummary = summaries.nodes.find((node) => node.nodeId === middle.id);
    check(
      "RM-04",
      "Desk sees only Middle's own state, never Sub",
      Boolean(middleSummary) && !summaries.nodes.some((node) => node.nodeId === sub.id),
    );

    // RG-02: no view or status carries a leaf token.
    const listed = JSON.stringify(await invoke(desk, "list_nodes"));
    check(
      "RG-02",
      "Desk's node views carry no leaf token",
      !listed.includes(leaf.token) && !listed.includes(middle.token),
    );

    // DP-01 / DP-02: a workspace grant reaches Leaf directly, for the client API only.
    const workspace = await invoke<{
      workspaceId: string;
      grant: { token: string };
      directOrigins: string[];
      relayBase: string;
    }>(desk, "open_node_workspace", { nodeId: leaf.id });
    check("DP-02", "the grant is not Leaf's gateway token", workspace.grant.token !== leaf.token);
    const direct = await request(leaf, "/__orkestrator/hello", { token: workspace.grant.token });
    check("DP-01", "a client reaches Leaf directly with the grant", direct.status === 200);
    const adminWithGrant = await request(leaf, "/__orkestrator/invoke", {
      token: workspace.grant.token,
      body: { command: "create_client_grant", args: {} },
    });
    check("DP-02", "the grant cannot run administrative commands", adminWithGrant.status === 403);
    const settingsWithGrant = await request(leaf, "/__orkestrator/gateway-settings", {
      token: workspace.grant.token,
    });
    check(
      "DP-02",
      "the grant cannot read the leaf's gateway settings",
      settingsWithGrant.status === 403,
    );

    // DP-03: the relay reaches Leaf with Desk's own credential.
    const relayed = await request(desk, `${workspace.relayBase}/__orkestrator/invoke`, {
      body: { command: "get_projects", args: {} },
    });
    check(
      "DP-03",
      "the relay forwards a client command to Leaf",
      relayed.status === 200 && JSON.stringify(relayed.json).includes(leafProject.id),
    );
    await invoke(desk, "close_node_workspace", { workspaceId: workspace.workspaceId });
    const afterClose = await request(leaf, "/__orkestrator/hello", {
      token: workspace.grant.token,
    });
    check("DP-02", "closing the workspace revokes the grant", afterClose.status === 401);

    // FL-06: compare the project's files without revealing values.
    const comparison = await invoke<{
      nodes: Array<{
        nodeId: string;
        files: Array<{
          path: string;
          status: string;
          keys?: { added: string[]; changed: string[] };
        }>;
      }>;
    }>(desk, "compare_project_files", { projectId: deskProject.id });
    const leafFiles = comparison.nodes.find((node) => node.nodeId === leaf.id)!;
    const env = leafFiles.files.find((file) => file.path === ".env")!;
    check(
      "FL-06",
      "the comparison names changed and added keys",
      env.status === "differs" &&
        env.keys!.changed.includes("API_KEY") &&
        env.keys!.added.includes("LEAF_ONLY"),
    );
    const comparisonText = JSON.stringify(comparison);
    check(
      "FL-06",
      "the comparison carries no .env value",
      !comparisonText.includes(ENV_SECRET_DESK) && !comparisonText.includes(ENV_SECRET_LEAF),
    );

    // FL-01: transfer a file from Desk's project to Leaf's.
    const receipt = await invoke<{ status: string; bytes: number }>(desk, "transfer_node_files", {
      from: { nodeId: desk.id, scope: { projectId: deskProject.id } },
      to: { nodeId: leaf.id, scope: { projectId: leafProject.id } },
      files: ["fixtures/data.json"],
      overwrite: false,
      actor: "qa",
    });
    check(
      "FL-01",
      "a file moves node to node with a receipt",
      receipt.status === "completed" &&
        (await readFile(path.join(leafProject.dir, "fixtures/data.json"), "utf8")) ===
          '{"from":"desk"}',
    );

    // CO-04: a deletion only happens after the user approves the request.
    const deletion = await invoke<{ requestId: string }>(desk, "create_node_action_request", {
      kind: "delete-environment",
      targets: [
        {
          nodeId: leaf.id,
          nodeName: "Leaf",
          environmentId: leafEnvironment.id,
          environmentName: "feature-a",
        },
      ],
      requestedBy: {
        coordinatorEnvironmentId: "coordinator:qa:main",
        coordinatorTabId: "qa",
        projectId: deskProject.id,
      },
      reason: "QA",
    });
    const stillThere = await invoke<Array<{ id: string }>>(leaf, "get_environment_snapshots", {
      projectId: leafProject.id,
    });
    check(
      "CO-04",
      "a pending deletion request deletes nothing",
      stillThere.some((entry) => entry.id === leafEnvironment.id),
    );
    await invoke(desk, "resolve_node_action_request", {
      requestId: deletion.requestId,
      decision: "approve",
    });
    await until(
      "deletion on Leaf",
      () =>
        invoke<Array<{ id: string }>>(leaf, "get_environment_snapshots", {
          projectId: leafProject.id,
        }),
      (value) => !value.some((entry) => entry.id === leafEnvironment.id),
      90_000,
    );
    check("CO-04", "the approved deletion ran on Leaf", true);

    // PT-04: an unavailable node keeps labelled last-known state.
    await stop(leaf);
    await invoke(desk, "reconnect_node", { nodeId: leaf.id }).catch(() => undefined);
    const offline = await until(
      "Leaf unavailable on Desk",
      () =>
        invoke<{ nodes: Array<{ nodeId: string; available: boolean; freshness: string }> }>(
          desk,
          "get_node_summaries",
          { nodeIds: [leaf.id] },
        ),
      (value) => value.nodes[0]?.available === false,
    );
    check(
      "PT-04",
      "Leaf shows as unavailable with stale state",
      offline.nodes[0]!.freshness === "stale",
    );
    let writeRefused = "";
    try {
      await invoke(desk, "invoke_on_node", {
        nodeId: leaf.id,
        command: "stop_environment",
        args: { environmentId: "x" },
      });
    } catch (error) {
      writeRefused = String(error);
    }
    check(
      "PT-04",
      "writes to an unavailable node are refused",
      writeRefused.includes("changes to it are disabled"),
    );
    await start(leaf);
    await invoke(desk, "reconnect_node", { nodeId: leaf.id });
    check(
      "RG-03",
      "Leaf reconnects after a restart with the same identity",
      (
        await invoke<{ nodes: Array<{ nodeId: string; connection: { state: string } }> }>(
          desk,
          "list_nodes",
        )
      ).nodes.find((node) => node.nodeId === leaf.id)?.connection.state === "connected",
    );

    // AT-02 / RG-07: forgetting detaches and stops nothing.
    await invoke(desk, "forget_node", { nodeId: middle.id });
    const middleAfter = await invoke<{ mode: string }>(middle, "get_node_status");
    check(
      "AT-02",
      "forgetting Middle detaches it, and it is a command node again",
      middleAfter.mode === "command",
    );

    // SC-04: no token or .env value in any backend's output.
    const secrets = [
      desk.token,
      leaf.token,
      middle.token,
      sub.token,
      workspace.grant.token,
      ENV_SECRET_DESK,
      ENV_SECRET_LEAF,
    ];
    const leaked = nodes.filter((node) =>
      secrets.some((secret) => node.output.join("").includes(secret)),
    );
    check(
      "SC-04",
      "no backend logged a token, grant or .env value",
      leaked.length === 0,
      leaked.map((node) => node.name).join(", "),
    );
  } finally {
    await Promise.all(nodes.map((node) => stop(node).catch(() => undefined)));
    await Promise.all(
      nodes.map((node) => rm(node.dir, { recursive: true, force: true }).catch(() => undefined)),
    );
  }
  const failed = results.filter((entry) => !entry.ok);
  log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch(async (error: unknown) => {
  console.error("[command-nodes-qa]", error instanceof Error ? error.message : error);
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  process.exit(1);
});
