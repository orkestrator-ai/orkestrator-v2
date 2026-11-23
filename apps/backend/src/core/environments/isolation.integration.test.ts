import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { once } from "node:events";
import { networkInterfaces } from "node:os";
import {
  chooseEnvironmentPortBase,
  environmentIsolationVariables,
  withEnvironmentIsolation,
} from "./isolation.js";
import { environmentPortBlockAvailable } from "./port-probe.js";
import { createEnvironment } from "../storage-shared-core.js";
import { withTemporaryStorage } from "../storage-test-support.js";

const FIRST = "3f2a9c1e-77b4-4d1a-9e0f-0123456789ab";
const COLLIDING = "00000000-0000-4000-8000-000000000644";

test("deletion cannot reissue a colliding block while a service holds any port; stopped blocks can be reused", async () => {
  await withTemporaryStorage(async (storage) => {
    const first = await storage.addEnvironment({
      ...createEnvironment("p", { environmentType: "local" }),
      id: FIRST,
    });
    const base = (await storage.environmentIsolation.assignEnvironmentPortBase(first.id))!;
    const server = createServer((socket) => socket.end("old database"));
    server.listen(base + 19, "127.0.0.1");
    await once(server, "listening");
    try {
      expect(await storage.environmentIsolation.assignEnvironmentPortBase(first.id)).toBe(base);
      await storage.removeEnvironment(first.id);
      const replacement = await storage.addEnvironment({
        ...createEnvironment("p", { environmentType: "local" }),
        id: COLLIDING,
      });
      expect(chooseEnvironmentPortBase(FIRST, new Set())).toBe(
        chooseEnvironmentPortBase(COLLIDING, new Set()),
      );
      const next = (await storage.environmentIsolation.assignEnvironmentPortBase(replacement.id))!;
      expect(next).not.toBe(base);
      expect(await environmentPortBlockAvailable(next)).toBe(true);
      expect(
        withEnvironmentIsolation(
          environmentIsolationVariables(FIRST, base),
          environmentIsolationVariables(COLLIDING, next),
        ).ORKESTRATOR_PORT_MAX,
      ).not.toBe(String(base + 19));
      await storage.removeEnvironment(replacement.id);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(await environmentPortBlockAvailable(base)).toBe(true);
    await storage.addEnvironment(first);
    // The original id can reuse its original (now stopped) block.
    expect(await storage.environmentIsolation.assignEnvironmentPortBase(first.id)).toBe(base);
  });
});

test.skipIf(
  !Object.values(networkInterfaces()).some((entries) =>
    entries?.some((entry) => entry.address === "::1"),
  ),
)("the port probe detects IPv6-only listeners and releases every probe socket", async () => {
  const base = chooseEnvironmentPortBase("ipv6-probe", new Set())!;
  const server = createServer((socket) => socket.destroy());
  server.listen({ host: "::1", port: base + 3, ipv6Only: true });
  await once(server, "listening");
  try {
    expect(await environmentPortBlockAvailable(base)).toBe(false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  expect(await environmentPortBlockAvailable(base)).toBe(true);
  expect(await environmentPortBlockAvailable(base)).toBe(true);
});
