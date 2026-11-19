import { afterEach, expect, test } from "bun:test";
import { cleanup, screen } from "@testing-library/react";
import type { CredentialTabSnapshot } from "@orkestrator/protocol/agent-credentials";
import type { BackendId } from "@orkestrator/protocol/federation";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { dispatchResourceChange } from "@/lib/resource-sync";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import { useCredentialSnapshot } from "./useCredentialSnapshot";

afterEach(() => {
  cleanup();
  cleanupNodeScopes();
});

function Probe() {
  const { snapshot } = useCredentialSnapshot("env", "tab");
  if (!snapshot) return <p>Loading credential snapshot</p>;
  const pending = snapshot.requests.find((request) => request.state === "pending");
  return <p>{pending ? pending.label : "No pending request"}</p>;
}

test("a remounted tab rehydrates from its backend and a remote approval clears its card", async () => {
  const windowScope = new WindowScope();
  const command = windowScope.open({
    role: "command",
    client: new FakeNodeClient({ nodeId: "bk_credential-command" as BackendId }),
  });
  const client = new FakeNodeClient({ nodeId: "bk_credential-leaf" as BackendId });
  const leaf = windowScope.open({ role: "leaf", client });
  const mount = () => renderInNodeScope(<Probe />, { windowScope, client, role: "leaf" });
  const snapshot: CredentialTabSnapshot = {
    requests: [],
    grants: [],
    connections: [],
    vault: { durable: "memory", canSave: false, detail: "Fixture" },
  };
  client.respond("get_credential_snapshot", () => snapshot);
  const first = mount();
  await screen.findByText("No pending request");
  first.unmount();

  snapshot.requests = [
    {
      id: "fixture",
      revision: 1,
      environmentId: "env",
      projectId: "project",
      tabId: "tab",
      label: "Fixture approval",
      purpose: "Fixture",
      use: "command",
      state: "pending",
      createdAt: 1,
      expiresAt: 2,
    },
  ];
  const second = mount();
  await screen.findByText("Fixture approval");
  snapshot.requests = [{ ...snapshot.requests[0]!, state: "granted" }];

  dispatchResourceChange({ resource: "credential", id: "env", revision: 1 }, command);
  dispatchResourceChange({ resource: "credential", id: "env", revision: 1 }, leaf);
  await screen.findByText("No pending request");
  expect(
    client.invocations.filter((entry) => entry.command === "get_credential_snapshot"),
  ).toHaveLength(3);
  second.unmount();
  windowScope.dispose();
});
