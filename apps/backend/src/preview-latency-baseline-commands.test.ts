import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  startPreviewBaselineHarness,
  type PreviewBaselineHarness,
} from "./preview-baseline-harness.js";

const repo = resolve(import.meta.dir, "../../..");

describe("baseline command lifecycle (isolated loopback stack)", () => {
  let harness: PreviewBaselineHarness;
  beforeAll(async () => {
    harness = await startPreviewBaselineHarness();
  });
  afterAll(async () => {
    await harness?.close();
  });

  function launch(command: string[], extra: string[] = []) {
    return Bun.spawn(
      [
        process.execPath,
        resolve(repo, "scripts/preview-latency-baseline.ts"),
        ...command,
        "--url",
        harness.url,
        "--token-file",
        harness.tokenFile,
        "--service",
        harness.serviceLabel,
        "--timeout-ms",
        "2000",
        ...extra,
      ],
      { cwd: repo, stdout: "pipe", stderr: "pipe", env: { ...process.env, NODE_ENV: "" } },
    );
  }

  async function collect(child: ReturnType<typeof launch>) {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const { token } = JSON.parse(await readFile(harness.tokenFile, "utf8")) as { token: string };
    expect(stdout).not.toContain(token);
    expect(stderr).not.toContain(token);
    return { stdout, stderr, code };
  }

  test("watch samples diagnostics, handles termination and prints peak counts", async () => {
    const child = launch(["watch"], ["--interval-ms", "100"]);
    const reader = child.stdout.getReader();
    let stdout = "";
    const stderr = new Response(child.stderr).text();
    try {
      // Wait for actual output, so the signal cannot race handler installation.
      while (!stdout.includes("\n")) {
        const next = await reader.read();
        if (next.done) throw new Error("watch exited before a sample");
        stdout += Buffer.from(next.value).toString();
      }
      child.kill("SIGTERM");
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        stdout += Buffer.from(next.value).toString();
      }
      expect(await child.exited).toBe(0);
      expect(await stderr).toBe("");
      const rows = stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(rows[0].diagnostics.access.attachments).toBe(0);
      expect(rows.at(-1).peaks["access.attachments"]).toBe(0);
      const { token } = JSON.parse(await readFile(harness.tokenFile, "utf8"));
      expect(stdout).not.toContain(token);
    } finally {
      child.kill();
      reader.releaseLock();
      await child.exited;
    }
  }, 15_000);

  test("download reads at its budget, samples gauges, and releases on completion", async () => {
    const result = await collect(
      launch(["download", "--seconds", "1", "--read-kib", "8"], ["--path", "/endless"]),
    );
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    const rows = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const summary = rows.at(-1).download;
    expect(summary.status).toBe(200);
    expect(summary.receivedBytes).toBeGreaterThan(0);
    expect(summary.receivedBytes).toBeLessThanOrEqual(8192);
    expect(summary.peaks["tunnel.queued_bytes"]).toBeNumber();
    expect(harness.preview.runtime.access.stats().attachments).toBe(0);
  }, 15_000);

  test("download releases an attachment with a missing tunnel credential", async () => {
    const access = harness.preview.runtime.access;
    const create = access.createAttachment.bind(access);
    const mint = spyOn(access, "createAttachment").mockImplementation(async (args) => {
      const attachment = await create(args);
      return { ...attachment, tunnel: undefined };
    });
    try {
      const result = await collect(launch(["download", "--seconds", "1"]));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("no tunnel credential");
      expect(access.stats().attachments).toBe(0);
    } finally {
      mint.mockRestore();
    }
  }, 15_000);
});
