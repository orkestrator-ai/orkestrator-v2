import { afterEach, expect, mock, test } from "bun:test";
import { readNodeHelloAt } from "../electron/scope-hello";

const HELLO = {
  schemaVersion: 1,
  installationId: "bk_leaf",
  generation: "gen-1",
  appVersion: "2.25.0",
  clientApi: { minVersion: 1, maxVersion: 1 },
  capabilities: { "node-mail-steer": 1 },
  profile: {
    revision: 1,
    displayName: "Leaf",
    colorToken: "teal",
    updatedAt: "2026-11-07T00:00:00.000Z",
  },
  endpointRole: "client",
  domains: { "node-mail": { min: 1, max: 1 } },
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function answering(response: () => Response) {
  const urls: string[] = [];
  const fetchImpl = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(`${String(input)} ${new Headers(init?.headers).get("authorization")}`);
    return response();
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

test("a relayed node's hello is read under the relay base, not the command node's origin", async () => {
  const { fetchImpl, urls } = answering(() => new Response(JSON.stringify(HELLO)));
  const hello = await readNodeHelloAt("https://command.test/__orkestrator/nodes/bk_leaf/", "t", {
    timeoutMs: 1_000,
    fetchImpl,
  });
  expect(urls).toEqual([
    "https://command.test/__orkestrator/nodes/bk_leaf/__orkestrator/hello Bearer t",
  ]);
  expect(hello?.installationId).toBe("bk_leaf" as never);
  expect(hello?.domains).toEqual({ "node-mail": { min: 1, max: 1 } });
});

test("a node without a hello is pre-contract; a failure that cannot tell throws", async () => {
  const options = (response: () => Response) => ({
    timeoutMs: 1_000,
    fetchImpl: answering(response).fetchImpl,
  });
  expect(
    await readNodeHelloAt(
      "https://leaf.test",
      "t",
      options(() => new Response("", { status: 404 })),
    ),
  ).toBeNull();
  expect(
    await readNodeHelloAt(
      "https://leaf.test",
      "t",
      options(() => new Response("<html></html>")),
    ),
  ).toBeNull();
  await expect(
    readNodeHelloAt(
      "https://leaf.test",
      "t",
      options(() => new Response("", { status: 401 })),
    ),
  ).rejects.toThrow("HTTP 401");
  await expect(
    readNodeHelloAt(
      "https://leaf.test",
      "t",
      options(() => new Response("", { status: 502 })),
    ),
  ).rejects.toThrow("HTTP 502");
});
