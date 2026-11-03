import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePollSnapshotOutput, pollSnapshotScript } from "./tmux-shared.js";

/**
 * The combined poll script run by a real `sh`, with a fake `tmux` on PATH, so
 * the parser is proven against what the shell actually prints.
 */
describe("tmux poll snapshot script", () => {
  let dir: string;
  const nonce = "0123456789abcdef01234567";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ork-poll-snapshot-"));
    mkdirSync(join(dir, "pending"));
    mkdirSync(join(dir, "timeout"));
    mkdirSync(join(dir, "bin"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function fakeTmux(options: { alive: boolean; pane: string; captureStatus?: number }) {
    writeFileSync(join(dir, "pane"), options.pane);
    writeFileSync(
      join(dir, "bin", "tmux"),
      `#!/bin/sh
case "$1" in
  has-session) exit ${options.alive ? 0 : 1} ;;
  capture-pane) cat ${JSON.stringify(join(dir, "pane"))}; exit ${options.captureStatus ?? 0} ;;
esac
exit 2
`,
    );
    chmodSync(join(dir, "bin", "tmux"), 0o755);
  }

  function run(script: string): string {
    const result = spawnSync("/bin/sh", ["-c", script], {
      env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin` },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    return result.stdout;
  }

  // `stat -c` is GNU, as in the container image.
  const gnu = process.platform === "linux";

  test.skipIf(!gnu)("one exec answers hooks, sizes, liveness and the exact pane", () => {
    writeFileSync(join(dir, "pending", "Stop-1-2.json"), "{}");
    writeFileSync(join(dir, "timeout", "PreToolUse-3-4.json"), "{}");
    writeFileSync(join(dir, "transcript.jsonl"), "12345");
    writeFileSync(join(dir, "candidate.jsonl"), "");
    // The pane is arbitrary container output: it may imitate every marker.
    const pane = `> prompt\n__ork_pending__\n__ork_alive__\n0\n__ork_pane_end_guess__ 0\n\n`;
    fakeTmux({ alive: true, pane });
    const script = pollSnapshotScript(
      join(dir, "pending"),
      join(dir, "timeout"),
      join(dir, "transcript.jsonl"),
      {
        candidatePath: join(dir, "candidate.jsonl"),
        tmux: { command: "tmux", session: "s", liveness: true, pane: true },
        nonce,
      },
    );
    expect(parsePollSnapshotOutput(run(script), nonce)).toEqual({
      pending: ["Stop-1-2.json"],
      timeouts: ["PreToolUse-3-4.json"],
      transcriptSize: 5,
      candidateSize: 0,
      alive: true,
      pane,
    });
  });

  test.skipIf(!gnu)(
    "a dead session, a missing transcript and a failed capture read as such",
    () => {
      fakeTmux({ alive: false, pane: "", captureStatus: 1 });
      const script = pollSnapshotScript(join(dir, "pending"), join(dir, "timeout"), undefined, {
        candidatePath: join(dir, "missing.jsonl"),
        tmux: { command: "tmux", session: "s", liveness: true, pane: true },
        nonce,
      });
      expect(parsePollSnapshotOutput(run(script), nonce)).toEqual({
        pending: [],
        timeouts: [],
        transcriptSize: 0,
        candidateSize: null,
        alive: false,
        pane: null,
      });
    },
  );

  test("without extras the script and its answer are the per-tick listing", () => {
    const script = pollSnapshotScript(join(dir, "pending"), join(dir, "timeout"), undefined);
    expect(script).not.toContain("tmux");
    expect(parsePollSnapshotOutput(run(script))).toEqual({
      pending: [],
      timeouts: [],
      transcriptSize: 0,
    });
  });

  test("a truncated or forged pane section is refused", () => {
    expect(() =>
      parsePollSnapshotOutput(
        `__ork_pending__\n__ork_timeout__\n__ork_size__\n0\n__ork_pane_${nonce}__\npartial`,
        nonce,
      ),
    ).toThrow("Incomplete tmux poll snapshot pane");
    expect(() =>
      pollSnapshotScript("p", "t", undefined, {
        tmux: { command: "tmux", session: "s", liveness: false, pane: true },
        nonce: "short",
      }),
    ).toThrow("nonce");
  });
});
