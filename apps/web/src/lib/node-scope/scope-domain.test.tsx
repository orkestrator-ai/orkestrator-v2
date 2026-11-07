import { afterEach, describe, expect, mock, test } from "bun:test";
import { incompatibility } from "@orkestrator/protocol/contract/errors";
import { domainClient } from "@orkestrator/protocol/contract/client";
import { BACKEND_CAPABILITIES } from "@orkestrator/protocol/backend-profile";
import {
  getNodeProjectCoordinatorCommand,
  nodeMailClient,
  nodeMailDomain,
} from "@orkestrator/protocol/contract/domains/node-mail";
import type { BackendId } from "@orkestrator/protocol/federation";
import { act, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import { COMMAND_SCOPE_PROVISIONAL_NODE_ID } from "./app-window-scope";
import { useNodeScope } from "./providers";
import { WindowScope } from "./window-scope";

const NODE = "bk_node" as BackendId;
const PROVEN = "bk_proven" as BackendId;
const CURRENT = { "node-mail": { min: 1, max: 1 } } as const;

const windows: WindowScope[] = [];
afterEach(() => {
  for (const windowScope of windows.splice(0)) windowScope.dispose();
  cleanupNodeScopes();
});

function openScope(
  client: FakeNodeClient,
  usage = mock((_domain: string, _version: number) => {}),
) {
  const windowScope = new WindowScope({ domainUsage: usage });
  windows.push(windowScope);
  return { scope: windowScope.open({ role: "leaf", client }), usage, windowScope };
}

const COORDINATOR = { hasCoordinator: true, main: { title: "Lead", agent: "claude" } };

describe("scope.domain(def)", () => {
  test("is memoised per scope and rebuilt on a new connection generation", async () => {
    const client = new FakeNodeClient({
      nodeId: NODE,
      invoke: { get_node_project_coordinator: COORDINATOR },
    });
    const { scope, usage } = openScope(client);
    const mail = scope.domain(nodeMailClient);
    expect(scope.domain(nodeMailClient)).toBe(mail);

    // Pre-contract (no hello yet): the version-0 adapter, without an envelope, counted.
    expect(mail.version()).toBe(0);
    const legacyApi = mail.api();
    expect(await legacyApi.projectCoordinator({ projectId: "p1" })).toEqual(COORDINATOR);
    expect(client.invocations.at(-1)).toEqual({
      command: "get_node_project_coordinator",
      args: { projectId: "p1" },
    });
    expect(usage).toHaveBeenCalledWith("node-mail", 0);

    // Reconnect to an upgraded backend: the new hello's ranges pick version 1.
    client.setHello({ domains: CURRENT, capabilities: [] });
    expect(mail.version()).toBe(1);
    const currentApi = mail.api();
    expect(currentApi).not.toBe(legacyApi);
    await currentApi.projectCoordinator({ projectId: "p1" });
    expect(client.invocations.at(-1)).toEqual({
      command: "get_node_project_coordinator",
      args: { projectId: "p1" },
      envelope: { domain: "node-mail", version: 1 },
    });
    expect(usage).toHaveBeenCalledTimes(1);
    // The same generation keeps the same API.
    expect(mail.api()).toBe(currentApi);
  });

  test("a reconnect that keeps the hello's objects still resets the choice", () => {
    const client = new FakeNodeClient({ nodeId: NODE, domains: CURRENT });
    const { scope } = openScope(client);
    const mail = scope.domain(nodeMailClient);
    const api = mail.api();
    client.connection.set("connecting");
    client.connection.set("live");
    expect(mail.api()).not.toBe(api);
  });

  test("a node whose range has no adapter refuses with unsupported-version", () => {
    const newerOnly = domainClient(nodeMailDomain, { 1: () => ({ ok: true }) });
    const { scope } = openScope(new FakeNodeClient({ nodeId: NODE }));
    expect(scope.domain(newerOnly).version()).toBeNull();
    let error: unknown;
    try {
      scope.domain(newerOnly).api();
    } catch (caught) {
      error = caught;
    }
    expect(incompatibility(error)?.code).toBe("unsupported-version");
  });

  test("is refused once the scope is disposed, and dropped with it", () => {
    const client = new FakeNodeClient({ nodeId: NODE });
    const { scope } = openScope(client);
    scope.domain(nodeMailClient);
    scope.dispose();
    expect(() => scope.domain(nodeMailClient)).toThrow("disposed");
    // The generation watch is gone with the scope.
    client.connection.set("connecting");
    client.connection.set("live");
  });

  test("client.invoke(def, args) sends this build's version", async () => {
    const client = new FakeNodeClient({
      nodeId: NODE,
      invoke: { get_node_project_coordinator: { hasCoordinator: false, extra: 1 } },
    });
    expect(await client.invoke(getNodeProjectCoordinatorCommand, { projectId: "p" })).toEqual({
      hasCoordinator: false,
    });
    expect(client.invocations.at(-1)?.envelope).toEqual({
      domain: "node-mail",
      version: nodeMailDomain.version,
    });
  });
});

describe("WindowScope.adoptCommandNodeId", () => {
  test("moves a provisional command scope to its proven id, keeping the old id as an alias", () => {
    const windowScope = new WindowScope();
    windows.push(windowScope);
    const command = windowScope.open({
      role: "command",
      client: new FakeNodeClient({ nodeId: COMMAND_SCOPE_PROVISIONAL_NODE_ID }),
    });
    const leaf = windowScope.open({ role: "leaf", client: new FakeNodeClient({ nodeId: NODE }) });
    windowScope.budgets.transcripts.reserve(COMMAND_SCOPE_PROVISIONAL_NODE_ID, "s1", 100);
    windowScope.select({
      nodeId: COMMAND_SCOPE_PROVISIONAL_NODE_ID,
      projectId: "p",
      environmentId: null,
    });
    const seen: number[] = [];
    windowScope.nodeScopes.subscribe((scopes) => seen.push(scopes.length));

    expect(windowScope.adoptCommandNodeId(NODE)).toBe(false);
    expect(windowScope.adoptCommandNodeId("provisional:other" as BackendId)).toBe(false);
    expect(windowScope.adoptCommandNodeId(PROVEN)).toBe(true);

    expect(command.nodeId).toBe(PROVEN);
    expect(windowScope.get(PROVEN)).toBe(command);
    expect(windowScope.get(COMMAND_SCOPE_PROVISIONAL_NODE_ID)).toBe(command);
    expect(windowScope.nodeScopes.get()).toEqual([command, leaf]);
    expect(seen).toEqual([2]);
    expect(windowScope.budgets.transcripts.has(PROVEN, "s1")).toBe(true);
    expect(windowScope.budgets.transcripts.usedBytes).toBe(100);
    expect(windowScope.selection.get()?.nodeId).toBe(PROVEN);
    // Proven ids are final.
    expect(windowScope.adoptCommandNodeId("bk_again" as BackendId)).toBe(false);

    command.dispose();
    expect(windowScope.get(COMMAND_SCOPE_PROVISIONAL_NODE_ID)).toBeNull();
    expect(windowScope.budgets.transcripts.usedBytes).toBe(0);
  });
});

/** The pilot from a component: what a scoped panel does with a leaf's mail domain. */
function CoordinatorBadge({ projectId }: { projectId: string }) {
  const scope = useNodeScope();
  const [text, setText] = useState("loading");
  const mail = scope.domain(nodeMailClient);
  const load = async () => {
    const api = mail.api();
    const answer = await api.projectCoordinator({ projectId });
    const steer = api.supports(BACKEND_CAPABILITIES.nodeMailSteer) ? "steer" : "no steer";
    setText(`v${mail.version()} ${answer.main?.title ?? "none"} ${steer}`);
  };
  return (
    <button type="button" onClick={() => void load()}>
      {text}
    </button>
  );
}

describe("Done when: a scoped component calls scope.domain(nodeMail)", () => {
  test("against a current node", async () => {
    const client = new FakeNodeClient({
      nodeId: NODE,
      domains: CURRENT,
      capabilities: [],
      invoke: { get_node_project_coordinator: COORDINATOR },
    });
    renderInNodeScope(<CoordinatorBadge projectId="p1" />, { client, role: "leaf" });
    await act(async () => screen.getByRole("button").click());
    await waitFor(() => expect(screen.getByRole("button").textContent).toBe("v1 Lead steer"));
    expect(client.invocations[0]?.envelope).toEqual({ domain: "node-mail", version: 1 });
  });

  test("against a pre-contract node", async () => {
    const client = new FakeNodeClient({
      nodeId: NODE,
      domains: null,
      capabilities: [BACKEND_CAPABILITIES.nodeCoordinatorMail],
      invoke: { get_node_project_coordinator: COORDINATOR },
    });
    renderInNodeScope(<CoordinatorBadge projectId="p1" />, { client, role: "leaf" });
    await act(async () => screen.getByRole("button").click());
    await waitFor(() => expect(screen.getByRole("button").textContent).toBe("v0 Lead no steer"));
    expect(client.invocations[0]).toEqual({
      command: "get_node_project_coordinator",
      args: { projectId: "p1" },
    });
  });
});
