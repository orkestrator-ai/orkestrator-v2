import { afterEach, expect, mock, test } from "bun:test";
import { establishRoute } from "../electron/connection-route-selection";
import type { SavedBackend } from "@orkestrator/protocol/device-catalogue";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const backend: SavedBackend = {
  id: "node",
  fallbackName: "Node",
  autoConnect: false,
  verifiedInstallationId: "bk_node" as never,
  routeOrder: ["a", "b"] as never,
  routes: ["a", "b"].map((id) => ({
    id: id as never,
    kind: "https",
    origin: `https://${id}.test`,
    enabled: true,
    encryptedToken: "",
  })),
};
const status = () => ({
  transport: "connected" as const,
  identity: "verified" as const,
  blockedRoutes: new Map<string, string>(),
});

test("first credential resolution failure cannot change access by falling back", async () => {
  const resolveToken = mock(async (route: { id: string }) => {
    if (route.id === "a") throw new Error("keychain locked");
    return "different";
  });
  const fetchMock = mock(async () => new Response("{}"));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  await expect(
    establishRoute(
      {
        status: status(),
        supportedRouteKinds: ["https"],
        routeFallback: true,
        timeoutMs: 100,
        sshTunnels: null,
        resolveToken,
      },
      backend,
      { interactive: false },
    ),
  ).rejects.toThrow("credential");
  expect(resolveToken).toHaveBeenCalledTimes(1);
  expect(fetchMock).not.toHaveBeenCalled();
});

for (const wrapped of [false, true])
  test(`certificate failure stops route selection (wrapped=${wrapped})`, async () => {
    const cert = Object.assign(new Error("certificate expired"), { code: "CERT_HAS_EXPIRED" });
    const fetchMock = mock(async () => {
      throw wrapped ? new TypeError("fetch failed", { cause: cert }) : cert;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      establishRoute(
        {
          status: status(),
          supportedRouteKinds: ["https"],
          routeFallback: true,
          timeoutMs: 100,
          sshTunnels: null,
          resolveToken: async () => "same",
        },
        backend,
        { interactive: false },
      ),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
