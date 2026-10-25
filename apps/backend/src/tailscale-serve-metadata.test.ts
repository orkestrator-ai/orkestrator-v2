import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { request } from "node:https";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";

import { crossSiteViolation } from "@orkestrator/protocol/preview-header-policy";
import { TailscaleServeManager } from "./tailscale-serve.js";

const run = promisify(execFile);
const live = process.env.ORKESTRATOR_TEST_TAILSCALE_SERVE_METADATA === "1";
const metadataNames = ["sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-purpose"];

function metadata(headers: IncomingHttpHeaders): Record<string, string> {
  return Object.fromEntries(
    metadataNames.flatMap((name) =>
      typeof headers[name] === "string" ? [[name, headers[name]]] : [],
    ),
  );
}

/**
 * Opt-in transport qualification, not a mock or a claim about browser behavior.
 * Uses a free, dedicated HTTPS port; start refuses existing listeners, and
 * scoped teardown removes only our root handler. Never prints tailnet names.
 */
test.skipIf(!live)(
  "live Tailscale Serve preserves Fetch Metadata and speculation purpose",
  async () => {
    const server = createServer((incoming, outgoing) => {
      // Only synthetic, allowlisted metadata is reflected. No cookies or identity.
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify(metadata(incoming.headers)));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const serve = new TailscaleServeManager();
    try {
      const publicPort = Number(process.env.ORKESTRATOR_TEST_TAILSCALE_SERVE_PORT ?? "18443");
      let origin: string;
      try {
        const status = JSON.parse(
          (await run("tailscale", ["status", "--json"], { timeout: 10_000 })).stdout,
        );
        if (status.BackendState !== "Running") throw new Error("not signed in");
        const configuration = JSON.parse(
          (await run("tailscale", ["serve", "status", "--json"], { timeout: 10_000 })).stdout,
        );
        // Unlike the application manager, this probe never shares an existing
        // listener, even if that listener's root handler happens to be free.
        if (String(publicPort) in (configuration.TCP ?? {})) throw new Error("test port occupied");
        origin = await serve.start((server.address() as AddressInfo).port, publicPort);
      } catch {
        throw new Error(
          "Live Serve setup failed: requires a signed-in tailnet node, HTTPS enabled, and an unused test port",
        );
      }
      const send = (headers: Record<string, string>): Promise<Record<string, string>> =>
        new Promise((resolve, reject) => {
          const call = request(
            new URL("/metadata", origin),
            { headers, timeout: 10_000 },
            (response) => {
              let body = "";
              response.setEncoding("utf8");
              response.on("data", (chunk: string) => {
                body += chunk;
                if (body.length > 4096)
                  response.destroy(new Error("metadata response exceeded bound"));
              });
              response.on("error", () => reject(new Error("Live Serve response failed")));
              response.on("end", () => {
                if (response.statusCode !== 200)
                  return reject(new Error(`Live Serve HTTP status ${response.statusCode}`));
                try {
                  resolve(JSON.parse(body));
                } catch {
                  reject(new Error("Invalid live Serve metadata response"));
                }
              });
            },
          );
          call.on("timeout", () => call.destroy(new Error("timeout")));
          call.on("error", () =>
            reject(new Error("Live Serve request failed (tailnet name withheld)")),
          );
          call.end();
        });
      const cases: Array<{
        site?: string;
        mode?: string;
        dest?: string;
        purpose?: string;
        denied: boolean;
      }> = [
        { site: "same-origin", mode: "cors", dest: "empty", denied: false },
        { site: "none", mode: "navigate", dest: "document", denied: false },
        { site: "same-site", mode: "no-cors", dest: "image", denied: true },
        { site: "cross-site", mode: "navigate", dest: "iframe", denied: true },
        { site: "same-site", mode: "navigate", dest: "document", denied: false },
        {
          site: "same-site",
          mode: "navigate",
          dest: "document",
          purpose: "prefetch",
          denied: true,
        },
        {
          site: "cross-site",
          mode: "navigate",
          dest: "document",
          purpose: "prefetch;prerender",
          denied: true,
        },
        { denied: false },
      ];
      for (const { site, mode, dest, purpose, denied } of cases) {
        const sent = Object.fromEntries(
          [
            ["sec-fetch-site", site],
            ["sec-fetch-mode", mode],
            ["sec-fetch-dest", dest],
            ["sec-purpose", purpose],
          ].filter((entry): entry is [string, string] => entry[1] !== undefined),
        );
        const received = await send(sent);
        expect(received).toEqual(sent);
        expect(
          crossSiteViolation(
            "GET",
            Object.entries(received),
            "https://service.preview.test",
            false,
          ),
        ).toBe(denied);
      }
    } finally {
      try {
        await serve.stop();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  },
  120_000,
);
