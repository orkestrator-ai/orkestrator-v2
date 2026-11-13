/**
 * Diagnostics export from a leaf node (to-do 6141 (retired) task 4,
 * docs/architecture/logging.md, "The diagnostics bundle"): two running
 * `dev:test` profiles on this host, the second attached to the first as its
 * leaf over the leaf's real gateway. A plan is held by the backend that built
 * it, so every piece has to reach the same node.
 *
 * The leaf's bundle is made large on purpose: Save Logs to Disk is turned on
 * there and a synthetic debug log of plain words is written into its log
 * directory, so the archive spans several 256 KiB pieces through the link.
 *
 * It checks, against the bundle the leaf builds for itself:
 *
 * - **Settings.** On the command node's window, Settings → the leaf's machine
 *   chip → Debug → Export diagnostics → Save bundle downloads the leaf's
 *   bundle, whole (size and SHA-256 of the plan the dialog showed are checked
 *   by the renderer; this reads the saved file).
 * - **CLI.** `orkestrator --profile <command> --node <leaf> diagnostics export`
 *   saves the leaf's bundle, and its plan, made with `--node`, is refused by
 *   the command node itself.
 *
 * "The leaf's bundle" is told apart by the backend pid in `health-summary.json`
 * and by the synthetic debug log, which only the leaf has.
 *
 * Opt-in: set `ORKESTRATOR_AGENT_TEST_DIAGNOSTICS_ACROSS_NODES=1`. Both
 * profiles run without credentials; no agent runs and nothing is billed.
 *
 * ```bash
 * mise run build:cli
 * FLAGS="--fixture --headless --no-agent-credentials --no-host-seed --agent-platforms pi"
 * env -u DISPLAY -u WAYLAND_DISPLAY ORKESTRATOR_HOST_REACHABILITY_CHECK=off \
 *   mise run dev:test --profile diag-cmd $FLAGS    # own terminal
 * env -u DISPLAY -u WAYLAND_DISPLAY ORKESTRATOR_HOST_REACHABILITY_CHECK=off \
 *   mise run dev:test --profile diag-leaf $FLAGS   # own terminal
 * ORKESTRATOR_AGENT_TEST_DIAGNOSTICS_ACROSS_NODES=1 \
 * ORKESTRATOR_AGENT_TEST_PROFILE=diag-cmd ORKESTRATOR_AGENT_TEST_LEAF_PROFILE=diag-leaf \
 *   mise run test:logged -- --name diagnostics-across-nodes -- \
 *   bunx playwright test --config e2e/agent-testing/playwright.diagnostics-across-nodes.config.ts
 * ```
 *
 * Evidence (sizes, piece counts, durations; no log contents or tokens) goes to
 * `output/agent-testing/<run>/diagnostics-across-nodes/evidence.json`.
 */
import { expect, test } from "./browser-test";
import { PUBLIC_EXIT } from "@orkestrator/protocol/public-api";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { attachLeaf, signIn, type Profile } from "./coordinator-two-node-support";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const LIVE = process.env.ORKESTRATOR_AGENT_TEST_DIAGNOSTICS_ACROSS_NODES === "1";
const commandProfile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE;
const leafProfile = process.env.ORKESTRATOR_AGENT_TEST_LEAF_PROFILE;
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? commandProfile ?? "diagnostics";
const outputRoot = path.join(
  repositoryRoot,
  "output",
  "agent-testing",
  runId,
  "diagnostics-across-nodes",
);
const LEAF_NAME = "Diagnostics leaf";
/** The synthetic debug log, named like a daily backend log so the bundle reads it. */
const FILLER_LOG = "orkestrator-backend-2000-01-01.log";
const FILLER_MARKER = "diagnostics-across-nodes filler line";
const CHUNK_BYTES = 256 * 1024;

type Plan = {
  planId: string;
  fileName: string;
  archive: { bytes: number; sha256: string };
  manifest: { entries: Array<{ path: string }> };
};
type Chunk = { data: string; nextOffset: number | null };

/** Each regular file of a `.tar.gz`, by name, read from its ustar headers. */
function untar(gzipped: Uint8Array): Map<string, Buffer> {
  const tar = gunzipSync(gzipped);
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const name = field(0, 100);
    const prefix = field(345, 155);
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    if (type === "0" || type === "") {
      files.set(
        prefix ? `${prefix}/${name}` : name,
        tar.subarray(offset + 512, offset + 512 + size),
      );
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** The pids of the backends whose runs `health-summary.json` records. */
function backendPids(files: Map<string, Buffer>): Set<number> {
  const entry = [...files].find(([name]) => name.endsWith("health-summary.json"));
  expect(entry, "the bundle has no health-summary.json").toBeTruthy();
  const pids = new Set<number>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.pid === "number") pids.add(record.pid);
      Object.values(record).forEach(visit);
    }
  };
  visit(JSON.parse(entry![1].toString("utf8")));
  return pids;
}

