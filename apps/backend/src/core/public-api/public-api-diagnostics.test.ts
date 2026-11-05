import { afterEach, describe, expect, test } from "bun:test";
import type {
  DiagnosticsBundleChunk,
  DiagnosticsBundlePlan,
} from "@orkestrator/protocol/backend-diagnostics";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { BackendDiagnostics } from "../backend-diagnostics.js";
import { createPublicApiHarness, type PublicApiHarness } from "./test-support.js";

/**
 * `diagnostics.plan` and `diagnostics.read` through the real `public_action`
 * entry and real storage, with fixture logs in the harness's own data directory.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const FIXTURE_TOKEN = `ghp_${"A1b2C3d4".repeat(4)}abcd`;

async function setup(): Promise<PublicApiHarness> {
  const harness = await createPublicApiHarness();
  cleanups.push(() => harness.cleanup());
  const diagnostics = new BackendDiagnostics({
    dataDir: harness.storage.getDataDir(),
    changeTracking: () => null,
  });
  cleanups.push(() => diagnostics.close({ clean: false }));
  harness.context.diagnostics = diagnostics;
  const logs = harness.storage.getLogDirectory();
  await fs.mkdir(path.join(logs, "essential"), { recursive: true });
  await fs.writeFile(
    path.join(logs, "essential", "essential.jsonl"),
    `{"event":"backend.starting","note":"${FIXTURE_TOKEN}"}\n`,
  );
  return harness;
}

describe("diagnostics actions", () => {
  test("a plan is read back to exactly the bytes its manifest describes, without the token", async () => {
    const harness = await setup();
    const planned = await harness.call("diagnostics.plan", {});
    expect(planned.ok).toBe(true);
    const plan = planned.result as DiagnosticsBundlePlan;
    expect(plan.manifest.notice).toContain("not a proof");
    expect(plan.manifest.entries.map((entry) => entry.path)).toContain(
      "logs/essential/essential.jsonl",
    );
    expect(plan.manifest.entries.map((entry) => entry.path)).toContain("database.json");
    expect(plan.manifest.absent.map((item) => item.name)).toContain("change-tracking.json");

    const pieces: Buffer[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const read = await harness.call("diagnostics.read", { planId: plan.planId, offset });
      expect(read.ok).toBe(true);
      const chunk = read.result as DiagnosticsBundleChunk;
      pieces.push(Buffer.from(chunk.data, "base64"));
      offset = chunk.nextOffset;
    }
    const archive = Buffer.concat(pieces);
    expect(createHash("sha256").update(archive).digest("hex")).toBe(plan.archive.sha256);
    expect(Buffer.from(Bun.gunzipSync(archive)).toString("latin1")).not.toContain(FIXTURE_TOKEN);
    // Reads leave no operation record and no file.
    expect(planned.receipt).toBeUndefined();
    await expect(
      fs.readdir(path.join(harness.storage.getDataDir(), "diagnostics")),
    ).rejects.toThrow();
  });

  test("an unknown plan is not found, and a bad offset is invalid input", async () => {
    const harness = await setup();
    const missing = await harness.call("diagnostics.read", { planId: "nope" });
    expect(missing).toMatchObject({ ok: false, error: { code: "not-found" } });
    const plan = (await harness.call("diagnostics.plan", {})).result as DiagnosticsBundlePlan;
    const beyond = await harness.call("diagnostics.read", {
      planId: plan.planId,
      offset: plan.archive.bytes + 1,
    });
    expect(beyond).toMatchObject({ ok: false, error: { code: "invalid-input" } });
  });

  test("a backend without diagnostics says so", async () => {
    const harness = await createPublicApiHarness();
    cleanups.push(() => harness.cleanup());
    harness.context.diagnostics = undefined;
    const answer = await harness.call("diagnostics.plan", {});
    expect(answer).toMatchObject({ ok: false, error: { code: "capability-unavailable" } });
  });
});
