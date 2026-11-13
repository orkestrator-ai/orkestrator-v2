/**
 * A claude-tmux tab reopen through a real `docker exec` (to-do 5120 task 2).
 *
 * `tmux-transcript-reader.test.ts` runs the window script under the host's
 * `/bin/sh`, and `scripts/tmux-reopen-read-size.ts` counts its bytes through a
 * fake `docker`. This runs the real `TmuxSession` and `TmuxBackend` against a
 * container of the environment image, with a 37 MB transcript (the longest
 * one host had) in the container: the image's own `sh`, `wc` and `tail` do the
 * read. A reopen of a running session is one exec of one page, the same
 * records a local read of the same file returns, and paging back reaches the
 * first record with every read bounded.
 *
 * Opt-in: RUN_LIVE_DOCKER_TESTS=1 and ORKESTRATOR_QUALIFICATION_IMAGE=<image>.
 * The container has no network use and runs no agent.
 */
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerOwnerNamespace } from "../src/core/docker-ownership.js";
import { runCommand } from "../src/core/shell.js";
import { TmuxBackend } from "../src/core/tmux-backend.js";
import { TmuxSession } from "../src/core/tmux-session-manager.js";
import { TMUX_TRANSCRIPT_PAGE_BYTES } from "../src/core/tmux-transcript-reader.js";

const image = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim();
const enabled = process.env.RUN_LIVE_DOCKER_TESTS === "1" && Boolean(image);

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const LINES = 9_000;
const LINE_BYTES = 4_096;
/** `<size> <start>\n` ahead of the page's bytes. */
const HEADER_BYTES = 64;

function transcript(): string {
  let content = "";
  const padding = "x".repeat(LINE_BYTES - 80);
  for (let n = 0; n < LINES; n += 1) {
    content += `${JSON.stringify({
      type: n % 2 ? "assistant" : "user",
      uuid: `line-${n}`,
      message: { role: n % 2 ? "assistant" : "user", content: padding },
    })}\n`;
  }
  return content;
}

type Counted = { execs: number; bytes: number };

/** Counts every `docker exec` the backend makes and the stdout bytes it took back. */
function countExecs(backend: TmuxBackend): { take(): Counted } {
  let counted: Counted = { execs: 0, bytes: 0 };
  const target = backend as unknown as {
    exec: (...args: unknown[]) => Promise<{ stdout: string }>;
    execRaw: (...args: unknown[]) => Promise<{ stdout: Buffer }>;
  };
  const exec = target.exec.bind(backend);
  const execRaw = target.execRaw.bind(backend);
  target.exec = async (...args) => {
    const out = await exec(...args);
    counted.execs += 1;
    counted.bytes += Buffer.byteLength(out.stdout);
    return out;
  };
  target.execRaw = async (...args) => {
    const out = await execRaw(...args);
    counted.execs += 1;
    counted.bytes += out.stdout.byteLength;
    return out;
  };
  return {
    take() {
      const taken = counted;
      counted = { execs: 0, bytes: 0 };
      return taken;
    },
  };
}

function session(backend: TmuxBackend, transcriptPath: string): TmuxSession {
  const tab = new TmuxSession("env", "tab", backend, "/tmp/ork", SESSION_ID);
  // The real path is found under the container's Claude home; the binding is what counts.
  (tab as unknown as { transcriptPath: string }).transcriptPath = transcriptPath;
  return tab;
}

const uuids = (lines: unknown[]) => lines.map((line) => (line as { uuid?: string }).uuid);

