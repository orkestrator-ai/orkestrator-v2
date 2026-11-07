/**
 * The `nodes` commands are registered with their definitions (plan item
 * 7009): the registry holds each definition, advertises the domain in the
 * hello, and every key a handler hands its service survives decoding (a
 * defined command drops the keys it does not declare), while an unknown key
 * is dropped where the strict handlers used to refuse it.
 */
import { expect, mock, test } from "bun:test";
import { NODES_COMMANDS } from "@orkestrator/protocol/contract/domains/nodes";
import { createCommandRegistry, type CommandContext } from "./commands.js";

test("registers every nodes command with its definition", () => {
  const registry = createCommandRegistry();
  for (const def of NODES_COMMANDS) {
    expect({ name: def.name, defined: registry.contracts.get(def.name) === def }).toEqual({
      name: def.name,
      defined: true,
    });
  }
  expect(registry.helloDomains().nodes).toEqual({ min: 1, max: 1 });
});

const view = {
  nodeId: "bk_a",
  enabled: true,
  displayName: "Mini",
  hasCredential: true,
  routes: [],
  connection: { state: "connected", epoch: 1 },
};

/** Calls `name` with `args` plus an unknown key; answers what `service` received. */
async function received(
  name: string,
  args: Record<string, unknown>,
  context: (service: ReturnType<typeof mock>) => unknown,
  answer: unknown,
): Promise<unknown[]> {
  const service = mock(async (..._input: unknown[]) => answer);
  const command = createCommandRegistry().get(name)!;
  await command({ ...args, unknownKey: "dropped" }, context(service) as CommandContext);
  expect(service).toHaveBeenCalledTimes(1);
  return service.mock.calls[0] as unknown[];
}

test.each([
  [
    "attach_controller",
    { controllerId: "bk_c", displayName: "Command", portalOrigins: ["https://c"] },
    "attachController",
    { nodeId: "bk_a", mode: "leaf" },
  ],
  [
    "add_node",
    { routes: [{ id: "r1" }], routeOrder: ["r1"], token: "t", displayName: "Mini" },
    "addNode",
    view,
  ],
  [
    "update_node",
    { nodeId: "bk_a", routes: [], routeOrder: [], token: "t", enabled: false },
    "updateNode",
    view,
  ],
  [
    "forget_node",
    { nodeId: "bk_a", withoutDetach: true },
    "forgetNode",
    { forgotten: true, detached: false },
  ],
  [
    "answer_node_ssh_prompt",
    { promptId: "p", answer: "yes", cancel: false },
    "answerSshPrompt",
    { answered: true },
  ],
  [
    "probe_node_host_key",
    { destination: "user@mini", sshPort: 2222 },
    "probeHostKey",
    { probeId: "p", destination: "user@mini", fingerprints: [] },
  ],
])("%s hands its service every key it declares", async (name, args, method, answer) => {
  const [input] = await received(
    name,
    args,
    (service) => ({ nodes: { [method]: service } }),
    answer,
  );
  expect(input).toEqual(args);
});

test("sync_controller_settings hands the settings to the inherited-settings receiver", async () => {
  const args = { controllerId: "bk_c", settings: { revision: 1 } };
  const [input] = await received(
    "sync_controller_settings",
    args,
    (receive) => ({ nodes: { inheritedSettings: { receive } } }),
    { applied: true },
  );
  expect(input).toEqual(args);
});

test.each([
  [
    "create_client_grant",
    { controllerId: "bk_c", ttlSeconds: 60, label: "Window" },
    "createClientGrant",
    { grant: { grantId: "g", controllerId: "bk_c", label: "Window", expiresAt: 1 }, token: "t" },
  ],
  [
    "renew_client_grant",
    { controllerId: "bk_c", grantId: "g", ttlSeconds: 60 },
    "renewClientGrant",
    null,
  ],
  [
    "revoke_client_grant",
    { controllerId: "bk_c", grantId: "g" },
    "revokeClientGrant",
    { revoked: true },
  ],
])("%s hands the portal every key it declares", async (name, args, method, answer) => {
  const [input] = await received(
    name,
    args,
    (service) => ({ nodePortal: { [method]: service } }),
    answer,
  );
  expect(input).toEqual(args);
});

test("watch_node_events hands the relay every key it declares", async () => {
  const args = { nodeId: "bk_a", prefixes: ["environment"], watchId: "w" };
  const [input] = await received(
    "watch_node_events",
    args,
    (watch) => ({ nodePortal: { events: { watch } } }),
    { watchId: "w", expiresAt: 1, renewed: false },
  );
  expect(input).toEqual(args);
});

test("invoke_on_node routes the call unchanged and never sets the envelope itself", async () => {
  const args = {
    nodeId: "bk_a",
    command: "get_projects",
    args: { includeArchived: true, nested: { kept: [1] } },
    requestKey: "k",
  };
  const calls = await received(
    "invoke_on_node",
    args,
    (invokeOnNode) => ({ nodePortal: { invokeOnNode } }),
    { outcome: "ok", result: [] },
  );
  expect(calls).toEqual([args]);
});