function holdsFiller(files: Map<string, Buffer>): boolean {
  return [...files].some(
    ([name, contents]) =>
      name.includes(FILLER_LOG) && contents.toString("utf8").includes(FILLER_MARKER),
  );
}

async function readBundle(node: Profile): Promise<{ plan: Plan; bytes: Buffer; pieces: number }> {
  const plan = await node.invoke<Plan>("plan_diagnostics_bundle", {});
  const pieces: Buffer[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const chunk: Chunk = await node.invoke<Chunk>("read_diagnostics_bundle", {
      planId: plan.planId,
      offset,
    });
    pieces.push(Buffer.from(chunk.data, "base64"));
    offset = chunk.nextOffset;
  }
  return { plan, bytes: Buffer.concat(pieces), pieces: pieces.length };
}

/** About `bytes` of plain words: compresses like a real log, and holds no credential shape. */
function fillerLog(bytes: number): string {
  const words = ["scan", "diff", "watch", "status", "branch", "session", "queue", "render"];
  const lines: string[] = [];
  let size = 0;
  let seed = 7;
  for (let line = 0; size < bytes; line++) {
    const parts = [`2000-01-01T00:00:00.000Z INFO [backend] ${FILLER_MARKER} ${line}`];
    for (let word = 0; word < 12; word++) {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      parts.push(`${words[seed % words.length]}=${seed % 100_000}`);
    }
    const text = parts.join(" ");
    lines.push(text);
    size += text.length + 1;
  }
  return `${lines.join("\n")}\n`;
}

function cli(args: string[], configDir: string, cwd: string) {
  const result = spawnSync(
    "bun",
    [path.join(repositoryRoot, "packages/cli/bin/orkestrator.js"), ...args, "--json"],
    {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, ORKESTRATOR_CLI_CONFIG_DIR: configDir },
    },
  );
  let body: { ok?: boolean; result?: Record<string, unknown>; error?: { code?: string } } = {};
  try {
    body = JSON.parse(result.stdout);
  } catch {
    // Reported through the status below.
  }
  return { status: result.status, signal: result.signal, body };
}

