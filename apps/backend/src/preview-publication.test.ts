import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";

import { PREVIEW_SESSION_COOKIE } from "@orkestrator/protocol/preview-access";

import {
  startPreviewFixture,
  type PreviewFixture,
} from "../../../test-fixtures/preview-app/server.ts";
import { createPreviewHarness, type PreviewHarness } from "./core/preview-test-support.js";
import { PreviewPublicationManager } from "./preview-publication.js";
import { certificates } from "./preview-test-pki.js";

const DOMAIN = "preview.test";

interface Response {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

describe("PreviewPublicationManager (private HTTPS origins)", () => {
  let dir: string;
  let ca: string;
  let harness: PreviewHarness;
  let fixture: PreviewFixture;
  let manager: PreviewPublicationManager;
  let serviceId: string;
  let port: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ork-preview-pki-"));
    certificates(dir);
    ca = await readFile(join(dir, "ca.pem"), "utf8");
    fixture = await startPreviewFixture({ marker: "published-app" });
    harness = await createPreviewHarness({ env: { ORKESTRATOR_PREVIEW_TRANSPORT: "1" } });
    await harness.addLocalEnvironment("local");
    await harness.runtime.init();
    const created = await harness.runtime.registry.register({
      environmentId: "local",
      label: "app",
      targetKind: "backend-host",
      applicationPort: fixture.port,
      addressFamily: "ipv4",
    });
    if (created.kind !== "definition") throw new Error("expected definition");
    serviceId = created.definition.serviceId;
    await harness.runtime.updateSettings((current) => ({
      ...current,
      publication: {
        ...current.publication,
        enabled: true,
        domain: DOMAIN,
        certFile: join(dir, "leaf.pem"),
        keyFile: join(dir, "leaf.key"),
        listenAddress: "127.0.0.1",
        port: 0,
      },
    }));
    manager = new PreviewPublicationManager({
      runtime: harness.runtime,
      logger: { info: () => undefined, warn: () => undefined },
      certificateCheckMs: 50,
    });
    await manager.start();
    port = manager.status().listening!.port;
  });

