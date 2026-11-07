import { afterEach, expect, mock, test } from "bun:test";
import { invoke } from "@/lib/native/backend";
import { openLeafWorkspace } from "./workspaces";
import { COMMAND_STORAGE_NODE, desktopConnectionStorageKey } from "@/lib/desktop-storage-key";
import {
  createBrowserGatewayApi,
  disposeBrowserGatewayApi,
  installBrowserGatewayApi,
} from "@/lib/native/web-gateway";

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
    const first = desktopConnectionStorageKey("workspace-draft", COMMAND_STORAGE_NODE);
    localStorage.setItem(first, "remembered draft");
    window.orkestratorDesktopIdentity = {
      ...window.orkestratorDesktopIdentity,
      connectionId: "workspace:two",
    };
    expect(desktopConnectionStorageKey("workspace-draft", COMMAND_STORAGE_NODE)).toBe(first);
    expect(
      localStorage.getItem(desktopConnectionStorageKey("workspace-draft", COMMAND_STORAGE_NODE)),
    ).toBe("remembered draft");
  } finally {
    window.orkestratorDesktopIdentity = originalIdentity;
  }
});

/*
 * A leaf shown in the window's tree is reached through the node-client
 * registry on its own grant, directly or relayed (`lib/node-scope/node-clients.test.ts`
 * "opening a leaf" and "grant lifetime"; live: `e2e/agent-testing/multi-node-window.spec.ts`).
 * The page itself is never a leaf's client.
 */
test("the page boots as its command node's client, whatever its URL names", async () => {
  happyDOM.setURL("https://command.test/?workspace=w1&project=p");
  const fetchMock = mock(async () => new Response(JSON.stringify({ result: [] })));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const target = {
    orkestrator: undefined,
    orkestratorGateway: undefined,
    location: window.location,
  } as unknown as Window;
  installBrowserGatewayApi(target, { browserSessionActivity: false });
  try {
    expect(target.orkestratorGateway).toEqual({ enabled: true });
    expect("orkestratorPortal" in target).toBe(false);
    await target.orkestrator!.invoke("get_node_summaries");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(String(url), window.location.href).href).toBe(
      "https://command.test/__orkestrator/invoke",
    );
    expect(init.credentials).toBe("same-origin");
  } finally {
    disposeBrowserGatewayApi(target.orkestrator!);
  }
});
