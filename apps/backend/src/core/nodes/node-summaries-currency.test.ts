import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { settle, TestNodeNetwork, type TestNode } from "./node-network-test-support.js";
import { NodeReadModel } from "./node-read-model.js";

/**
 * Plan item 5006: `get_node_summaries` carries each connected node's hello
 * `domains` beside its version, and this command node's own version and
 * domains, through the real node link and read model; only the leaf's hello
 * is scripted.
 */

const LEAF_ID = "bk_leaf";

describe("node summaries for fleet currency", () => {
  let network: TestNodeNetwork;
  let command: TestNode;
  let leaf: TestNode;

  beforeEach(async () => {
    network = new TestNodeNetwork();
    command = await network.add("command", { forceRegistration: true });
    leaf = await network.add("leaf");
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

  const summary = async () =>
    (await command.portal.summaries()).nodes.find((node) => node.nodeId === LEAF_ID)!;

  test("a connected leaf's domains come from its hello", async () => {
    leaf.helloOverrides = {
      appVersion: "2.38.0",
      domains: { git: { min: 1, max: 2 }, terminals: { min: 1, max: 1 } },
    };
    await attach();
    expect(await summary()).toMatchObject({
      version: "2.38.0",
      domains: { git: { min: 1, max: 2 }, terminals: { min: 1, max: 1 } },
    });
  });

  test("a pre-contract leaf (no domains in its hello) reports null with its version", async () => {
    leaf.helloOverrides = { appVersion: "2.30.0" };
    await attach();
    expect(await summary()).toMatchObject({ version: "2.30.0", domains: null });
  });

  test("a disconnected leaf reports null, not its last domains", async () => {
    leaf.helloOverrides = { appVersion: "2.38.0", domains: { git: { min: 1, max: 1 } } };
    await attach();
    expect((await summary()).domains).toEqual({ git: { min: 1, max: 1 } });
    leaf.online = false;
    network.timers.runAll();
    await settle();
    expect(await summary()).toMatchObject({ version: null, domains: null });
  });

  test("the command node reports its own version and domains when it knows them", async () => {
    const model = new NodeReadModel({
      nodes: command.service,
      emit: () => undefined,
      selfHello: async () => ({ appVersion: "2.40.0", domains: { git: { min: 1, max: 2 } } }),
    });
    const result = await model.summaries();
    expect(result.selfVersion).toBe("2.40.0");
    expect(result.selfDomains).toEqual({ git: { min: 1, max: 2 } });
    // Without it (an embedded portal in tests) the fields are absent, as from an older node.
    expect("selfVersion" in (await command.portal.summaries())).toBe(false);
  });
});
