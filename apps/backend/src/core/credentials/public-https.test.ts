import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates, type TLSSocket } from "node:tls";
import { certificates } from "../../preview-test-pki.js";
import { prepareCredentialHttpRequest, sendCredentialHttpRequest } from "./http-operation.js";
import { resolvePublicAddress } from "./public-https.js";

const publicV4 = "8.8.8.8";
const dns =
  (...ips: string[]) =>
  async () =>
    ips.map((address) => ({ address }));

test.each([
  "10.10.10.10",
  "172.16.4.5",
  "192.168.4.5",
  "100.64.0.1",
  "169.254.9.8",
  "::1",
  "::ffff:127.0.0.1",
  "fd11::1",
  "fe80::5",
  "fe80::3%en0",
  "64:ff9b::0808:0808",
  "2002:7f00:1::",
  "2001:db8::1",
  "invalid",
])("DNS rejects a mixed answer with nonpublic address %s", async (address) => {
  expect(await resolvePublicAddress("fixture.invalid", dns(publicV4, address))).toBeNull();
});

test("DNS accepts only a completed, bounded public answer", async () => {
  const host = "fixture.invalid";
  const publicV6 = "2606:4700:4700::1111";
  expect(await resolvePublicAddress(host, dns(publicV6, publicV4))).toBe(publicV6);
  expect(await resolvePublicAddress(host, dns(...Array<string>(64).fill(publicV4)))).toBe(publicV4);
  expect(await resolvePublicAddress(host, dns(...Array<string>(65).fill(publicV4)))).toBeNull();
  expect(await resolvePublicAddress(host, dns())).toBeNull();
  const late = Promise.withResolvers<readonly { address: string }[]>();
  expect(await resolvePublicAddress(host, () => late.promise, 10)).toBeNull();
  late.resolve([{ address: publicV4 }]);
});

test("production HTTPS pins the address, validates TLS identity and returns redirects and lost answers", async () => {
  const host = "approved.credential.invalid";
  const directory = await mkdtemp(join(tmpdir(), "credential-test-tls-"));
  const defaultCAs = getCACertificates("default");
  const servers = new Set<ReturnType<typeof createServer>>();
  try {
    certificates(directory, [host]);
    const [cert, key, ca] = await Promise.all(
      ["leaf.pem", "leaf.key", "ca.pem"].map((file) => readFile(join(directory, file), "utf8")),
    );
    setDefaultCACertificates([...defaultCAs, ca!]);
    const seen: Array<{
      host?: string;
      sni?: string | false | null;
      encoding?: string;
      url?: string;
    }> = [];
    let arrived = Promise.withResolvers<void>();
    const server = createServer({ cert, key }, (request, response) => {
      seen.push({
        host: request.headers.host,
        sni: (request.socket as TLSSocket).servername,
        encoding: request.headers["accept-encoding"],
        url: request.url,
      });
      arrived.resolve();
      if (request.url === "/stalled") return;
      if (request.url === "/lost") {
        request.socket.destroy();
        return;
      }
      response.writeHead(302, { location: "/would-have-followed" }).end("redirected");
    });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const send = (
      path: string,
      options: { hostname?: string; signal?: AbortSignal; timeoutMs?: number } = {},
    ) => {
      const target = `${options.hostname ?? host}:${port}`;
      const request = prepareCredentialHttpRequest(
        { method: "GET", url: `https://${target}${path}` },
        { hosts: [target], auth: { scheme: "bearer" } },
      );
      return sendCredentialHttpRequest(request, {}, [], {
        address: "127.0.0.1",
        signal: options.signal ?? new AbortController().signal,
        timeoutMs: options.timeoutMs ?? 2_000,
      });
    };

    expect(await send("/check?key=fixture")).toMatchObject({
      kind: "answered",
      answer: { status: 302, headers: { location: "/would-have-followed" }, body: "redirected" },
    });
    expect(seen).toEqual([
      { host: `${host}:${port}`, sni: host, encoding: "identity", url: "/check?key=fixture" },
    ]);
    expect(await send("/wrong-name", { hostname: "wrong.credential.invalid" })).toMatchObject({
      kind: "not-sent",
    });
    expect(seen).toHaveLength(1);
    expect(await send("/lost")).toMatchObject({ kind: "unknown" });

    arrived = Promise.withResolvers<void>();
    const abort = new AbortController();
    const aborted = send("/stalled", { signal: abort.signal });
    await arrived.promise;
    abort.abort();
    expect(await aborted).toMatchObject({ kind: "unknown", reason: "cancelled" });
    expect(await send("/stalled", { timeoutMs: 200 })).toMatchObject({
      kind: "unknown",
      reason: "timeout",
    });
    expect(seen.at(-1)?.url).toBe("/stalled");
  } finally {
    setDefaultCACertificates(defaultCAs);
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(directory, { recursive: true, force: true });
  }
});
