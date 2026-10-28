/**
 * Real pinned Codex + loopback streamable HTTP MCP, with ten concurrent
 * handshakes and controlled delays on initialize. No auth or model turns.
 *
 * RUN_LIVE_CODEX_APP_SERVER=1 mise run test:logged -- --name mcp-startup-live -- \
 *   bun test ./bridges/codex-bridge/src/app-server/mcp-startup.live.test.ts --parallel=1
 *
 * Optional CODEX_MCP_STARTUP_EVIDENCE_PATH saves content-free timing/load JSON.
 * Delaying initialize reproduces a slow backend response; it does not claim
 * to reproduce the production backend's event-loop saturation or its cause.
 */
import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { cpus, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerEngine } from "../engine/app-server-engine.js";
import { resolveCodexBinary } from "./live-binary.js";

const describeLive = process.env.RUN_LIVE_CODEX_APP_SERVER === "1" ? describe : describe.skip;
const TOOL = "submit_consolidated_review";

interface Handshake {
  delayMs: number;
  initializedAt?: number;
  listedAt?: number;
}

describeLive("live MCP startup budget", () => {
  test("ten concurrent slow handshakes connect below 15 s and fail above it", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ork-mcp-startup-")));
    const codexHome = join(root, "home");
    const workspace = join(root, "workspace");
    await mkdir(codexHome);
    await mkdir(workspace);
    const handshakes: Handshake[] = Array.from({ length: 10 }, (_, i) => ({
      delayMs: [4_000, 10_000, 14_000, 17_000][i % 4]!,
    }));
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const server = createServer(async (request, response) => {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const probe = handshakes[Number(request.url?.split("/").at(-1))];
      if (!probe) {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id?: string | number;
        method: string;
        params?: { protocolVersion?: string };
      };
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const reply = (result: unknown) => {
        if (response.destroyed) return;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      };
      if (message.method === "initialize") {
        probe.initializedAt = performance.now();
        const timer = setTimeout(() => {
          timers.delete(timer);
          reply({
            protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "slow-handshake-probe", version: "1.0.0" },
          });
        }, probe.delayMs);
        timers.add(timer);
      } else if (message.method === "tools/list") {
        probe.listedAt = performance.now();
        reply({
          tools: [
            {
              name: TOOL,
              description: "Loopback result probe",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        });
      } else {
        reply({});
      }
    });
    let engine: AppServerEngine | undefined;
    const loadBefore = loadavg();
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Probe did not bind");
      engine = new AppServerEngine({
        codexPath: await resolveCodexBinary(),
        codexHome,
        cwd: workspace,
        clientInfo: { name: "orkestrator", title: "Orkestrator", version: "1.0.0" },
        configOverrides: { openai_base_url: JSON.stringify("http://127.0.0.1:9/v1") },
        supervisorOverrides: { pidFileEnabled: false },
      });
      await engine.start();
      const liveEngine = engine;
      const results = await Promise.all(
        handshakes.map(async (probe, i) => {
          const thread = await liveEngine.startThread({
            config: {
              mode: "build",
              sandbox: "read-only",
              approvalPolicy: "never",
              agentMcp: { url: `http://127.0.0.1:${address.port}/mcp/${i}`, token: "probe-only" },
              workflowResultTool: TOOL,
            },
          });
          // Default options exercise the production 20-second availability wait.
          const availability = await liveEngine.workflowResultToolAvailability(thread.id!, TOOL);
          const settledMs = performance.now() - (probe.initializedAt ?? performance.now());
          expect(probe.initializedAt).toBeDefined();
          if (probe.delayMs < 15_000) {
            expect(availability).toEqual({ state: "available" });
            const handshakeMs = probe.listedAt! - probe.initializedAt!;
            expect(handshakeMs).toBeGreaterThanOrEqual(probe.delayMs);
            expect(handshakeMs).toBeLessThan(15_000);
          } else {
            expect(availability).toEqual({ state: "missing", reason: "could not list its tools" });
            expect(probe.listedAt).toBeUndefined();
            expect(settledMs).toBeGreaterThanOrEqual(14_000);
            expect(settledMs).toBeLessThan(20_000);
          }
          return {
            delayMs: probe.delayMs,
            handshakeMs:
              probe.listedAt === undefined
                ? null
                : Math.round(probe.listedAt - probe.initializedAt!),
            settledMs: Math.round(settledMs),
            availability,
          };
        }),
      );
      // All ten initialize requests must overlap the first successful reply.
      expect(Math.max(...handshakes.map((probe) => probe.initializedAt!))).toBeLessThan(
        Math.min(
          ...handshakes.flatMap((probe) => (probe.listedAt === undefined ? [] : [probe.listedAt])),
        ),
      );
      const evidence = {
        codexVersion: engine.info().codexVersion,
        concurrency: handshakes.length,
        logicalCpus: cpus().length,
        loadBefore,
        loadAfter: loadavg(),
        results,
      };
      if (process.env.CODEX_MCP_STARTUP_EVIDENCE_PATH) {
        await writeFile(
          process.env.CODEX_MCP_STARTUP_EVIDENCE_PATH,
          JSON.stringify(evidence, null, 2),
        );
      }
    } finally {
      await engine?.stop();
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);
});
