/**
 * Test-only entrypoint for real-browser preview checks
 * (`e2e/preview/private-origin.spec.ts`). It runs the actual backend preview
 * stack — registry, access, and the private-origin listener — against
 * synthetic fixtures in a temporary data directory, prints one JSON line with
 * what the browser needs, and answers `grant <service>` lines on stdin with a
 * fresh one-use grant. It exits when stdin closes. It never touches the user's
 * data directory, containers, or DNS.
 */
import { execFileSync } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";

import { startPreviewFixture } from "../../../test-fixtures/preview-app/server.ts";
import { createPreviewHarness } from "./core/preview-test-support.js";
import { PreviewPublicationManager } from "./preview-publication.js";
import { certificates, TEST_PREVIEW_DOMAIN } from "./preview-test-pki.js";

installFatalRejectionGuard({ label: "[preview-browser-harness]" });

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** Chromium's `--ignore-certificate-errors-spki-list` pin for the test leaf only. */
function spkiPin(leaf: string): string {
  const der = execFileSync("sh", [
    "-c",
    `openssl x509 -in "${leaf}" -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`,
  ]);
  return der.toString("utf8").trim();
}

const pki = await mkdtemp(join(tmpdir(), "ork-preview-browser-"));
certificates(pki);
const fixture = await startPreviewFixture({ marker: "browser-app" });
const other = await startPreviewFixture({ marker: "browser-other" });
const harness = await createPreviewHarness({ env: { ORKESTRATOR_PREVIEW_TRANSPORT: "1" } });
await harness.addLocalEnvironment("local");
await harness.runtime.init();

async function register(label: string, port: number): Promise<string> {
  const created = await harness.runtime.registry.register({
    environmentId: "local",
    label,
    targetKind: "backend-host",
    applicationPort: port,
    addressFamily: "ipv4",
  });
  if (created.kind !== "definition") throw new Error("expected definition");
  return created.definition.serviceId;
}

const services: Record<string, string> = {
  app: await register("app", fixture.port),
  other: await register("other", other.port),
};

let vite: ChildProcess | null = null;
const viteDir = process.env.ORKESTRATOR_TEST_PREVIEW_VITE_DIR;
if (viteDir) {
  const vitePort = await freePort();
  vite = spawn(
    process.execPath,
    [
      join(viteDir, "node_modules/vite/bin/vite.js"),
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
  services.vite = await register("vite", vitePort);
}

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
const manager = new PreviewPublicationManager({
  runtime: harness.runtime,
  logger: { info: () => undefined, warn: () => undefined },
});
await manager.start();

async function grant(name: string) {
  const serviceId = services[name];
  if (!serviceId) return { error: "unknown service" };
  const attachment = await harness.runtime.access.createAttachment({
    serviceId,
    surface: "browser-top-level",
    path: "/",
  });
  return {
    action: attachment.bootstrap!.action,
    attachmentId: attachment.attachmentId,
    grant: attachment.bootstrap!.grant,
    origin: attachment.bootstrap!.origin,
  };
}

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  vite?.kill("SIGTERM");
  await manager.dispose();
  await fixture.close();
  await other.close();
  await harness.cleanup();
  await rm(pki, { recursive: true, force: true });
  process.exit(0);
}

process.stdout.write(
  `${JSON.stringify({
    type: "ready",
    port: manager.status().listening!.port,
    domain: TEST_PREVIEW_DOMAIN,
    spki: spkiPin(join(pki, "leaf.pem")),
    services: Object.keys(services),
  })}\n`,
);

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const [command, name] = line.trim().split(/\s+/);
  if (command === "grant" && name) {
    void grant(name).then((result) =>
      process.stdout.write(`${JSON.stringify({ type: "grant", name, ...result })}\n`),
    );
  } else if (command === "revoke") {
    const revoked = harness.runtime.access.revokeAll("operator-revoked");
    process.stdout.write(`${JSON.stringify({ type: "revoked", revoked })}\n`);
  } else if (command === "metrics") {
    process.stdout.write(
      `${JSON.stringify({ type: "metrics", counters: harness.runtime.metrics.snapshot().counters })}\n`,
    );
  } else if (command === "fixture-requests") {
    const source = name === "other" ? other : fixture;
    process.stdout.write(
      `${JSON.stringify({
        type: "fixture-requests",
        name: name ?? "app",
        requests: source.requests.map((request) => ({
          method: request.method,
          path: request.path,
          cookie: request.cookie ?? null,
          origin: request.origin ?? null,
        })),
      })}\n`,
    );
  }
});
lines.on("close", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
