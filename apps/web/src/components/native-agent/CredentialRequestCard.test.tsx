import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type {
  CredentialConnection,
  CredentialRequestRecord,
  CredentialTabSnapshot,
} from "@orkestrator/protocol/agent-credentials";
import { useCredentialSnapshot } from "@/hooks/useCredentialSnapshot";
import { dispatchResourceChange } from "@/lib/resource-sync";
import { portalStore } from "@/lib/portal/portal-store";
import {
  cleanupNodeScopes,
  FakeNodeClient,
  renderInNodeScope,
  renderInAppCommandScope,
} from "@/test/render-in-node-scope";
import * as realBackend from "@/lib/backend";

const approveCredentialRequest = mock(async (_choice: unknown, _machine?: unknown) => ({
  request: {} as CredentialRequestRecord,
  grant: {} as never,
}));
const declineCredentialRequest = mock(async (_input: unknown, _machine?: unknown) => ({
  request: {} as CredentialRequestRecord,
}));

mock.module("@/lib/backend", () => ({
  ...realBackend,
  approveCredentialRequest,
  declineCredentialRequest,
}));

const { CredentialRequestCard, pendingCredentialRequests } =
  await import("./CredentialRequestCard");

afterEach(() => {
  cleanupNodeScopes();
  cleanup();
  approveCredentialRequest.mockReset();
  declineCredentialRequest.mockReset();
  approveCredentialRequest.mockImplementation(async () => ({
    request: {} as CredentialRequestRecord,
    grant: {} as never,
  }));
});

afterAll(() => {
  mock.module("@/lib/backend", () => realBackend);
});

const VAULT: CredentialTabSnapshot["vault"] = {
  durable: "keychain",
  canSave: true,
  detail: "Saved values are kept in this machine's system keychain.",
};

function request(overrides: Partial<CredentialRequestRecord> = {}): CredentialRequestRecord {
  return {
    id: "request-1",
    revision: 1,
    environmentId: "env-1",
    projectId: "project-1",
    tabId: "tab-1",
    label: "npm token",
    purpose: "Publish the package to npm",
    use: "command",
    binding: { kind: "env", name: "NPM_TOKEN" },
    state: "pending",
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000,
    ...overrides,
  };
}

function connection(overrides: Partial<CredentialConnection> = {}): CredentialConnection {
  return {
    id: "connection-1",
    name: "npm",
    projectIds: null,
    httpHosts: [],
    storage: "keychain",
    revision: 1,
    valueVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    status: "ready",
    ...overrides,
  };
}

