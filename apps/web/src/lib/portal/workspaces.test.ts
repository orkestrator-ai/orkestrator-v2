import { afterEach, expect, mock, test } from "bun:test";
import { invoke } from "@/lib/native/backend";
import { openLeafWorkspace } from "./workspaces";
import { removeRealmWorkspace, writeRealmWorkspace } from "./workspace-target-storage";
import { desktopConnectionStorageKey } from "@/lib/desktop-storage-key";
import { createBrowserGatewayApi, workspaceTargetGatewayOptions } from "@/lib/native/web-gateway";

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

test("a browser realm boots as its leaf's client with the command node as portal; its window never does", async () => {
  happyDOM.setURL("https://command.test/");
  const fetchMock = mock(async () => new Response(JSON.stringify({ result: [] })));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const target = {
    orkestrator: undefined,
    orkestratorGateway: undefined,
    orkestratorPortal: undefined,
    orkestratorWorkspaceTarget: undefined,
    location: window.location,
  } as unknown as Window;
  expect(workspaceTargetGatewayOptions(target)).toEqual({});
  expect(target.orkestratorPortal).toBeUndefined();

  // The grant is in the tab; only the realm's URL names it.
  writeRealmWorkspace({
    workspaceId: "w1",
    nodeId: "bk_leaf" as never,
    nodeName: "Leaf",
    path: "relay",
    routeKind: "ssh",
    via: "Desk",
    baseUrl: "https://command.test/__orkestrator/nodes/bk_leaf",
    expiresAt: Date.now() + 60_000,
  });
  expect(workspaceTargetGatewayOptions(target)).toEqual({});
  happyDOM.setURL("https://command.test/?realm=workspace&workspace=w1");
  try {
    const options = workspaceTargetGatewayOptions(target);
    expect(options).toEqual({ baseUrl: "https://command.test/__orkestrator/nodes/bk_leaf" });
    expect(target.orkestratorWorkspaceTarget).toEqual({
      nodeId: "bk_leaf",
      nodeName: "Leaf",
      path: "relay",
      routeKind: "ssh",
      via: "Desk",
    });
    await target.orkestratorPortal!.invoke("get_node_summaries");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://command.test/__orkestrator/invoke");
    expect(init.credentials).toBe("same-origin");
  } finally {
    removeRealmWorkspace("w1");
    happyDOM.setURL("https://command.test/");
  }
});
