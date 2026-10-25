#!/usr/bin/env bun
/**
 * 0036 qualification: design canvases across a published backend release and
 * this checkout's backend, on one data directory.
 *
 *   bun scripts/qualify-design-mixed-versions.ts [options]
 *
 *   --old-version <v>   published `orkestrator` npm release (default 2.22.3,
 *                       the oldest Stable release on npm in the support window)
 *   --report <file>     write the evidence as JSON
 *   --keep              keep the temporary root (for iterating on the harness)
 *
 * The old backend is the real published package, installed with
 * `--ignore-scripts` into a private temporary directory; the new one is
 * `apps/backend/src/main.ts`. Both are headless, bound to loopback with the
 * data directory's private gateway token, over one temporary data directory
 * and a temporary HOME, with every inherited `ORKESTRATOR_*` variable removed.
 * Commands go through `/__orkestrator/invoke`. The token is never printed.
 *
 * 1. Old: a local environment, a canvas with a frame, exported to
 *    `designs/old.orkdes`.
 * 2. A legacy portable `.orkdes` is copied into the private store (the layout
 *    before private records).
 * 3. New: reads and edits the old canvas, previews the old export as the same
 *    canvas with the old digest, reopens the file as the same canvas, reads the
 *    legacy document and migrates it on its first write (record written, the
 *    legacy file moved to `legacy-backups`), and creates a canvas of its own.
 * 4. Old again (downgrade): must refuse the newer data, or read it without
 *    damage.
 * 5. New again, with a future `recordVersion` planted in one record and the
 *    migrated record corrupted: the old canvas is intact, the future record is
 *    `unsupported-version` and left in place, and the corrupt one is `corrupt`
 *    with its legacy backup reported.
 *
 * Exits 0 when every assertion held, 1 when one did not, 2 on setup errors.
 */
import type { DesignSnapshotResult } from "@orkestrator/protocol/design-operations";
import { downgradeReadFailure, finishQualification } from "./design-mixed-version-checks";
import { isDeepStrictEqual } from "node:util";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dir, "..");

class SetupError extends Error {}

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

const oldVersion = option("--old-version", "2.22.3");
const reportPath = option("--report", "");
const keep = process.argv.includes("--keep");
const scratch = mkdtempSync(path.join(os.tmpdir(), "ork-design-mixed-"));
const DATA = path.join(scratch, "data");
/** A fresh directory for the old release when it refuses the upgraded one. */
const DOWNGRADE_DATA = path.join(scratch, "downgrade-data");
let dataDir = DATA;
const HOME = path.join(scratch, "home");
const FIXTURE = path.join(scratch, "fixture");
const PACKAGE = path.join(scratch, "pkg");
const STORE = path.join(DATA, "design-canvases");
const PORT = 35_000 + Math.floor(Math.random() * 2_000);
const CONTROL_PORT = PORT + 1;

const evidence: Array<Record<string, unknown>> = [];
const failures: string[] = [];
function note(step: string, detail: Record<string, unknown> = {}) {
  evidence.push({ step, ...detail });
  console.log(JSON.stringify({ step, ...detail }));
}
function check(condition: boolean, message: string) {
  if (!condition) failures.push(message);
}

function run(command: string, args: string[], cwd?: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new SetupError(`${command} ${args[0]}: ${result.stderr.trim()}`);
  return result.stdout;
}

async function token(): Promise<string> {
  return JSON.parse(await readFile(path.join(dataDir, "gateway-auth.json"), "utf8"))
    .token as string;
}

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${PORT}/__orkestrator/invoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" },
    body: JSON.stringify({ command, args }),
  });
  const body = (await response.json().catch(() => ({}))) as { result?: T; error?: unknown };
  if (!response.ok) {
    throw new Error(
      `${command}: HTTP ${response.status} ${JSON.stringify(body.error ?? body).slice(0, 300)}`,
    );
  }
  return body.result as T;
}

type Result<T> = { ok: true; value: T } | { ok: false; failure: { code: string; message: string } };
const outcome = (result: Result<unknown>) =>
  result.ok ? "ok" : `${result.failure.code}: ${result.failure.message}`;

const backendEnvironment = () => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("ORKESTRATOR_")),
  ),
  HOME,
  ORKESTRATOR_DATA_DIR: dataDir,
  ORKESTRATOR_CONTROL_MCP_PORT: String(CONTROL_PORT),
});

let backend: ChildProcess | null = null;

