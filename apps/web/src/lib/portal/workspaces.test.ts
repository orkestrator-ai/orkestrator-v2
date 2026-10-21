import { afterEach, expect, mock, test } from "bun:test";
import { invoke } from "@/lib/native/backend";
import { openLeafWorkspace, storeWorkspaceForFrame } from "./workspaces";
import { browserPanelUrl } from "@/lib/federation/panel-realm";
import { desktopConnectionStorageKey } from "@/lib/desktop-storage-key";
import { createBrowserGatewayApi, machinePanelGatewayOptions } from "@/lib/native/web-gateway";

const happyDOM = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;
const originalFetch = globalThis.fetch;
const originalHref = window.location.href;
const originalGateway = window.orkestratorGateway;
const originalNative = window.orkestrator;
const invokeMock = invoke as unknown as ReturnType<typeof mock>;
afterEach(() => {
  globalThis.fetch = originalFetch;
  happyDOM.setURL(originalHref);
  window.orkestratorGateway = originalGateway;
  window.orkestrator = originalNative;
  invokeMock.mockReset();
});

test("HTTP 200 HTML and another installation are rejected in favor of relay", async () => {
  invokeMock.mockResolvedValue({
    workspaceId: "w",
    nodeId: "bk_leaf",
    nodeName: "Leaf",
    grant: { token: "short-lived", expiresAt: Date.now() + 60_000 },
    directOrigins: ["https://html.test", "https://wrong.test"],
    relayBase: "/__orkestrator/nodes/bk_leaf",
  });
  globalThis.fetch = mock(async (input) =>
    String(input).includes("html")
      ? new Response("<html>login</html>")
      : new Response(JSON.stringify({ installationId: "bk_wrong", endpointRole: "client" })),
  ) as unknown as typeof fetch;
  const workspace = await openLeafWorkspace("bk_leaf" as never);
  expect(workspace.path).toBe("relay");
  expect(workspace.token).toBeUndefined();
  expect(workspace.baseUrl).toBe(`${window.location.origin}/__orkestrator/nodes/bk_leaf`);
});

test("generated URLs isolate storage for two leaves and parent", () => {
  window.orkestrator = undefined;
  const keys = [];
  for (const nodeId of ["bk_a", "bk_b"]) {
    const url = browserPanelUrl({
      workspaceId: "w",
      nodeId,
      projectId: "shared",
      environmentId: "shared",
      connection: { nodeName: nodeId, path: "relay" },
    });
    window.history.replaceState(null, "", url);
    keys.push(desktopConnectionStorageKey("draft"));
  }
  happyDOM.setURL(originalHref);
  expect(new Set([...keys, desktopConnectionStorageKey("draft")]).size).toBe(3);
});

test("unbound panel gateway rejects commands without any fetch", async () => {
  const fetchMock = mock(async () => new Response("{}"));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  window.orkestrator = undefined;
  window.history.replaceState(
    null,
    "",
    browserPanelUrl({
      workspaceId: "missing",
      nodeId: "bk_leaf",
      projectId: "shared",
      environmentId: "shared",
      connection: { nodeName: "Leaf", path: "relay" },
    }),
  );
  const gateway = createBrowserGatewayApi(machinePanelGatewayOptions());
  await expect(gateway.invoke("start_environment", { environmentId: "shared" })).rejects.toThrow(
    "reconnect",
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

test("workspace storage never puts grant in generated URL", () => {
  const workspace = {
    workspaceId: "w",
    nodeId: "bk_a" as never,
    nodeName: "A",
    path: "direct" as const,
    baseUrl: "https://a.test",
    token: "private-grant",
    expiresAt: Date.now() + 60_000,
  };
  storeWorkspaceForFrame(workspace);
  expect(
    browserPanelUrl({
      workspaceId: workspace.workspaceId,
      nodeId: workspace.nodeId,
      connection: workspace,
    }),
  ).not.toContain("private-grant");
});

test("relay requests use the command-node session without exposing a leaf credential", async () => {
  happyDOM.setURL("https://command.test/");
  const fetchMock = mock(async () => new Response(JSON.stringify({ result: [] })));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const gateway = createBrowserGatewayApi({
    baseUrl: "https://command.test/__orkestrator/nodes/bk_leaf",
  });
  await gateway.invoke("get_projects");
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(String(url)).toBe("https://command.test/__orkestrator/nodes/bk_leaf/__orkestrator/invoke");
  expect(init.credentials).toBe("same-origin");
  expect(new Headers(init.headers).has("authorization")).toBe(false);
});

test("desktop storage uses verified leaf identity across new workspace IDs", () => {
  const originalIdentity = window.orkestratorDesktopIdentity;
  try {
    window.orkestrator = { ...originalNative, isolatedViewState: true } as never;
    window.orkestratorDesktopIdentity = {
      connectionId: "workspace:one",
      backendId: "bk_leaf",
      legacyOrigin: null,
      panel: true,
    };
    const first = desktopConnectionStorageKey("workspace-draft");
    localStorage.setItem(first, "remembered draft");
    window.orkestratorDesktopIdentity = {
      ...window.orkestratorDesktopIdentity,
      connectionId: "workspace:two",
    };
    expect(desktopConnectionStorageKey("workspace-draft")).toBe(first);
    expect(localStorage.getItem(desktopConnectionStorageKey("workspace-draft"))).toBe(
      "remembered draft",
    );
  } finally {
    window.orkestratorDesktopIdentity = originalIdentity;
  }
});

test("narrow clients open a newly created leaf environment on its owning node", async () => {
  const { openMachineWorkspace } = await import("@/lib/federation/open-workspace");
  const { createFederatedEnvironment } = await import("@/lib/federation/federated-actions");
  const originalMatchMedia = window.matchMedia;
  const originalOpen = window.open;
  try {
    happyDOM.setURL("https://command.test/");
    window.matchMedia = (() => ({ matches: true })) as never;
    window.open = mock(() => null) as never;
    invokeMock.mockResolvedValue({
      workspaceId: "new-workspace",
      nodeId: "bk_leaf",
      nodeName: "Leaf",
      grant: { token: "fixture", expiresAt: Date.now() + 60_000 },
      directOrigins: [],
      relayBase: "/__orkestrator/nodes/bk_leaf",
    });
    const create = mock(async (nodeId: string) => {
      expect(nodeId).toBe("bk_leaf");
      return { id: "new-env" };
    });
    const environment = await createFederatedEnvironment({ invokeOnNode: create } as never, {
      backendId: "bk_leaf" as never,
      projectId: "p",
    });
    openMachineWorkspace({
      connectionId: "bk_leaf",
      projectId: "p",
      environmentId: environment.id,
      title: "New",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const search = new URLSearchParams(window.location.search);
    expect(search.get("environment")).toBe("new-env");
    expect(search.get("machine")).toBe("bk_leaf");
    expect(search.get("panel")).toBe("workspace");
  } finally {
    window.matchMedia = originalMatchMedia;
    window.open = originalOpen;
  }
});
