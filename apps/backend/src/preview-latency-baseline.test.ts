import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  startPreviewBaselineHarness,
  type PreviewBaselineHarness,
} from "./preview-baseline-harness.js";

/**
 * Opt-in (`ORKESTRATOR_PREVIEW_BENCH=1`) loopback self-test of
 * `scripts/preview-latency-baseline.ts`: the real CLI, run as a child process
 * with the token in a file, against the isolated baseline harness (real
 * gateway, command API, tunnel and private-origin listener on one machine).
 * It proves the tool works end to end; its numbers are not two-machine
 * evidence.
 */
const enabled = process.env.ORKESTRATOR_PREVIEW_BENCH === "1";
const repo = resolve(import.meta.dir, "../../..");

describe.skipIf(!enabled)("preview latency baseline tool (loopback self-test)", () => {
  let harness: PreviewBaselineHarness;

  beforeAll(async () => {
    harness = await startPreviewBaselineHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  test("measures all four routes, prints no secret and releases its attachments", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        join(repo, "scripts/preview-latency-baseline.ts"),
        "--url",
        harness.url,
        "--token-file",
        harness.tokenFile,
        "--ca-file",
        harness.caFile,
        "--publication-address",
        harness.publicationAddress,
        "--service",
        harness.serviceLabel,
        "--direct",
        "127.0.0.1",
        "--path",
        "/health",
        "--samples",
        "20",
        "--warmups",
        "2",
        "--label",
        "loopback self-test",
      ],
      { cwd: repo, stdout: "pipe", stderr: "pipe", env: { ...process.env, NODE_ENV: "" } },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });

    const token = (JSON.parse(await readFile(harness.tokenFile, "utf8")) as { token: string })
      .token;
    expect(stdout).not.toContain(token);
    expect(stderr).not.toContain(token);
    expect(stdout).not.toContain("__Host-orkestrator-preview");
    expect(stdout).not.toContain('"marker"');

    const result = JSON.parse(stdout) as {
      routes: Record<string, { status: string; samples: number; failures: number }>;
      diagnostics: { afterRelease: { access: { attachments: number } } };
    };
    for (const route of ["direct", "legacy", "desktop-tunnel", "private-origin"]) {
      expect({ route, ...result.routes[route] }).toMatchObject({
        route,
        status: "measured",
        samples: 20,
        failures: 0,
      });
    }
    expect(result.diagnostics.afterRelease.access.attachments).toBe(0);
    expect(harness.preview.runtime.access.stats().attachments).toBe(0);
    // The tool's Markdown table goes to stderr for the evidence log.
    expect(stderr).toContain("| desktop-tunnel | measured | 20 | 0 |");
    // The application saw no gateway or preview credential.
    for (const request of harness.fixture.requests) {
      expect(request.authorization).toBeUndefined();
      expect(request.cookie ?? "").not.toContain("orkestrator");
    }
  }, 120_000);
});
