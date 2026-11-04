import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TmuxBackend } from "../src/core/tmux-backend.js";
import { TmuxSession } from "../src/core/tmux-session-manager.js";

/**
 * Measures the bytes one claude-tmux tab reopen pulls through `docker exec`
 * (efficiency finding BG-14):
 *
 *   mise exec -- bun apps/backend/scripts/tmux-reopen-read-size.ts [--json]
 *
 * The real `TmuxSession` and `TmuxBackend` run against a fake `docker` on PATH
 * that runs each command locally and records its stdout size, so what is
 * counted is what crossed the process boundary. "Before" is the whole-file read
 * every reopen took; it is still what a renderer that predates paging gets.
 */

export type Workload = { name: string; lines: number; lineBytes: number };

/** One record every few KiB, like a long session of tool calls, at sizes seen on a real host. */
export const WORKLOADS: readonly Workload[] = [
  { name: "median session (171 KB)", lines: 40, lineBytes: 4_096 },
  { name: "p99 session (6.4 MB)", lines: 1_600, lineBytes: 4_096 },
  { name: "longest session (37 MB)", lines: 9_000, lineBytes: 4_096 },
];

export type ReopenReadSize = {
  workload: string;
  fileBytes: number;
  before: { execs: number; bytes: number; lines: number };
  /** A tab reopened on a running session: the tail has read the file. */
  after: { execs: number; bytes: number; lines: number };
  /** The same tab when its read beats the tail's one pass in this backend process. */
  afterFirstPass: { execs: number; bytes: number; lines: number };
};

const SESSION_ID = "11111111-2222-4333-8444-555555555555";

function transcript(workload: Workload): string {
  let content = "";
  for (let n = 0; n < workload.lines; n += 1) {
    const padding = "x".repeat(Math.max(0, workload.lineBytes - 80));
    content += `${JSON.stringify({
      type: n % 2 ? "assistant" : "user",
      uuid: `line-${n}`,
      message: { role: n % 2 ? "assistant" : "user", content: padding },
    })}\n`;
  }
  return content;
}

type Spy = { take(): { execs: number; bytes: number } };

/** Puts a `docker` on PATH that runs `exec … <id> <command>` here and logs stdout bytes. */
function fakeDocker(dir: string): Spy {
  const log = path.join(dir, "docker.log");
  writeFileSync(log, "");
  const output = path.join(dir, "docker.out");
  writeFileSync(
    path.join(dir, "docker"),
    `#!/bin/sh
# exec -u node -w /workspace [-i] <id> <command...>
shift 5
[ "$1" = "-i" ] && shift
shift
"$@" > ${JSON.stringify(output)}
status=$?
wc -c < ${JSON.stringify(output)} >> ${JSON.stringify(log)}
cat ${JSON.stringify(output)}
exit $status
`,
  );
  chmodSync(path.join(dir, "docker"), 0o755);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  return {
    take() {
      const sizes = readFileSync(log, "utf8").split("\n").filter(Boolean).map(Number);
      writeFileSync(log, "");
      return { execs: sizes.length, bytes: sizes.reduce((sum, size) => sum + size, 0) };
    },
  };
}

export async function measureTmuxReopen(workload: Workload): Promise<ReopenReadSize> {
  const dir = mkdtempSync(path.join(tmpdir(), "ork-tmux-reopen-"));
  const previousPath = process.env.PATH;
  try {
    const spy = fakeDocker(dir);
    const file = path.join(dir, "transcript.jsonl");
    const content = transcript(workload);
    writeFileSync(file, content);
    const context = { emit: () => undefined } as never;

    const session = () => {
      const tab = new TmuxSession(
        "env",
        "tab",
        TmuxBackend.container("fake"),
        "/tmp/ork",
        SESSION_ID,
      );
      // The real path is under the container's home; the binding is what counts.
      (tab as unknown as { transcriptPath: string }).transcriptPath = file;
      return tab;
    };

    const whole = await session().transcriptLines();
    const before = { ...spy.take(), lines: whole.length };

    // No poll loop has run in this session yet, so this read owes the tail's pass.
    const running = session();
    const first = await running.transcriptPage(context);
    const afterFirstPass = { ...spy.take(), lines: first.lines.length };

    const reopened = await running.transcriptPage(context);
    const after = { ...spy.take(), lines: reopened.lines.length };

    return {
      workload: workload.name,
      fileBytes: Buffer.byteLength(content),
      before,
      after,
      afterFirstPass,
    };
  } finally {
    process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const results: ReopenReadSize[] = [];
  for (const workload of WORKLOADS) results.push(await measureTmuxReopen(workload));
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  console.log("| Workload | File | Before | After, running session | After, first pass owed |");
  console.log("| --- | --- | --- | --- | --- |");
  const cell = (read: { execs: number; bytes: number; lines: number }) =>
    `${read.bytes} bytes, ${read.execs} exec, ${read.lines} lines`;
  for (const result of results) {
    console.log(
      `| ${result.workload} | ${result.fileBytes} | ${cell(result.before)} | ${cell(result.after)} | ${cell(result.afterFirstPass)} |`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