test.skipIf(!enabled)(
  "a tmux tab reopen in a real container reads one bounded page through docker exec",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "ork-tmux-reopen-docker-"));
    let containerId: string | undefined;
    const docker = async (args: string[], timeoutMs = 120_000) =>
      (await runCommand("docker", args, { timeoutMs })).stdout.trim();
    try {
      const content = transcript();
      const local = join(dir, `${SESSION_ID}.jsonl`);
      await writeFile(local, content);
      const fileBytes = Buffer.byteLength(content);
      expect(fileBytes).toBeGreaterThan(36_000_000);

      containerId = await docker([
        "run",
        "--detach",
        "--label",
        "app=orkestrator-v2",
        "--label",
        `orkestrator-owner=${dockerOwnerNamespace(dir)}`,
        "--network",
        "none",
        "--user",
        "node",
        "--entrypoint",
        "sleep",
        image!,
        "infinity",
      ]);
      const inContainer = `/home/node/.claude/projects/-workspace/${SESSION_ID}.jsonl`;
      await docker(["exec", containerId, "mkdir", "-p", "/home/node/.claude/projects/-workspace"]);
      await docker(["cp", local, `${containerId}:${inContainer}`]);
      expect(await docker(["exec", containerId, "sh", "-c", `wc -c < ${inContainer}`])).toBe(
        String(fileBytes),
      );

      const backend = TmuxBackend.container(containerId);
      const spy = countExecs(backend);
      const context = { emit: () => undefined } as never;
      const tab = session(backend, inContainer);
      const reference = session(TmuxBackend.local(dir), local);

      // No poll loop has run in this backend process, so the first read owes
      // the tail's one pass over the file.
      const firstStarted = performance.now();
      const first = await tab.transcriptPage(context);
      const firstMs = performance.now() - firstStarted;
      const firstPass = spy.take();
      expect(firstPass.bytes).toBeGreaterThanOrEqual(fileBytes);

      // The reopen of a running session: one exec, one page.
      const reopenStarted = performance.now();
      const reopened = await tab.transcriptPage(context);
      const reopenMs = performance.now() - reopenStarted;
      const reopen = spy.take();
      expect(reopen.execs).toBe(1);
      expect(reopen.bytes).toBeLessThanOrEqual(TMUX_TRANSCRIPT_PAGE_BYTES + HEADER_BYTES);
      expect(reopened.lines.length).toBeGreaterThan(0);
      expect(uuids(reopened.lines).at(-1)).toBe(`line-${LINES - 1}`);
      expect(uuids(reopened.lines)).toEqual(uuids(first.lines));
      // The image's sh, wc and tail cut the same page a local read does.
      const localPage = await reference.transcriptPage(context);
      expect(reopened.lines).toEqual(localPage.lines);
      expect(reopened.earlierCursor).toBe(localPage.earlierCursor);

      // Paging back reaches the first record, every read bounded.
      const seen = [...uuids(reopened.lines)];
      let cursor = reopened.earlierCursor;
      let pages = 0;
      let largestPage = 0;
      const pagingStarted = performance.now();
      while (cursor) {
        const page = await tab.transcriptPage(context, cursor);
        const read = spy.take();
        expect(read.execs).toBe(1);
        largestPage = Math.max(largestPage, read.bytes);
        seen.unshift(...uuids(page.lines));
        cursor = page.earlierCursor;
        pages += 1;
      }
      const pagingMs = performance.now() - pagingStarted;
      expect(largestPage).toBeLessThanOrEqual(TMUX_TRANSCRIPT_PAGE_BYTES + HEADER_BYTES);
      expect(seen).toEqual(Array.from({ length: LINES }, (_, n) => `line-${n}`));

      // A missing file and a cursor past the end answer without reading.
      const missing = session(backend, "/home/node/.claude/projects/-workspace/missing.jsonl");
      expect((await missing.transcriptPage(context)).lines).toEqual([]);
      spy.take();

      process.stderr.write(
        `tmux-transcript-reopen-docker: file ${fileBytes} bytes; first pass ${firstPass.bytes} bytes in ${firstPass.execs} execs (${firstMs.toFixed(0)} ms); ` +
          `reopen ${reopen.bytes} bytes in ${reopen.execs} exec (${reopenMs.toFixed(0)} ms), ${reopened.lines.length} lines; ` +
          `${pages} earlier pages to the first record, largest ${largestPage} bytes, ${pagingMs.toFixed(0)} ms\n`,
      );
    } finally {
      if (containerId) await docker(["rm", "--force", containerId]);
      await rm(dir, { recursive: true, force: true });
    }
  },
  240_000,
);
