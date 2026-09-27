import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";

import { createPreviewHarness, type PreviewHarness } from "./core/preview-test-support.js";
import { PreviewPublicationManager } from "./preview-publication.js";
import { certificates, TEST_PREVIEW_DOMAIN } from "./preview-test-pki.js";

/**
 * Opt-in pinned-framework check: the Vite 7 fixture's page, module graph, and
 * HMR socket through a private preview origin. Install the fixture into an
 * isolated copy first (see test-fixtures/preview-vite/README.md), then run with
 * `ORKESTRATOR_TEST_PREVIEW_VITE_DIR=/tmp/preview-vite`. This proves the
 * transport carries HMR updates; it does not execute the client in a browser.
 */
const viteDir = process.env.ORKESTRATOR_TEST_PREVIEW_VITE_DIR;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

describe.skipIf(!viteDir)("Vite 7 fixture through a private preview origin", () => {
  let pki: string;
  let ca: string;
  let harness: PreviewHarness;
  let manager: PreviewPublicationManager;
  let vite: ChildProcess;
  let port: number;
  let host: string;
  let cookie: string;
  const labelFile = join(viteDir ?? "", "src", "label.js");
  let originalLabel = "";

  function request(path: string, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
      (resolve, reject) => {
        const req = httpsRequest(
          {
            host: "127.0.0.1",
            port,
            servername: host,
            ca,
            path,
            method: "GET",
            headers: { host: `${host}:${port}`, cookie, ...headers },
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
        req.end();
      },
    );
  }

  beforeAll(async () => {
    originalLabel = await readFile(labelFile, "utf8");
    const vitePort = await freePort();
    vite = spawn(
      process.execPath,
      [
        join(viteDir!, "node_modules/vite/bin/vite.js"),
        "--host",
        "127.0.0.1",
        "--port",
        String(vitePort),
        "--strictPort",
      ],
      { cwd: viteDir, stdio: "ignore" },
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const up = await fetch(`http://127.0.0.1:${vitePort}/`).then(
        (response) => response.ok,
        () => false,
      );
      if (up) break;
      await Bun.sleep(100);
    }

    pki = await mkdtemp(join(tmpdir(), "ork-preview-vite-"));
    certificates(pki);
    ca = await readFile(join(pki, "ca.pem"), "utf8");
    harness = await createPreviewHarness({ env: { ORKESTRATOR_PREVIEW_TRANSPORT: "1" } });
    await harness.addLocalEnvironment("local");
    await harness.runtime.init();
    const created = await harness.runtime.registry.register({
      environmentId: "local",
      label: "vite",
      targetKind: "backend-host",
      applicationPort: vitePort,
      addressFamily: "ipv4",
    });
    if (created.kind !== "definition") throw new Error("expected definition");
    await harness.runtime.updateSettings((current) => ({
      ...current,
      publication: {
        ...current.publication,
        enabled: true,
        domain: TEST_PREVIEW_DOMAIN,
        certFile: join(pki, "leaf.pem"),
        keyFile: join(pki, "leaf.key"),
        listenAddress: "127.0.0.1",
        port: 0,
      },
    }));
    manager = new PreviewPublicationManager({
      runtime: harness.runtime,
      logger: { info: () => undefined, warn: () => undefined },
    });
    await manager.start();
    port = manager.status().listening!.port;

    const attachment = await harness.runtime.access.createAttachment({
      serviceId: created.definition.serviceId,
      surface: "browser-top-level",
    });
    const { code, origin } = harness.runtime.access.consumeBootstrapGrant(
      attachment.attachmentId,
      attachment.bootstrap!.grant,
    );
    host = new URL(origin).hostname;
    cookie = "";
    const session = await request(
      `/__orkestrator_preview/session?code=${encodeURIComponent(code)}`,
    );
    expect(session.status).toBe(303);
    cookie = String(session.headers["set-cookie"]).split(";")[0]!;
  }, 30_000);

  afterAll(async () => {
    if (originalLabel) await writeFile(labelFile, originalLabel);
    vite?.kill("SIGTERM");
    await manager?.dispose();
    await harness?.cleanup();
    if (pki) await rm(pki, { recursive: true, force: true });
  });

  test("page, client, and modules are served unchanged from the preview origin", async () => {
    const page = await request("/");
    expect(page.status).toBe(200);
    expect(page.body).toContain('data-service-marker="preview-vite"');
    expect(page.body).toContain("/@vite/client");
    const client = await request("/@vite/client");
    expect(client.status).toBe(200);
    expect(String(client.headers["content-type"])).toContain("javascript");
    const main = await request("/src/main.js");
    expect(main.body).toContain("import.meta.hot");
  });

  test("the HMR socket upgrades and delivers an update for an edited module", async () => {
    const client = await request("/@vite/client");
    const token = /const wsToken = "([^"]+)"/.exec(client.body)?.[1];
    expect(token).toBeTruthy();
    const received = await new Promise<string>((resolve, reject) => {
      const socket = tlsConnect({ host: "127.0.0.1", port, servername: host, ca }, () => {
        socket.write(
          [
            `GET /?token=${encodeURIComponent(token!)} HTTP/1.1`,
            `Host: ${host}:${port}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Protocol: vite-hmr",
            `Origin: https://${host}:${port}`,
            `Cookie: ${cookie}`,
            "",
            "",
          ].join("\r\n"),
        );
      });
      let text = "";
      let edited = false;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`no HMR update; received: ${text.slice(0, 200)}`));
      }, 15_000);
      socket.on("data", (chunk) => {
        text += chunk.toString("latin1");
        if (!edited && text.includes('"type":"connected"')) {
          edited = true;
          void writeFile(labelFile, 'export const label = "preview-vite v2";\n');
        }
        if (text.includes('"type":"update"') && text.includes("label.js")) {
          clearTimeout(timer);
          socket.destroy();
          resolve(text);
        }
      });
      socket.on("error", reject);
    });
    expect(received).toStartWith("HTTP/1.1 101");
    expect(received.toLowerCase()).toContain("sec-websocket-protocol: vite-hmr");
  }, 30_000);
});