describe("CredentialRequestCard", () => {
  test("says plainly that code can read the value, and sends a typed value only on Allow", async () => {
    renderInAppCommandScope(
      <CredentialRequestCard request={request()} connections={[]} vault={VAULT} />,
    );
    expect(
      screen.getByText(/Code running in this task will be able to read this credential/u),
    ).toBeTruthy();
    expect(screen.getByText("$NPM_TOKEN")).toBeTruthy();
    const allow = screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement;
    expect(allow.disabled).toBe(true);
    const input = screen.getByLabelText("Credential value") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: "  exact value  " } });
    fireEvent.click(allow);
    await waitFor(() => expect(approveCredentialRequest).toHaveBeenCalledTimes(1));
    expect(approveCredentialRequest.mock.calls[0]?.[0]).toEqual({
      requestId: "request-1",
      revision: 1,
      source: { kind: "value", value: "  exact value  " },
      lifetimeMs: 60 * 60_000,
    });
    await waitFor(() => expect(input.value).toBe(""));
  });

  test("offers a saved credential first, matching the agent's suggestion", async () => {
    renderInAppCommandScope(
      <CredentialRequestCard
        request={request({ suggestedConnection: "NPM" })}
        connections={[connection({ id: "other", name: "other" }), connection()]}
        vault={VAULT}
      />,
    );
    fireEvent.click(screen.getByLabelText("Allow one use only"));
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(approveCredentialRequest).toHaveBeenCalledTimes(1));
    expect(approveCredentialRequest.mock.calls[0]?.[0]).toMatchObject({
      source: { kind: "connection", connectionId: "connection-1" },
      maxUses: 1,
    });
  });

  test("an HTTP request lists its hosts and hides saved credentials that may not reach them", () => {
    renderInAppCommandScope(
      <CredentialRequestCard
        request={request({
          use: "http",
          binding: undefined,
          http: { auth: { scheme: "bearer" }, hosts: ["api.example.com"] },
        })}
        connections={[connection({ name: "no-hosts" })]}
        vault={VAULT}
      />,
    );
    expect(screen.getByText("api.example.com")).toBeTruthy();
    expect(screen.getByText(/The agent never receives the value/u)).toBeTruthy();
    expect(screen.queryByLabelText("Saved credential") === null).toBe(true);
    expect(screen.getByText(/are not offered/u)).toBeTruthy();
  });

  test("declines, and shows a refusal without its error code", async () => {
    approveCredentialRequest.mockImplementation(async () => {
      throw new Error("REQUEST_STALE: This request has expired.");
    });
    renderInAppCommandScope(
      <CredentialRequestCard request={request()} connections={[connection()]} vault={VAULT} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(await screen.findByText("This request has expired.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(declineCredentialRequest).toHaveBeenCalledTimes(1));
    expect(declineCredentialRequest.mock.calls[0]?.[0]).toEqual({
      requestId: "request-1",
      revision: 1,
    });
  });

  test("without a keychain the value can be used but not saved", () => {
    renderInAppCommandScope(
      <CredentialRequestCard
        request={request()}
        connections={[]}
        vault={{ durable: "memory", canSave: false, detail: "Values cannot be saved here." }}
      />,
    );
    expect(screen.queryByLabelText("Saved credential name") === null).toBe(true);
    expect(screen.getByText("Values cannot be saved here.")).toBeTruthy();
  });

  test("pendingCredentialRequests keeps only live pending requests", () => {
    const now = Date.now();
    const snapshot: CredentialTabSnapshot = {
      requests: [
        request({ id: "a" }),
        request({ id: "b", state: "declined" }),
        request({ id: "c", expiresAt: now - 1 }),
      ],
      grants: [],
      connections: [],
      vault: VAULT,
    };
    expect(pendingCredentialRequests(snapshot, now).map((each) => each.id)).toEqual(["a"]);
    expect(pendingCredentialRequests(null)).toEqual([]);
  });
});

test("a refreshed remote snapshot clears a removed choice and routes the next approval to that node", async () => {
  const pending = request({ suggestedConnection: "Existing" });
  const existing = connection({ id: "existing", name: "Existing" });
  const removed = connection({ id: "chosen", name: "Chosen" });
  let snapshot: CredentialTabSnapshot = {
    requests: [pending],
    connections: [existing, removed],
    grants: [],
    vault: VAULT,
  };
  const client = new FakeNodeClient({ invoke: { get_credential_snapshot: () => snapshot } });
  const invokeOnNode = spyOn(portalStore, "invokeOnNode").mockResolvedValue({
    request: pending,
    grant: {},
  });
  function RemoteCard() {
    const { snapshot } = useCredentialSnapshot(pending.environmentId, pending.tabId);
    return snapshot ? (
      <CredentialRequestCard
        request={pending}
        connections={snapshot.connections}
        vault={snapshot.vault}
      />
    ) : null;
  }
  try {
    const { scope } = renderInNodeScope(<RemoteCard />, { client, role: "leaf" });
    const select = (await screen.findByRole("combobox", {
      name: "Saved credential to use",
    })) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: removed.id } });
    expect(select.value).toBe(removed.id);
    snapshot = { ...snapshot, connections: [existing] };
    dispatchResourceChange({ resource: "credential", id: "connections", revision: 1 }, scope);
    const allow = screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement;
    await waitFor(() => expect(allow.disabled).toBe(true));
    expect(select.value).toBe("");
    snapshot = { ...snapshot, connections: [existing, removed] };
    dispatchResourceChange({ resource: "credential", id: "connections", revision: 2 }, scope);
    await waitFor(() => expect(select.options.length).toBe(3));
    expect(allow.disabled).toBe(true);
    fireEvent.change(select, { target: { value: existing.id } });
    fireEvent.click(allow);
    await waitFor(() => expect(invokeOnNode).toHaveBeenCalledTimes(1));
    expect(invokeOnNode).toHaveBeenCalledWith(
      client.nodeId,
      "approve_credential_request",
      expect.objectContaining({
        requestId: pending.id,
        source: { kind: "connection", connectionId: existing.id },
      }),
    );
    expect(client.calls("get_credential_snapshot")).toHaveLength(3);
    expect(client.calls("approve_credential_request")).toHaveLength(0);
    expect(approveCredentialRequest).toHaveBeenCalledTimes(0);
  } finally {
    invokeOnNode.mockRestore();
  }
});
