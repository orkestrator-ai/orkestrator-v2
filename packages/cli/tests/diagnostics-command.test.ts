import { afterEach, describe, expect, test } from "bun:test";
import {
  DIAGNOSTICS_CHUNK_BYTES,
  DIAGNOSTICS_REDACTION_NOTICE,
  type DiagnosticsBundlePlan,
} from "@orkestrator/protocol/backend-diagnostics";
import { publicErrorEnvelope, publicSuccessEnvelope } from "@orkestrator/protocol/public-api";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createSandbox,
  defaultResponder,
  envelope,
  startFakeGateway,
  type ClientSandbox,
  type FakeGateway,
} from "./support/client-harness.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const ARCHIVE = Buffer.alloc(DIAGNOSTICS_CHUNK_BYTES + 100, 42);

function planFor(archive: Buffer): DiagnosticsBundlePlan {
  return {
    planId: "plan-1",
    fileName: "orkestrator-diagnostics-2026-11-05T12-00-00-000Z.tar.gz",
    expiresAt: "2026-11-05T12:15:00.000Z",
    archive: {
      bytes: archive.byteLength,
      sha256: createHash("sha256").update(archive).digest("hex"),
    },
    manifest: {
      schemaVersion: 1,
      createdAt: "2026-11-05T12:00:00.000Z",
      appVersion: "2.30.0",
      platform: "linux",
      arch: "x64",
      bunVersion: "1.4.4",
      notice: DIAGNOSTICS_REDACTION_NOTICE,
      entries: [
        { path: "metrics.json", bytes: 10, sha256: "a", description: "Metrics.", redactions: 2 },
      ],
      absent: [{ name: "logs/debug", reason: "Save Logs to Disk is off." }],
    },
  };
}

async function setup(served: Buffer = ARCHIVE, plan: DiagnosticsBundlePlan = planFor(ARCHIVE)) {
  const box: ClientSandbox = await createSandbox();
  const gateway = await startFakeGateway((request) => {
    const action = request.body.args.action as string;
    if (action === "diagnostics.plan") return envelope(publicSuccessEnvelope(action, plan));
    if (action === "diagnostics.read") {
      const input = request.body.args.input as { planId: string; offset: number };
      if (input.planId === "expired") {
        return envelope(publicErrorEnvelope(action, { code: "not-found", message: "Expired." }));
      }
      const end = Math.min(input.offset + DIAGNOSTICS_CHUNK_BYTES, served.byteLength);
      return envelope(
        publicSuccessEnvelope(action, {
          planId: input.planId,
          fileName: plan.fileName,
          archive: plan.archive,
          offset: input.offset,
          data: served.subarray(input.offset, end).toString("base64"),
          nextOffset: end < served.byteLength ? end : null,
        }),
      );
    }
    return defaultResponder()(request);
  });
  cleanups.push(
    () => box.cleanup(),
    () => gateway.stop(),
  );
  const dataDir = await box.publishDescriptor(gateway);
  await box.run(["connection", "add", "local", "--data-dir", dataDir, "--default", "--no-check"]);
  return { box, gateway };
}

function actionsOf(gateway: FakeGateway) {
  return gateway.requests
    .map((request) => request.body.args.action as string)
    .filter((action) => action !== "capabilities");
}

describe("orkestrator diagnostics", () => {
  test("plan prints the manifest and saves nothing", async () => {
    const { box, gateway } = await setup();
    const run = await box.run(["diagnostics", "plan"]);
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    expect(run.out).toContain("Plan plan-1");
    expect(run.out).toContain("metrics.json");
    expect(run.out).toContain("logs/debug: Save Logs to Disk is off.");
    expect(run.out).toContain("not a proof");
    expect(actionsOf(gateway)).toEqual(["diagnostics.plan"]);
  });

  test("export plans, reads every piece in order and writes a private file", async () => {
    const { box, gateway } = await setup();
    const target = path.join(box.root, "bundle.tar.gz");
    const run = await box.run(["diagnostics", "export", "--file", target, "--json"]);
    expect(run.code).toBe(0);
    expect(await readFile(target)).toEqual(ARCHIVE);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(actionsOf(gateway)).toEqual([
      "diagnostics.plan",
      "diagnostics.read",
      "diagnostics.read",
    ]);
    const envelopeOut = JSON.parse(run.out) as {
      result: { path: string; manifest: { notice: string } };
    };
    expect(envelopeOut.result.path).toBe(target);
    expect(envelopeOut.result.manifest.notice).toContain("not a proof");
    // Reads carry no request key: they leave no receipt.
    expect(gateway.requests.every((request) => !("requestId" in request.body.args))).toBe(true);
  });

  test("export --plan saves the bundle that was reviewed", async () => {
    const { box, gateway } = await setup();
    const target = path.join(box.root, "reviewed.tar.gz");
    const run = await box.run(["diagnostics", "export", "--plan", "plan-1", "--file", target]);
    expect(run.code).toBe(0);
    expect(actionsOf(gateway)).toEqual(["diagnostics.read", "diagnostics.read"]);
    expect(run.out).toContain("Nothing was uploaded");
  });

  test("the default name lands in this directory", async () => {
    const { box } = await setup();
    const run = await box.run(["diagnostics", "export", "--file", "named.tar.gz"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain(path.resolve(box.root, "named.tar.gz"));
  });

  test("never overwrites a file", async () => {
    const { box } = await setup();
    const target = path.join(box.root, "exists.tar.gz");
    await writeFile(target, "keep me");
    const run = await box.run(["diagnostics", "export", "--file", target]);
    expect(run.code).toBe(2);
    expect(await readFile(target, "utf8")).toBe("keep me");
  });

  test("a bundle that does not add up is not saved", async () => {
    const { box } = await setup(Buffer.alloc(ARCHIVE.byteLength, 1));
    const target = path.join(box.root, "corrupt.tar.gz");
    const run = await box.run(["diagnostics", "export", "--file", target]);
    expect(run.code).toBe(1);
    await expect(stat(target)).rejects.toThrow();
  });

  test("an expired plan reports not found", async () => {
    const { box } = await setup();
    const run = await box.run([
      "diagnostics",
      "export",
      "--plan",
      "expired",
      "--file",
      path.join(box.root, "x.tar.gz"),
    ]);
    expect(run.code).toBe(3);
  });

  test("the fix prompt mentions the bundle and asks the agent not to run it", async () => {
    const { buildFixPrompt } = await import("../src/client/fix.js");
    const prompt = buildFixPrompt({
      agent: { name: "claude", displayName: "Claude Code", source: "PATH", executable: "claude" },
      workDir: "/tmp/fix",
      now: "2026-11-05T12:00:00.000Z",
      platform: "linux",
      osRelease: "6",
      arch: "x64",
      bunVersion: "1.4.4",
      cliVersion: "2.30.0",
      cliCommand: "orkestrator",
      desktopApp: null,
      dataDir: "/tmp/data",
      dataDirExists: true,
      backend: null,
      logsDir: "/tmp/data/logs",
      debugLogging: false,
      recentLogs: [],
      toolchainBinDir: null,
      managedGh: null,
      diagnosticConnection: null,
    } as unknown as Parameters<typeof buildFixPrompt>[0]);
    expect(prompt).toContain("orkestrator diagnostics export");
    expect(prompt).toContain("Settings → Debug → Export diagnostics");
    expect(prompt).toContain("never run it yourself");
    expect(prompt).toContain("not a proof");
  });
});
