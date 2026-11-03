import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";

import type { AuthenticatedPreviewAccess } from "./core/preview-access.js";
import type { ResolvedPreviewTarget } from "./core/preview-service-registry.js";
import { PreviewUpstreamPool, type PreviewUpstreamPoolLimits } from "./preview-upstream-pool.js";

/** An access service stand-in that records tracked resources, as revocation closes them. */
class FakeAccess {
  readonly resources = new Map<string, Set<{ close(): void }>>();
  refuse = false;

  track(access: AuthenticatedPreviewAccess, resource: { close(): void }): () => void {
    if (this.refuse) throw new Error("access-expired");
    const set = this.resources.get(access.attachmentId) ?? new Set();
    set.add(resource);
    this.resources.set(access.attachmentId, set);
    return () => set.delete(resource);
  }

  revoke(attachmentId: string): void {
    const set = this.resources.get(attachmentId);
    for (const resource of Array.from(set ?? [])) {
      set!.delete(resource);
      resource.close();
    }
  }

  tracked(attachmentId: string): number {
    return this.resources.get(attachmentId)?.size ?? 0;
  }
}

const access = (
  attachmentId: string,
  generation = 1,
  serviceId = "svc",
): AuthenticatedPreviewAccess => ({
  attachmentId,
  serviceId,
  environmentId: "env",
  surface: "browser-top-level",
  generation,
  expiresAt: Number.MAX_SAFE_INTEGER,
});

const target = (port: number, bindingKey = "binding-1"): ResolvedPreviewTarget => ({
  transportKind: "backend-loopback",
  host: "127.0.0.1",
  port,
  addressFamily: "ipv4",
  containerId: null,
  ownership: "user-registered",
  bindingKey,
  tls: null,
});