async function start(kind: "old" | "new"): Promise<string> {
  const entry =
    kind === "old"
      ? path.join(PACKAGE, "node_modules", "orkestrator", "bin", "orkestrator.js")
      : path.join(ROOT, "apps", "backend", "src", "main.ts");
  const child = spawn(
    "bun",
    [
      entry,
      "--host",
      "127.0.0.1",
      "--port",
      String(PORT),
      "--allow-non-tailscale-bind",
      "--data-dir",
      dataDir,
      "--control-port",
      String(CONTROL_PORT),
    ],
    {
      cwd: kind === "old" ? scratch : path.join(ROOT, "apps", "backend"),
      env: backendEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output: string[] = [];
  child.stdout!.on("data", (chunk) => output.push(String(chunk)));
  child.stderr!.on("data", (chunk) => output.push(String(chunk)));
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        output.join("").match(/\w*Error: [^\n]*/)?.[0] ??
          `${kind} backend exited ${child.exitCode}`,
      );
    }
    try {
      const version = await invoke<string>("get_app_version");
      backend = child;
      return version;
    } catch {
      await Bun.sleep(500);
    }
  }
  child.kill("SIGKILL");
  throw new SetupError(`${kind} backend did not start`);
}

async function stop() {
  const child = backend;
  backend = null;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([exited, Bun.sleep(20_000).then(() => child.kill("SIGKILL"))]);
}

async function prepare() {
  for (const dir of [DATA, DOWNGRADE_DATA, HOME, FIXTURE, PACKAGE])
    await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(PACKAGE, "package.json"), '{"name":"design-mixed","private":true}\n');
  run("bun", ["add", "--ignore-scripts", `orkestrator@${oldVersion}`], PACKAGE);
  const origin = path.join(FIXTURE, "origin.git");
  const project = path.join(FIXTURE, "project");
  run("git", ["init", "--bare", origin]);
  await mkdir(project);
  run("git", ["init", "-b", "main"], project);
  run("git", ["config", "user.name", "Design Mixed Fixture"], project);
  run("git", ["config", "user.email", "fixture@invalid.local"], project);
  await writeFile(path.join(project, "README.md"), "# design mixed versions\n");
  run("git", ["add", "."], project);
  run("git", ["commit", "-m", "init"], project);
  run("git", ["remote", "add", "origin", origin], project);
  run("git", ["push", "-u", "origin", "main"], project);
  return { origin, project };
}