  afterEach(async () => {
    await manager.dispose();
    await fixture.close();
    await harness.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  function request(
    host: string,
    path: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      sni?: string;
    } = {},
  ): Promise<Response> {
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        {
          host: "127.0.0.1",
          port,
          servername: options.sni ?? host,
          ca,
          path,
          method: options.method ?? "GET",
          headers: { host: `${host}:${port}`, ...options.headers },
          agent: false,
        },
        (response) => {
          let body = "";
          response.on("data", (chunk) => (body += chunk));
          response.on("end", () =>
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
          );
        },
      );
      req.on("error", reject);
      req.end(options.body);
    });
  }

  async function signIn(
    path = "/app/start?x=1",
    target = serviceId,
  ): Promise<{ cookie: string; host: string; landing: Response }> {
    const attachment = await harness.runtime.access.createAttachment({
      serviceId: target,
      surface: "browser-top-level",
      path,
    });
    const bootstrap = attachment.bootstrap!;
    expect(bootstrap.action).toBe(`https://bootstrap.${DOMAIN}:${port}/bootstrap`);
    const host = new URL(bootstrap.origin).hostname;
    const form = new URLSearchParams({
      attachment: attachment.attachmentId,
      grant: bootstrap.grant,
    }).toString();
    const handoff = await request(`bootstrap.${DOMAIN}`, "/bootstrap", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(form.length),
      },
      body: form,
    });
    expect(handoff.status).toBe(303);
    expect(handoff.headers["referrer-policy"]).toBe("no-referrer");
    const location = new URL(String(handoff.headers.location));
    expect(location.hostname).toBe(host);
    // The grant itself never appears in any URL.
    expect(String(handoff.headers.location)).not.toContain(bootstrap.grant);
    const session = await request(host, `${location.pathname}${location.search}`);
    expect(session.status).toBe(303);
    expect(session.headers.location).toBe(path);
    const setCookie = String(session.headers["set-cookie"]);
    expect(setCookie).toContain(`${PREVIEW_SESSION_COOKIE}=`);
    expect(setCookie).toContain("Path=/; Secure; HttpOnly");
    expect(setCookie).not.toMatch(/Domain=/i);
    const cookie = setCookie.split(";")[0]!;
    return { cookie, host, landing: session };
  }

  test("advertises top-level browser publication only when the listener and certificate are ready", () => {
    expect(harness.runtime.capabilities().surfaces.browserTopLevel).toEqual({
      available: true,
      upstreamSchemes: ["http", "https"],
    });
    expect(harness.runtime.capabilities().surfaces.browserEmbedded.available).toBe(false);
  });

  test("bootstrap establishes a host-only session and the full origin serves the app unchanged", async () => {
    const { cookie, host } = await signIn();
    const page = await request(host, "/", {
      headers: { cookie: `${cookie}; app=1`, authorization: "Bearer fixture-app-token" },
    });
    expect(page.status).toBe(200);
    expect(page.headers["x-service-marker"]).toBe("published-app");
    expect(page.body).toContain('href="/assets/app.css"');
    const reached = fixture.requests.at(-1)!;
    expect(reached.cookie).toBe("app=1");
    expect(reached.authorization).toBe("Bearer fixture-app-token");
    expect(reached.forwardedHost).toBe(`${host}:${port}`);
    expect(reached.forwardedProto).toBe("https");
    const cookies = await request(host, "/cookies/set", { headers: { cookie } });
    expect(cookies.headers["set-cookie"]).toEqual([
      "__Host-session=synthetic; Path=/; Secure; HttpOnly; SameSite=Lax",
      "plain=published-app; Path=/",
      "widened=1; Path=/",
    ]);
  });

  test("grants are one-use and sessions are bound to their own host", async () => {
    const attachment = await harness.runtime.access.createAttachment({
      serviceId,
      surface: "browser-top-level",
    });
    const form = new URLSearchParams({
      attachment: attachment.attachmentId,
      grant: attachment.bootstrap!.grant,
    }).toString();
    const headers = {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": String(form.length),
    };
    expect(
      (await request(`bootstrap.${DOMAIN}`, "/bootstrap", { method: "POST", headers, body: form }))
        .status,
    ).toBe(303);
    expect(
      (await request(`bootstrap.${DOMAIN}`, "/bootstrap", { method: "POST", headers, body: form }))
        .status,
    ).toBe(403);

    const other = await harness.runtime.registry.register({
      environmentId: "local",
      label: "other",
      targetKind: "backend-host",
      applicationPort: 1 + fixture.port,
    });
    if (other.kind !== "definition") throw new Error("expected definition");
    const otherHost = new URL(manager.originFor(other.definition.serviceId)!).hostname;
    const { cookie } = await signIn();
    expect((await request(otherHost, "/", { headers: { cookie } })).status).toBe(401);
  });

  test("unknown hosts, control paths, and reserved paths never reach control dispatch", async () => {
    expect((await request(`control.${DOMAIN}`, "/__orkestrator/invoke")).status).toBe(421);
    // DNS or SNI that reaches this listener does not make a Host acceptable.
    expect((await request("evil.example", "/", { sni: `bootstrap.${DOMAIN}` })).status).toBe(421);
    const { cookie, host } = await signIn();
    // A control-looking path is just an application path on a preview host.
    const control = await request(host, "/__orkestrator/invoke", { headers: { cookie } });
    expect(control.status).toBe(404);
    expect(control.body).toContain("not found: published-app");
    expect(
      (await request(host, "/__orkestrator_preview/anything", { headers: { cookie } })).status,
    ).toBe(404);
  });

  test("cross-site writes are refused before forwarding; same-origin writes pass", async () => {
    const { cookie, host } = await signIn();
    const body = "payload";
    const headers = { cookie, "content-type": "text/plain", "content-length": String(body.length) };
    const blocked = await request(host, "/echo", {
      method: "POST",
      headers: { ...headers, origin: "https://evil.example" },
      body,
    });
    expect(blocked.status).toBe(403);
    expect(fixture.requests.some((entry) => entry.path === "/echo")).toBe(false);
    const allowed = await request(host, "/echo", {
      method: "POST",
      headers: { ...headers, origin: `https://${host}:${port}` },
      body,
    });
    expect(allowed.status).toBe(200);
    expect(fixture.requests.at(-1)?.origin).toBe(`http://localhost:${fixture.port}`);
  });

  test("revocation denies new requests", async () => {
    const { cookie, host } = await signIn();
    harness.runtime.access.revokeServices([serviceId], "operator-revoked");
    expect((await request(host, "/", { headers: { cookie } })).status).toBe(401);
  });

  test("application WebSockets upgrade through the published origin with the session", async () => {
    const { cookie, host } = await signIn();
    const key = "dGhlIHNhbXBsZSBub25jZQ==";
    const response = await new Promise<string>((resolve, reject) => {
      const socket = tlsConnect({ host: "127.0.0.1", port, servername: host, ca }, () => {
        socket.write(
          [
            "GET /ws HTTP/1.1",
            `Host: ${host}:${port}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Key: ${key}`,
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Protocol: fixture.v1",
            `Origin: https://${host}:${port}`,
            `Cookie: ${cookie}`,
            "",
            "",
          ].join("\r\n"),
        );
      });
      let text = "";
      socket.on("data", (chunk) => {
        text += chunk.toString("latin1");
        if (text.includes("published-app")) {
          socket.destroy();
          resolve(text);
        }
      });
      socket.on("error", reject);
    });
    expect(response).toStartWith("HTTP/1.1 101");
    expect(response.toLowerCase()).toContain("sec-websocket-protocol: fixture.v1");
  });

  test("a certificate that does not cover the preview hosts disables publication", async () => {
    await manager.dispose();
    await rm(join(dir, "ca.pem"));
    certificates(dir, ["other.example"]);
    manager = new PreviewPublicationManager({
      runtime: harness.runtime,
      logger: { info: () => undefined, warn: () => undefined },
    });
    await manager.start();
    expect(manager.status()).toMatchObject({
      available: false,
      reason: expect.stringContaining("does not cover"),
    });
    expect(harness.runtime.capabilities().surfaces.browserTopLevel.available).toBe(false);
    // Desktop transport is independent of publication.
    expect(harness.runtime.capabilities().access.available).toBe(true);
  });

  test("renewed certificates are picked up by re-binding on the same port", async () => {
    const before = manager.status().certificate!.validTo;
    await Bun.sleep(1_100);
    certificates(dir);
    await Bun.sleep(200);
    expect(manager.status().listening?.port).toBe(port);
    expect(manager.status().certificate!.validTo).not.toBe(before);
  });

  test("public binds are refused", async () => {
    await harness.runtime.updateSettings((current) => ({
      ...current,
      publication: { ...current.publication, listenAddress: "0.0.0.0" },
    }));
    await manager.reconfigure();
    expect(manager.status()).toMatchObject({
      available: false,
      reason: expect.stringContaining("loopback or a Tailscale address"),
    });
  });

  test("disabling publication stops advertising an origin", async () => {
    await harness.runtime.updateSettings((current) => ({
      ...current,
      publication: { ...current.publication, enabled: false },
    }));
    await manager.reconfigure();
    expect(manager.originFor(serviceId)).toBeNull();
    expect(harness.runtime.capabilities().surfaces.browserTopLevel.available).toBe(false);
    await writeFile(join(dir, "unused"), "");
  });

  test("HTTPS upstreams are verified against the configured name and trust, never skipped", async () => {
    const upstreamDir = join(dir, "upstream");
    await mkdir(upstreamDir);
    certificates(upstreamDir, ["localhost"]);
    const upstream = createHttpsServer(
      {
        cert: await readFile(join(upstreamDir, "leaf.pem")),
        key: await readFile(join(upstreamDir, "leaf.key")),
      },
      (_request, response) => response.end("secure-upstream"),
    );
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    try {
      const created = await harness.runtime.registry.register({
        environmentId: "local",
        label: "secure",
        targetKind: "backend-host",
        applicationPort: upstreamPort,
        addressFamily: "ipv4",
        scheme: "https",
        tlsServerName: "localhost",
      });
      if (created.kind !== "definition") throw new Error("expected definition");
      const secureId = created.definition.serviceId;

      // Untrusted: the private CA is not configured yet.
      let session = await signIn("/", secureId);
      const untrusted = await request(session.host, "/", { headers: { cookie: session.cookie } });
      expect(untrusted.status).toBe(502);
      expect(untrusted.headers["x-orkestrator-preview-error"]).toBe("tls-failed");

      await harness.runtime.updateSettings((current) => ({
        ...current,
        publication: { ...current.publication, upstreamCaFile: join(upstreamDir, "ca.pem") },
      }));
      await manager.reconfigure();
      session = await signIn("/", secureId);
      const trusted = await request(session.host, "/", { headers: { cookie: session.cookie } });
      expect(trusted.status).toBe(200);
      expect(trusted.body).toBe("secure-upstream");

      const renamed = await harness.runtime.registry.update(
        secureId,
        created.definition.definitionRevision,
        { tlsServerName: "wrong.test" },
      );
      if (renamed.kind !== "definition") throw new Error("expected definition");
      session = await signIn("/", secureId);
      const mismatch = await request(session.host, "/", { headers: { cookie: session.cookie } });
      expect(mismatch.status).toBe(502);
      expect(mismatch.headers["x-orkestrator-preview-error"]).toBe("tls-failed");
    } finally {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