test.describe("diagnostics export from a leaf node", () => {
  test.skip(
    !LIVE || !commandProfile || !leafProfile,
    "opt-in: set ORKESTRATOR_AGENT_TEST_DIAGNOSTICS_ACROSS_NODES=1, ORKESTRATOR_AGENT_TEST_PROFILE and ORKESTRATOR_AGENT_TEST_LEAF_PROFILE",
  );

  test("Settings and --node both save the leaf's own bundle, in several pieces", async ({
    page,
    browser,
  }) => {
    test.setTimeout(10 * 60_000);
    const evidence: Record<string, unknown> = {};
    const cleanup: Array<() => Promise<unknown>> = [];
    const scratch = mkdtempSync(path.join(os.tmpdir(), "diagnostics-across-nodes-"));
    try {
      const desk = await signIn(page, commandProfile!);
      const leafContext = await browser.newContext();
      cleanup.push(() => leafContext.close());
      const leaf = await signIn(await leafContext.newPage(), leafProfile!);
      expect(
        (await leaf.invoke<{ mode: string }>("get_node_status")).mode,
        "the leaf profile must be fresh (dev:reset it)",
      ).toBe("standalone");

      const profile = await leaf.invoke<{ revision: number }>("get_backend_profile");
      await leaf.invoke("update_backend_profile", {
        expectedRevision: profile.revision,
        displayName: LEAF_NAME,
      });
      await leaf.invoke("patch_global_config", { patch: { debugLogging: true } });
      cleanup.push(() => leaf.invoke("patch_global_config", { patch: { debugLogging: false } }));
      const logsDir = path.join(leaf.status.dataDir!, "logs");
      mkdirSync(logsDir, { recursive: true });
      const fillerPath = path.join(logsDir, FILLER_LOG);
      writeFileSync(fillerPath, fillerLog(6 * 1024 * 1024), { mode: 0o600 });
      cleanup.push(async () => rmSync(fillerPath, { force: true }));

      // What each node builds for itself.
      const own = await readBundle(leaf);
      const ownFiles = untar(own.bytes);
      expect(holdsFiller(ownFiles), "the leaf's own bundle lacks the debug log").toBe(true);
      expect(own.pieces).toBeGreaterThan(1);
      const leafPids = backendPids(ownFiles);
      const deskFiles = untar((await readBundle(desk)).bytes);
      const deskPids = backendPids(deskFiles);
      expect(holdsFiller(deskFiles)).toBe(false);
      expect([...leafPids].some((pid) => deskPids.has(pid))).toBe(false);
      evidence.leafOwn = { bytes: own.plan.archive.bytes, pieces: own.pieces };

      const nodeId = await attachLeaf(desk, leaf, (attached) =>
        cleanup.push(() => desk.invoke("forget_node", { nodeId: attached })),
      );

      // Settings, on the command node's window.
      await page.goto(desk.status.browserUrl!);
      await page.getByRole("button", { name: "Global settings", exact: true }).click();
      const machines = page.getByRole("group", { name: "Machine" });
      await expect(machines.getByRole("button", { name: LEAF_NAME })).toBeEnabled({
        timeout: 60_000,
      });
      await machines.getByRole("button", { name: LEAF_NAME }).click();
      await page
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("button", { name: "Debug", exact: true })
        .click();
      const planAt = Date.now();
      await page.getByRole("button", { name: "Export diagnostics", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Export diagnostics" });
      await expect(dialog.getByRole("list", { name: "Files in the bundle" })).toContainText(
        `logs/debug/${FILLER_LOG}`,
        { timeout: 120_000 },
      );
      const planMs = Date.now() - planAt;
      const download = page.waitForEvent("download", { timeout: 120_000 });
      const saveAt = Date.now();
      await dialog.getByRole("button", { name: "Save bundle" }).click();
      const saved = path.join(scratch, "settings.tar.gz");
      await (await download).saveAs(saved);
      const saveMs = Date.now() - saveAt;
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
      const settingsBytes = readFileSync(saved);
      const settingsFiles = untar(settingsBytes);
      expect(holdsFiller(settingsFiles), "Settings saved a bundle without the leaf's log").toBe(
        true,
      );
      expect([...backendPids(settingsFiles)].some((pid) => leafPids.has(pid))).toBe(true);
      expect([...backendPids(settingsFiles)].some((pid) => deskPids.has(pid))).toBe(false);
      evidence.settings = {
        bytes: settingsBytes.byteLength,
        pieces: Math.ceil(settingsBytes.byteLength / CHUNK_BYTES),
        planMs,
        saveMs,
      };

      // The CLI with --node.
      const configDir = path.join(scratch, "cli-config");
      const target = path.join(scratch, "cli.tar.gz");
      const cliAt = Date.now();
      const exported = cli(
        ["--profile", commandProfile!, "--node", nodeId, "diagnostics", "export", "--file", target],
        configDir,
        scratch,
      );
      const cliMs = Date.now() - cliAt;
      expect(exported.status, JSON.stringify(exported.body.error ?? {})).toBe(0);
      const cliBytes = readFileSync(target);
      const archive = exported.body.result?.archive as { bytes: number; sha256: string };
      expect(cliBytes.byteLength).toBe(archive.bytes);
      expect(createHash("sha256").update(cliBytes).digest("hex")).toBe(archive.sha256);
      const cliFiles = untar(cliBytes);
      expect(holdsFiller(cliFiles)).toBe(true);
      expect([...backendPids(cliFiles)].some((pid) => leafPids.has(pid))).toBe(true);
      evidence.cli = {
        bytes: cliBytes.byteLength,
        pieces: Math.ceil(cliBytes.byteLength / CHUNK_BYTES),
        ms: cliMs,
      };

      // A plan made on the leaf is held there: the command node does not have it.
      const planned = cli(
        ["--profile", commandProfile!, "--node", nodeId, "diagnostics", "plan"],
        configDir,
        scratch,
      );
      expect(planned.status).toBe(0);
      const planId = String(planned.body.result?.planId);
      const wrongNodeFile = path.join(scratch, "wrong-node.tar.gz");
      const elsewhere = cli(
        [
          "--profile",
          commandProfile!,
          "diagnostics",
          "export",
          "--plan",
          planId,
          "--file",
          wrongNodeFile,
        ],
        configDir,
        scratch,
      );
      evidence.planOnOtherNode = { exitStatus: elsewhere.status, code: elsewhere.body.error?.code };
      // The CLI ran to completion (no timeout or signal, so `status` is a real
      // exit code) and the command node answered that it does not hold the
      // plan. Any other failure (transport, sign-in, arguments, a missing
      // profile) proves nothing about where plans live.
      expect(elsewhere.signal).toBeNull();
      expect(elsewhere.body.ok).toBe(false);
      expect(elsewhere.body.error?.code).toBe("not-found");
      expect(elsewhere.status).toBe(PUBLIC_EXIT.notFound);
      expect(existsSync(wrongNodeFile)).toBe(false);
      const sameNode = cli(
        [
          "--profile",
          commandProfile!,
          "--node",
          nodeId,
          "diagnostics",
          "export",
          "--plan",
          planId,
          "--file",
          path.join(scratch, "same-node.tar.gz"),
        ],
        configDir,
        scratch,
      );
      expect(sameNode.status).toBe(0);
    } finally {
      for (const step of cleanup.reverse()) await step().catch(() => undefined);
      mkdirSync(outputRoot, { recursive: true });
      writeFileSync(
        path.join(outputRoot, "evidence.json"),
        `${JSON.stringify({ recordedAt: new Date().toISOString(), ...evidence }, null, 2)}\n`,
      );
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
