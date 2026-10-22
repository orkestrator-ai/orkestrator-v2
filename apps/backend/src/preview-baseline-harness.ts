/**
 * Test-only isolated backend for the preview latency baseline self-test
 * (`scripts/preview-latency-baseline.ts`, `preview-latency-baseline.test.ts`).
 *
 * It runs the real gateway (bearer authentication, the authenticated command
 * API, the legacy loopback route and the desktop tunnel) and the real
 * private-origin listener over the real preview registry and access service,
 * all in temporary directories with a throwaway CA. The command API answers
 * only the preview commands. One synthetic fixture service is registered as
 * `baseline`. It never touches the user's data directory, containers or DNS.
 *
 * Run alone: `bun apps/backend/src/preview-baseline-harness.ts`. It prints one
 * JSON line naming the gateway URL, the token file and the CA file (never the
 * token) and stops when stdin closes or on SIGINT/SIGTERM.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";

import {
  startPreviewFixture,
  type PreviewFixture,
} from "../../../test-fixtures/preview-app/server.ts";
import type { CommandContext, CommandHandler } from "./core/commands-context.js";
import { registerPreviewCommands } from "./core/commands-registry-previews.js";
import { createPreviewHarness, type PreviewHarness } from "./core/preview-test-support.js";
import { OrkestratorGateway } from "./gateway.js";
import { PreviewPublicationManager } from "./preview-publication.js";
import { certificates, TEST_PREVIEW_DOMAIN } from "./preview-test-pki.js";

export const BASELINE_SERVICE_LABEL = "baseline";

export interface PreviewBaselineHarness {
  /** Gateway base URL (`http://127.0.0.1:<port>/`). */
  url: string;
  /** `gateway-auth.json` holding the bearer token. Read it; never print it. */
  tokenFile: string;
  /** Throwaway CA that signed the private-origin certificate. */
  caFile: string;
  /** Preview hosts do not resolve; connect them here. */
  publicationAddress: string;
  domain: string;
  serviceLabel: string;
  fixture: PreviewFixture;
  preview: PreviewHarness;
  close(): Promise<void>;
}

const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined };

export async function startPreviewBaselineHarness(): Promise<PreviewBaselineHarness> {
  const root = await mkdtemp(join(tmpdir(), "ork-preview-baseline-"));
  const pki = join(root, "pki");
  const dataDir = join(root, "data");
  const rendererRoot = join(dataDir, "dist");
  await mkdir(pki);
  await mkdir(rendererRoot, { recursive: true });
  await writeFile(join(rendererRoot, "index.html"), '<div id="root"></div>');
  certificates(pki);

  const fixture = await startPreviewFixture({ marker: "baseline" });
  const preview = await createPreviewHarness({ env: { ORKESTRATOR_PREVIEW_TRANSPORT: "1" } });
  let gateway: OrkestratorGateway | null = null;
  let manager: PreviewPublicationManager | null = null;
  const close = async () => {
    await gateway?.stop().catch(() => undefined);
    await manager?.dispose().catch(() => undefined);
    await fixture.close();
    await preview.cleanup();
    await rm(root, { recursive: true, force: true });
  };

  try {
    await preview.addLocalEnvironment("local");
    await preview.runtime.init();
    const created = await preview.runtime.registry.register({
      environmentId: "local",
      label: BASELINE_SERVICE_LABEL,
      targetKind: "backend-host",
      applicationPort: fixture.port,
      addressFamily: "ipv4",
      readinessPath: "/health",
    });
    if (created.kind !== "definition") throw new Error("expected a service definition");

    await preview.runtime.updateSettings((current) => ({
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
      runtime: preview.runtime,
      logger: { info: () => undefined, warn: () => undefined },
    });
    await manager.start();

    const handlers = new Map<string, CommandHandler>();
    registerPreviewCommands((name, handler) => handlers.set(name, handler));
    const context = { previews: preview.runtime } as unknown as CommandContext;
    gateway = new OrkestratorGateway({
      backend: {
        invoke: async (command, args) => {
          const handler = handlers.get(command);
          if (!handler) throw new Error(`Unknown backend command: ${command}`);
          return handler(args as Parameters<CommandHandler>[0], context);
        },
      },
      dataDir,
      rendererRoot,
      bindAddress: "127.0.0.1",
      port: 0,
      // No ORKESTRATOR_GATEWAY_TOKEN: the gateway writes gateway-auth.json,
      // the same file a qualifier reads on a real backend.
      env: {},
      logger: { ...silent, error: () => undefined },
      allowNonTailscaleBind: true,
      previews: preview.runtime,
    });
    const info = await gateway.start();
    if (!info) throw new Error("the gateway did not start");

    return {
      url: info.url,
      tokenFile: info.authFile,
      caFile: join(pki, "ca.pem"),
      publicationAddress: "127.0.0.1",
      domain: TEST_PREVIEW_DOMAIN,
      serviceLabel: BASELINE_SERVICE_LABEL,
      fixture,
      preview,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

if (import.meta.main) {
  installFatalRejectionGuard({ label: "[preview-baseline-harness]" });
  const harness = await startPreviewBaselineHarness();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await harness.close();
    process.exit(0);
  };
  process.stdout.write(
    `${JSON.stringify({
      type: "ready",
      url: harness.url,
      tokenFile: harness.tokenFile,
      caFile: harness.caFile,
      publicationAddress: harness.publicationAddress,
      service: harness.serviceLabel,
    })}\n`,
  );
  process.stdin.on("end", () => void shutdown());
  process.stdin.on("close", () => void shutdown());
  process.stdin.resume();
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