async function main() {
  const { origin, project } = await prepare();

  // 1. The old release creates and exports a canvas.
  const oldReported = await start("old");
  note("old backend up", { version: oldReported });
  check(oldReported === oldVersion, `old backend reports ${oldReported}, expected ${oldVersion}`);
  const { id: projectId } = await invoke<{ id: string }>("add_project", {
    gitUrl: origin,
    localPath: project,
  });
  const { id: environmentId } = await invoke<{ id: string }>("create_environment", {
    projectId,
    name: "design-mixed",
    environmentType: "local",
    networkAccessMode: "restricted",
  });
  await invoke("start_environment", { environmentId });
  const action = <T>(name: string, input: Record<string, unknown>) =>
    invoke<T>("design_action", { environmentId, action: name, input });
  const snapshot = (canvasId: string) =>
    invoke<Result<DesignSnapshotResult>>("design_snapshot", { environmentId, canvasId });
  const oldCanvas = await action<{ id: string }>("create_canvas", { name: "Old canvas" });
  const { frame } = await action<{ frame: { id: string } }>("create_frame", {
    canvasId: oldCanvas.id,
    expectedRevision: 1,
    name: "Screen",
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    html: "<h1 id='t'>Written by the old backend</h1>",
  });
  const exported = await invoke<Result<{ digest: string }>>("design_export_save", {
    environmentId,
    canvasId: oldCanvas.id,
    relativePath: "designs/old.orkdes",
    revision: 2,
  });
  note("old exports", { outcome: outcome(exported) });
  check(exported.ok, "old backend export failed");
  const oldDigest = exported.ok ? exported.value.digest : undefined;
  const { worktreePath } = await invoke<{ worktreePath: string }>("get_environment", {
    environmentId,
  });
  await stop();

  // 2. A legacy portable document in the private store.
  const legacyId = randomUUID();
  const portable = JSON.parse(
    await readFile(path.join(worktreePath, "designs/old.orkdes"), "utf8"),
  );
  await writeFile(
    path.join(STORE, `${legacyId}.orkdes`),
    JSON.stringify({ ...portable, id: legacyId, environmentId, name: "Legacy fixture" }),
  );

  // 3. This checkout upgrades the directory.
  note("new backend up", { version: await start("new") });
  const read = await snapshot(oldCanvas.id);
  note("new reads the old canvas", { outcome: outcome(read), kind: read.ok && read.value.kind });
  check(read.ok && read.value.kind === "snapshot", "new backend cannot read the old canvas");
  const edited = await action("replace_frame_html", {
    canvasId: oldCanvas.id,
    frameId: frame.id,
    expectedRevision: 1,
    html: "<h1 id='t'>Edited by the new backend</h1>",
  }).then(
    () => "ok",
    (error) => String(error).slice(0, 200),
  );
  note("new edits the old canvas", { result: edited });
  check(edited === "ok", "new backend cannot edit the old canvas");
  const preview = await invoke<
    Result<{ suggestedPath: string; target: { sameCanvas: boolean; fingerprint?: string } }>
  >("design_export_preview", { environmentId, canvasId: oldCanvas.id });
  const previewFacts = preview.ok
    ? {
        suggestedPath: preview.value.suggestedPath,
        sameCanvas: preview.value.target.sameCanvas,
        oldDigest: preview.value.target.fingerprint === oldDigest,
      }
    : { outcome: outcome(preview) };
  note("new previews the old export", previewFacts);
  check(
    preview.ok &&
      preview.value.suggestedPath === "designs/old.orkdes" &&
      preview.value.target.sameCanvas &&
      preview.value.target.fingerprint === oldDigest,
    "the old export is not recognised as the same canvas",
  );
  const reopened = await invoke<Result<{ canvasId?: string; canvas?: { id: string } }>>(
    "design_open_file",
    { environmentId, relativePath: "designs/old.orkdes" },
  );
  const reopenedId = reopened.ok ? (reopened.value.canvasId ?? reopened.value.canvas?.id) : null;
  note("new reopens the old export", {
    outcome: outcome(reopened),
    sameCanvas: reopenedId === oldCanvas.id,
  });
  check(reopenedId === oldCanvas.id, "reopening the old export did not reuse its canvas");
  const legacy = await snapshot(legacyId);
  note("new reads the legacy document", {
    outcome: outcome(legacy),
    kind: legacy.ok && legacy.value.kind,
  });
  check(
    legacy.ok && legacy.value.kind === "snapshot",
    "new backend cannot read the legacy document",
  );
  const legacyEdit = await action("create_frame", {
    canvasId: legacyId,
    expectedRevision: portable.revision,
    name: "After migration",
    x: 500,
    y: 0,
    width: 200,
    height: 200,
    html: "<p>migrated</p>",
  }).then(
    () => "ok",
    (error) => String(error).slice(0, 200),
  );
  const migrated = {
    edit: legacyEdit,
    record: (await readdir(STORE)).includes(`${legacyId}.orkrec`),
    legacyInPlace: (await readdir(STORE)).includes(`${legacyId}.orkdes`),
    backup: await readdir(path.join(STORE, "legacy-backups")).then(
      (files) => files.includes(`${legacyId}.orkdes`),
      () => false,
    ),
  };
  note("new migrates the legacy document on its first write", migrated);
  check(
    migrated.edit === "ok" && migrated.record && !migrated.legacyInPlace && migrated.backup,
    "legacy migration did not write a record and keep a backup",
  );
  const newCanvas = await action<{ id: string }>("create_canvas", { name: "New canvas" });
  // The documented downgrade path: export before running an older backend.
  const downgradeExport = await invoke<Result<{ digest: string }>>("design_export_save", {
    environmentId,
    canvasId: oldCanvas.id,
    relativePath: "designs/for-downgrade.orkdes",
    revision: 3,
  });
  note("new exports for a downgrade", { outcome: outcome(downgradeExport) });
  check(downgradeExport.ok, "new backend export for the downgrade failed");
  const downgradeDocument = await readFile(
    path.join(worktreePath, "designs/for-downgrade.orkdes"),
    "utf8",
  );
  const beforeDowngrade = await snapshot(oldCanvas.id);
  check(
    beforeDowngrade.ok && beforeDowngrade.value.kind === "snapshot",
    "cannot capture the edited old canvas before downgrade",
  );
  const oldRecordPath = path.join(STORE, `${oldCanvas.id}.orkrec`);
  const oldRecord = await readFile(oldRecordPath, "utf8");
  await stop();

  // 4. Downgrade.
  try {
    const version = await start("old");
    const reads: Record<string, string> = {};
    for (const [label, id] of Object.entries({
      old: oldCanvas.id,
      new: newCanvas.id,
      legacy: legacyId,
    })) {
      const result = await snapshot(id).catch((error) => ({
        ok: false as const,
        failure: { code: "transport", message: String(error).slice(0, 200) },
      }));
      reads[label] = result.ok ? result.value.kind : outcome(result);
      const expectedCanvas =
        label === "old" && beforeDowngrade.ok && beforeDowngrade.value.kind === "snapshot"
          ? beforeDowngrade.value.canvas
          : undefined;
      const failure = downgradeReadFailure(result, expectedCanvas);
      check(failure === null, `old backend ${label} read: ${failure}`);
    }
    note("old opens the upgraded directory", { version, reads });
    await stop();
  } catch (error) {
    if (error instanceof SetupError) throw error;
    note("old refuses the upgraded directory", { error: String(error).slice(0, 300) });
    check(
      /newer than this build supports/.test(String(error)),
      "old backend failed for another reason",
    );
  }
  check(
    (await readFile(oldRecordPath, "utf8")) === oldRecord,
    "downgrade changed the old canvas record",
  );
  // The old release imports the exported file into its own directory.
  dataDir = DOWNGRADE_DATA;
  await start("old");
  const { id: oldProjectId } = await invoke<{ id: string }>("add_project", {
    gitUrl: origin,
    localPath: project,
  });
  const { id: oldEnvironmentId } = await invoke<{ id: string }>("create_environment", {
    projectId: oldProjectId,
    name: "design-downgrade",
    environmentType: "local",
    networkAccessMode: "restricted",
  });
  await invoke("start_environment", { environmentId: oldEnvironmentId });
  const imported = await invoke<{ id: string; frames: Array<{ html: string }> }>("design_import", {
    environmentId: oldEnvironmentId,
    document: downgradeDocument,
  }).then(
    (canvas) => ({ ok: true as const, canvas }),
    (error) => ({ ok: false as const, error: String(error).slice(0, 300) }),
  );
  const importedFacts = imported.ok
    ? {
        frames: imported.canvas.frames.length,
        editedHtml: imported.canvas.frames.some((f) =>
          f.html.includes("Edited by the new backend"),
        ),
      }
    : { error: imported.error };
  note("old imports the new export", importedFacts);
  check(
    imported.ok && importedFacts.editedHtml === true,
    "old release cannot import the new export",
  );
  await stop();
  dataDir = DATA;

  // 5. Back on this checkout, with a future record version and a corrupt record.
  const futureFile = path.join(STORE, `${newCanvas.id}.orkrec`);
  await writeFile(
    futureFile,
    JSON.stringify({ ...JSON.parse(await readFile(futureFile, "utf8")), recordVersion: 99 }),
  );
  await writeFile(path.join(STORE, `${legacyId}.orkrec`), "{ not json");
  await start("new");
  const after = await snapshot(oldCanvas.id);
  const future = await snapshot(newCanvas.id);
  const corrupt = await snapshot(legacyId);
  const facts = {
    oldCanvas: after.ok ? after.value.kind : outcome(after),
    future:
      future.ok && future.value.kind === "record-problem"
        ? `${future.value.kind}/${future.value.problem}`
        : outcome(future),
    futureLeftInPlace: (await readdir(STORE)).includes(`${newCanvas.id}.orkrec`),
    corrupt:
      corrupt.ok && corrupt.value.kind === "record-problem"
        ? `${corrupt.value.kind}/${corrupt.value.problem}`
        : outcome(corrupt),
    corruptBackupAvailable:
      corrupt.ok && corrupt.value.kind === "record-problem"
        ? corrupt.value.backupAvailable
        : undefined,
  };
  note("new after the round trip", facts);
  check(
    after.ok &&
      after.value.kind === "snapshot" &&
      beforeDowngrade.ok &&
      beforeDowngrade.value.kind === "snapshot" &&
      isDeepStrictEqual(after.value.canvas, beforeDowngrade.value.canvas),
    "the edited old canvas content did not survive the round trip",
  );
  check(facts.future === "record-problem/unsupported-version", "future record not fenced");
  check(facts.futureLeftInPlace, "future record was removed");
  check(facts.corrupt === "record-problem/corrupt", "corrupt record not reported");
  check(facts.corruptBackupAvailable === true, "corrupt record's legacy backup not reported");
  await stop();
}

let exitCode = 0;
try {
  await main();
  exitCode = failures.length > 0 ? 1 : 0;
} catch (error) {
  console.error(String(error).slice(0, 2_000));
  exitCode = error instanceof SetupError ? 2 : 1;
} finally {
  try {
    await stop();
  } finally {
    try {
      await finishQualification({
        reportPath,
        report: { oldVersion, evidence, failures, exitCode },
        scratch,
        keep,
      });
    } catch (error) {
      console.error(`Qualification finalization failed: ${String(error)}`);
      exitCode = 1;
    }
  }
}
for (const failure of failures) console.error(`FAIL ${failure}`);
process.exit(exitCode);
