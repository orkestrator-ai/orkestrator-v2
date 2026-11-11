import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BACKEND_HELLO_PATH } from "@orkestrator/protocol/backend-profile";
import { APP_VERSION, BUILD_COMMIT } from "../constants.js";
import { registerNodeTools } from "./nodes.js";
import {
  stopTestNodeNetworks,
  settle,
  TestNodeNetwork,
  type TestNode,
} from "../nodes/node-network-test-support.js";

afterEach(stopTestNodeNetworks);

/**
 * The `version` and `buildCommit` of `list_nodes`, read through the real node links and the real
 * portal read model: only the leaf's hello is scripted.
 */

interface ListedNode {
  nodeId: string;
  available: boolean;
  state: string;
  version: string | null;
  buildCommit: string | null;
}

interface Listed {
  self: { nodeId: string; version: string; buildCommit: string | null };
  nodes: ListedNode[];
}

const LEAF_ID = "bk_leaf";
const COMMIT = "abc1234";

describe("list_nodes version", () => {
  let network: TestNodeNetwork;
  let command: TestNode;
  let leaf: TestNode;
  let description = "";
  let listNodes: () => Promise<Listed>;

  beforeEach(async () => {
    network = new TestNodeNetwork();
    command = await network.add("command", { forceRegistration: true });
    leaf = await network.add("leaf");
    const tools = new Map<string, () => Promise<{ structuredContent: unknown }>>();
    registerNodeTools(
      {
        registerTool: (name: string, config: { description: string }, handler: never) => {
          if (name === "list_nodes") description = config.description;
          tools.set(name, handler);
        },
      } as never,
      (async (name: string, args: Record<string, unknown> = {}) => {
        switch (name) {
          case "get_node_status":
            return command.service.status();
          case "get_projects":
            return [];
          case "get_node_summaries":
            return command.portal.summaries(args.nodeIds);
          default:
            throw new Error(`Not under test: ${name}`);
        }
      }) as never,
      { projectId: "project-1", coordinatorId: "c1", conversationId: "conv-1" },
    );
    listNodes = async () => (await tools.get("list_nodes")!()).structuredContent as Listed;
  });

  afterEach(async () => {
    await network.stop();
  });

  async function attach() {
    await command.service.addNode({
      routes: [{ id: "primary" as never, kind: "https", enabled: true, origin: leaf.origin }],
      token: leaf.token,
    });
  }

  const listedLeaf = async () => (await listNodes()).nodes.find((n) => n.nodeId === LEAF_ID)!;

  /** Run the link's due heartbeat or reconnect until it has settled. */
  async function runLink() {
    for (let round = 0; round < 3; round += 1) {
      network.timers.runAll();
      await settle();
    }
  }

  test("reports this machine's version and a connected leaf's from its hello", async () => {
    leaf.helloOverrides = { appVersion: "2.30.1-beta" };
    await attach();
    const listed = await listNodes();
    expect(listed.self.version).toBe(APP_VERSION);
    expect(listed.nodes).toEqual([
      expect.objectContaining({ nodeId: LEAF_ID, available: true, version: "2.30.1-beta" }),
    ]);
  });

  test("a leaf on an older build reports its version from the hello it already sends", async () => {
    leaf.helloOverrides = {
      appVersion: "2.12.0",
      capabilities: { "node-attachment": 1 },
      nodeMode: undefined,
      authorizationScopeId: undefined,
    };
    const hello = (await (
      await network.fetch(`${leaf.origin}${BACKEND_HELLO_PATH}`, {
        headers: { authorization: `Bearer ${leaf.token}` },
      })
    ).json()) as Record<string, unknown>;
    expect(Object.keys(hello).sort()).toEqual([
      "appVersion",
      "capabilities",
      "clientApi",
      "endpointRole",
      "generation",
      "installationId",
      "profile",
      "schemaVersion",
    ]);
    await attach();
    expect(await listedLeaf()).toMatchObject({
      available: true,
      version: "2.12.0",
      buildCommit: null,
    });
  });

  test("a disconnected leaf reports null, not its last version", async () => {
    leaf.helloOverrides = { appVersion: "2.30.1" };
    await attach();
    expect((await listedLeaf()).version).toBe("2.30.1");

    leaf.online = false;
    network.timers.runAll(); // The heartbeat fails, so the link drops.
    await settle();

    expect(await listedLeaf()).toMatchObject({ available: false, version: null });
  });

  test("a disabled leaf reports null, and its version again once enabled", async () => {
    leaf.helloOverrides = { appVersion: "2.30.1" };
    await attach();
    await command.service.updateNode({ nodeId: LEAF_ID, enabled: false });
    expect(await listedLeaf()).toMatchObject({
      available: false,
      state: "disabled",
      version: null,
    });

    await command.service.updateNode({ nodeId: LEAF_ID, enabled: true });
    await settle();
    expect(await listedLeaf()).toMatchObject({ available: true, version: "2.30.1" });
  });

  test("a leaf that restarts on a new version reports it after reconnecting", async () => {
    leaf.helloOverrides = { appVersion: "2.30.1", generation: "before-restart" };
    await attach();
    expect((await listedLeaf()).version).toBe("2.30.1");

    leaf.helloOverrides = { appVersion: "2.31.0", generation: "after-restart" };
    await runLink();

    expect(await listedLeaf()).toMatchObject({ available: true, version: "2.31.0" });
  });

  test("a leaf that was offline across its update reports the new version", async () => {
    leaf.helloOverrides = { appVersion: "2.30.1", generation: "before-restart" };
    await attach();
    leaf.online = false;
    network.timers.runAll();
    await settle();
    expect((await listedLeaf()).version).toBeNull();

    leaf.helloOverrides = { appVersion: "2.31.0", generation: "after-restart" };
    leaf.online = true;
    await runLink();

    expect(await listedLeaf()).toMatchObject({ available: true, version: "2.31.0" });
  });

  test("a version a node sends is plain text", async () => {
    leaf.helloOverrides = { appVersion: "2.30.1\n\u0007" };
    await attach();
    expect((await listedLeaf()).version).toBe("2.30.1  ");
  });

  test("reports this machine's build commit and a connected leaf's from its hello", async () => {
    leaf.helloOverrides = { buildCommit: COMMIT };
    await attach();
    const listed = await listNodes();
    // Run from source, as every test is, this backend has no commit to report.
    expect(BUILD_COMMIT).toBeNull();
    expect(listed.self.buildCommit).toBe(BUILD_COMMIT);
    expect(listed.nodes).toEqual([
      expect.objectContaining({ nodeId: LEAF_ID, available: true, buildCommit: COMMIT }),
    ]);
  });

  test("a build commit is dropped when invalid, and the leaf still lists and works", async () => {
    leaf.helloOverrides = { appVersion: "2.30.1", buildCommit: "abc1234-dirty" };
    await attach();
    expect(await listedLeaf()).toMatchObject({
      available: true,
      state: "connected",
      version: "2.30.1",
      buildCommit: null,
    });
  });

  test("a disconnected leaf reports a null build commit, not its last one", async () => {
    leaf.helloOverrides = { buildCommit: COMMIT };
    await attach();
    expect((await listedLeaf()).buildCommit).toBe(COMMIT);

    leaf.online = false;
    network.timers.runAll();
    await settle();

    expect(await listedLeaf()).toMatchObject({ available: false, buildCommit: null });
  });

  test("a disabled leaf reports a null build commit, and its commit again once enabled", async () => {
    leaf.helloOverrides = { buildCommit: COMMIT };
    await attach();
    await command.service.updateNode({ nodeId: LEAF_ID, enabled: false });
    expect(await listedLeaf()).toMatchObject({ available: false, buildCommit: null });

    await command.service.updateNode({ nodeId: LEAF_ID, enabled: true });
    await settle();
    expect(await listedLeaf()).toMatchObject({ available: true, buildCommit: COMMIT });
  });

  test("a leaf that restarts on a new build reports its commit, or none, after reconnecting", async () => {
    leaf.helloOverrides = { buildCommit: COMMIT, generation: "before-restart" };
    await attach();
    expect((await listedLeaf()).buildCommit).toBe(COMMIT);

    leaf.helloOverrides = { buildCommit: "def5678", generation: "after-restart" };
    await runLink();
    expect((await listedLeaf()).buildCommit).toBe("def5678");

    // Rolled back to a release that predates the field: nothing stale is kept.
    leaf.helloOverrides = { generation: "after-rollback" };
    await runLink();
    expect(await listedLeaf()).toMatchObject({ available: true, buildCommit: null });
  });

  test("the tool description says what the version means and when it is null", async () => {
    expect(description).toContain("version is the Orkestrator version the machine is running");
    expect(description).toContain("null means the node is not connected");
    expect(description).toContain("does not prove a specific fix");
  });

  test("the tool description says a null build commit is not a missing fix", () => {
    expect(description).toContain("buildCommit is the Git commit");
    expect(description).toContain("It does not mean a fix is missing");
  });
});