describe("PreviewUpstreamPool", () => {
  let server: Server;
  let port: number;
  let fake: FakeAccess;
  const accepted: Socket[] = [];
  const opened: Socket[] = [];
  /** Accepted peers no `socket()` call has claimed yet, keyed by the client's local port. */
  const unclaimed = new Map<number, Socket>();
  const claimants = new Map<number, (peer: Socket) => void>();

  const limits = (
    overrides: Partial<PreviewUpstreamPoolLimits> = {},
  ): PreviewUpstreamPoolLimits => ({
    perAccess: 4,
    total: 8,
    idleMs: 60_000,
    ...overrides,
  });

  /**
   * Opens a client and waits for the server to accept it, returning both ends.
   * The client's `connect` can fire before the server's connection callback, so
   * the peer is matched by port rather than taken as the latest accepted socket.
   */
  async function socket(): Promise<{ client: Socket; peer: Socket }> {
    const client = connect(port, "127.0.0.1");
    opened.push(client);
    await new Promise((resolve) => client.once("connect", resolve));
    const localPort = client.localPort!;
    const peer =
      unclaimed.get(localPort) ??
      (await new Promise<Socket>((resolve) => claimants.set(localPort, resolve)));
    unclaimed.delete(localPort);
    // Handed back paused, the way the HTTP client returns a reusable connection.
    client.pause();
    return { client, peer };
  }

  async function closed(client: Socket): Promise<void> {
    for (let attempt = 0; attempt < 100 && !client.destroyed; attempt += 1) await Bun.sleep(5);
    expect(client.destroyed).toBe(true);
  }

  beforeEach(async () => {
    fake = new FakeAccess();
    accepted.length = 0;
    opened.length = 0;
    unclaimed.clear();
    claimants.clear();
    server = createServer((peer) => {
      accepted.push(peer);
      peer.on("error", () => undefined);
      const claim = claimants.get(peer.remotePort!);
      if (claim) {
        claimants.delete(peer.remotePort!);
        claim(peer);
      } else {
        unclaimed.set(peer.remotePort!, peer);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    for (const client of opened) client.destroy();
    for (const peer of accepted) peer.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("hands a returned connection back to the same access, generation and target", async () => {
    const pool = new PreviewUpstreamPool(fake, limits());
    const { client: first } = await socket();
    pool.put(access("a"), target(port), first);
    expect(pool.stats().idle).toBe(1);
    expect(fake.tracked("a")).toBe(1);

    expect(pool.take(access("b"), target(port))).toBeNull();
    const taken = pool.take(access("a"), target(port));
    expect(taken).toBe(first);
    expect(taken!.isPaused()).toBe(true);
    expect(pool.stats()).toMatchObject({ idle: 0, accesses: 0, reused: 1 });
    // An empty pool holds no registration with the access service.
    expect(fake.tracked("a")).toBe(0);
    expect(pool.take(access("a"), target(port))).toBeNull();
  });

  test("a different generation or target drops the access's idle connections", async () => {
    const pool = new PreviewUpstreamPool(fake, limits());
    const { client: first } = await socket();
    pool.put(access("a", 1), target(port), first);
    expect(pool.take(access("a", 2), target(port))).toBeNull();
    await closed(first);

    const { client: second } = await socket();
    pool.put(access("a", 1), target(port, "binding-1"), second);
    expect(pool.take(access("a", 1), target(port, "binding-2"))).toBeNull();
    await closed(second);
    expect(pool.stats()).toMatchObject({ idle: 0, dropped: 2 });
  });

  test("revoking the access closes its idle connections at once", async () => {
    const pool = new PreviewUpstreamPool(fake, limits());
    const mine = [(await socket()).client, (await socket()).client];
    const { client: other } = await socket();
    for (const client of mine) pool.put(access("a"), target(port), client);
    pool.put(access("b"), target(port), other);
    fake.revoke("a");
    for (const client of mine) await closed(client);
    expect(other.destroyed).toBe(false);
    expect(pool.stats()).toMatchObject({ idle: 1, accesses: 1 });
  });

  test("an access that can no longer be tracked keeps nothing", async () => {
    const pool = new PreviewUpstreamPool(fake, limits());
    fake.refuse = true;
    const { client } = await socket();
    pool.put(access("a"), target(port), client);
    await closed(client);
    expect(pool.stats().idle).toBe(0);
  });

  test("dropping a service closes every access's idle connections for it", async () => {
    const pool = new PreviewUpstreamPool(fake, limits());
    const { client: mine } = await socket();
    const { client: other } = await socket();
    pool.put(access("a", 1, "svc"), target(port), mine);
    pool.put(access("b", 1, "other"), target(port), other);
    pool.dropService("svc");
    await closed(mine);
    expect(other.destroyed).toBe(false);
    pool.dispose();
    await closed(other);
    // After disposal nothing is kept.
    const { client: late } = await socket();
    pool.put(access("c"), target(port), late);
    await closed(late);
  });

  test("per-access and total bounds close the surplus", async () => {
    const pool = new PreviewUpstreamPool(fake, limits({ perAccess: 2, total: 3 }));
    const clients = (await Promise.all(Array.from({ length: 4 }, () => socket()))).map(
      ({ client }) => client,
    );
    for (const client of clients.slice(0, 3)) pool.put(access("a"), target(port), client);
    await closed(clients[2]!);
    pool.put(access("b"), target(port), clients[3]!);
    expect(pool.stats().idle).toBe(3);
    const { client: overflow } = await socket();
    pool.put(access("c"), target(port), overflow);
    await closed(overflow);
    expect(pool.stats().idle).toBe(3);
  });

  test("idle connections expire, and one the application closes is never handed out", async () => {
    const pool = new PreviewUpstreamPool(fake, limits({ idleMs: 30 }));
    const { client: expiring } = await socket();
    pool.put(access("a"), target(port), expiring);
    await closed(expiring);
    expect(fake.tracked("a")).toBe(0);

    const long = new PreviewUpstreamPool(fake, limits());
    const { client, peer } = await socket();
    long.put(access("a"), target(port), client);
    peer.end();
    await closed(client);
    expect(long.take(access("a"), target(port))).toBeNull();

    // Unexpected bytes on an idle connection mean broken framing: closed too.
    const { client: chatty, peer: chattyPeer } = await socket();
    long.put(access("a"), target(port), chatty);
    chattyPeer.write("HTTP/1.1 200 OK\r\n\r\n");
    await closed(chatty);
  });
});
