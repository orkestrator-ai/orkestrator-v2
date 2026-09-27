/**
 * Shared helpers for the real-stack web-annotation suites. They drive the
 * synthetic fixture in `test-fixtures/agent-project/annotation-app`, which
 * every isolated profile copies into its test project, and never read or
 * print fixture secrets or gateway credentials.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  WEB_ANNOTATION_EVIDENCE_CLOSE,
  WEB_ANNOTATION_EVIDENCE_OPEN,
} from "@orkestrator/protocol/web-annotations";
import {
  ADVERSARIAL_SENTINEL,
  ADVERSARIAL_STRINGS,
  SYNTHETIC_SECRETS,
} from "../../test-fixtures/agent-project/annotation-app/fixture-data";

export * from "../../test-fixtures/agent-project/annotation-app/fixture-data";

export interface FixtureServer {
  url: string;
  port: number;
  stop(): Promise<void>;
}

/**
 * Serve the annotation fixture from a checkout (normally an environment
 * worktree, so a source change there is what the page renders). The suites
 * run under Node, so the Bun server is always its own process group.
 */
export async function startFixtureServer(cwd: string, port: number): Promise<FixtureServer> {
  const child: ChildProcess = spawn("bun", ["annotation-app/server.ts"], {
    cwd,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
  });
  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (child.exitCode !== null || !child.pid) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      return;
    }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Annotation fixture server exited during startup");
    const healthy = await fetch(`${url}/health`)
      .then((response) => response.ok)
      .catch(() => false);
    if (healthy) return { url, port, stop };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await stop();
  throw new Error("Annotation fixture server did not become healthy");
}

export async function resetFixture(server: FixtureServer): Promise<void> {
  const response = await fetch(`${server.url}/__fixture/reset`, { method: "POST" });
  if (!response.ok) throw new Error("Annotation fixture reset failed");
}

export interface BriefInertness {
  evidenceOpen: number;
  evidenceClose: number;
  sentinelsOutsideEvidence: number;
  sentinelsInsideEvidence: number;
  rawRoleTokens: number;
  forgedMarkerLines: number;
  trustedHead: string;
}

/**
 * Where adversarial page strings ended up in a compiled brief. Inert means:
 * exactly one evidence fence pair, every sentinel inside it, no raw markup
 * delimiter or role token anywhere, and no line that starts like a request
 * marker other than the one the backend emits.
 */
export function briefInertness(brief: string): BriefInertness {
  const open = brief.indexOf(WEB_ANNOTATION_EVIDENCE_OPEN);
  const close = brief.lastIndexOf(WEB_ANNOTATION_EVIDENCE_CLOSE);
  const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
  const inside = open >= 0 && close > open ? brief.slice(open, close) : "";
  const outside = open >= 0 && close > open ? brief.slice(0, open) + brief.slice(close) : brief;
  return {
    evidenceOpen: count(brief, WEB_ANNOTATION_EVIDENCE_OPEN),
    evidenceClose: count(brief, WEB_ANNOTATION_EVIDENCE_CLOSE),
    sentinelsOutsideEvidence: count(outside, ADVERSARIAL_SENTINEL),
    sentinelsInsideEvidence: count(inside, ADVERSARIAL_SENTINEL),
    rawRoleTokens: count(brief, "<|im_start|>"),
    forgedMarkerLines: brief
      .split("\n")
      .filter((line) => line.trimStart().startsWith(ADVERSARIAL_STRINGS.fakeMarker.slice(0, 40)))
      .length,
    trustedHead: open >= 0 ? brief.slice(0, open) : brief,
  };
}

const SCAN_MAX_FILES = 20_000;
const SCAN_MAX_FILE_BYTES = 16 * 1024 * 1024;
const SCAN_SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "toolchains", "worktrees"]);

/**
 * Report which synthetic secrets appear in files below `roots`. Returns
 * relative paths and secret *names* only, never the values, so a failure
 * message cannot itself leak a secret. Bounded by file count and size.
 */
export async function findSyntheticSecrets(
  roots: string[],
): Promise<{ hits: Array<{ file: string; secret: string }>; scannedFiles: number }> {
  const hits: Array<{ file: string; secret: string }> = [];
  let scannedFiles = 0;
  const secrets = Object.entries(SYNTHETIC_SECRETS);
  const visit = async (root: string, directory: string, depth: number): Promise<void> => {
    if (depth > 24 || scannedFiles >= SCAN_MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SCAN_SKIPPED_DIRECTORIES.has(entry.name)) await visit(root, full, depth + 1);
        continue;
      }
      if (!entry.isFile() || scannedFiles >= SCAN_MAX_FILES) continue;
      const info = await stat(full).catch(() => null);
      if (!info || info.size > SCAN_MAX_FILE_BYTES) continue;
      scannedFiles += 1;
      const content = await readFile(full).catch(() => null);
      if (!content) continue;
      const text = content.toString("latin1");
      for (const [name, value] of secrets) {
        if (text.includes(value)) hits.push({ file: path.relative(root, full), secret: name });
      }
    }
  };
  for (const root of roots) await visit(root, root, 0);
  return { hits, scannedFiles };
}
