import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  copyDrainWindowMs,
  parseCopyOutput,
  pipeContainerPath,
} from "../../apps/backend/src/core/container-replacement";
import { read, withCallerPath } from "./firewall-test-support";
import { gnuToolPath, missingGnuTools, titleWithSkip } from "./gnu-shell-tools";

/**
 * The rebuild copy pipe's drain window (`copyDrainWindowMs`) against the real
 * helper. After the `docker cp` producer closes, the helper still verifies the
 * destination: it re-hashes every file, sorts and joins the manifests and runs
 * `git fsck`. A window shorter than that work would abort a legitimate copy as
 * `helper-input-stalled`. Here the real `pipeContainerPath` streams a real
 * archive into the real `orkestrator-migrate.sh copy-stream`, with a `docker`
 * stand-in on PATH that runs each side on the host, and the helper's time
 * after its input ended is measured against the default window.
 */
const NO_GNU_TAR = missingGnuTools("tar");
const root = mkdtempSync(join(tmpdir(), "ork-drain-window-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SMALL_FILES = 3_000;
const LARGE_FILES = 3;
const LARGE_FILE_BYTES = 16 * 1024 * 1024;

/**
 * Many small files (where the helper's per-member work dominates), a few large
 * ones (where hashing dominates) and a Git repository (so `git fsck` runs).
 * Automatic gc is off: a fresh commit of this many loose objects starts a
 * background `git gc` that deletes them while the archive is being read.
 */
function buildWorkspace(): string {
  const source = join(root, "src");
  const workspace = join(source, "ws");
  const small = Buffer.alloc(1024);
  for (let index = 0; index < SMALL_FILES; index += 1) {
    const dir = join(workspace, "small", `d${Math.floor(index / 250)}`);
    if (index % 250 === 0) mkdirSync(dir, { recursive: true });
    small.writeUInt32LE(index, 0);
    writeFileSync(join(dir, `f${index}.txt`), small);
  }
  mkdirSync(join(workspace, "large"), { recursive: true });
  for (let index = 0; index < LARGE_FILES; index += 1) {
    writeFileSync(
      join(workspace, "large", `blob${index}.bin`),
      Buffer.alloc(LARGE_FILE_BYTES, index + 1),
    );
  }
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-C", workspace, "-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args],
      { env: { ...process.env, PATH: gnuToolPath } },
    );
  git("init", "-q");
  git("add", "small");
  git(
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "user.name=test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  );
  return source;
}

/** A `docker` whose `cp` archives the workspace and whose `run` is the helper. */
function installDocker(source: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(root, "orkestrator-migrate.sh");
  writeFileSync(script, withCallerPath(read("docker/orkestrator-migrate.sh")));
  const docker = join(bin, "docker");
  writeFileSync(
    docker,
    `#!/bin/bash
case "$1" in
  cp) exec tar -C '${source}' -cf - ws ;;
  run) shift; exec bash '${script}' "$@" ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(docker, 0o755);
  return bin;
}

describe.skipIf(NO_GNU_TAR !== undefined)(
  titleWithSkip("the drain window against the real copy helper", NO_GNU_TAR),
  () => {
    test("the helper's work after its input ends fits well inside the default window", async () => {
      const source = buildWorkspace();
      const bin = installDocker(source);
      const destination = join(root, "dst");
      const originalPath = process.env.PATH;
      process.env.PATH = [bin, gnuToolPath].join(delimiter);
      let windowMs = 0;
      let closedAt = 0;
      let streamed = 0;
      try {
        const piped = await pipeContainerPath(
          "source",
          "/workspace",
          ["run", "copy-stream", destination, "1"],
          {
            // The default window, recorded with the moment the producer closed.
            drainWindowMs: (bytes, streamedMs) => {
              closedAt = Date.now();
              streamed = streamedMs;
              windowMs = copyDrainWindowMs(bytes, streamedMs);
              return windowMs;
            },
          },
        );
        const postInputMs = Date.now() - closedAt;
        expect(piped).toMatchObject({ absent: false, producerFailed: false });
        expect(piped.absent === false && piped.stalled).toBeFalsy();
        const output = piped.absent ? "" : piped.output;
        expect(output).toContain("git=ok");
        expect(parseCopyOutput(output)).toMatchObject({ ok: true });
        // Content-free timings, so a run on a loaded host can leave evidence
        // (docs/development/container-qualification.md).
        const report = process.env.ORK_DRAIN_WINDOW_REPORT;
        if (report) {
          writeFileSync(
            report,
            `${JSON.stringify({ streamedMs: streamed, postInputMs, windowMs })}\n`,
          );
        }
        expect(closedAt).toBeGreaterThan(0);
        expect(postInputMs).toBeLessThan(windowMs);
        // The premise of the window's streaming term: what the helper does
        // after its input ends costs no more than what it did while the stream
        // flowed, so a host slow enough to stretch one stretches the other.
        expect(postInputMs).toBeLessThan(streamed + 30_000);
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    }, 300_000);
  },
);
