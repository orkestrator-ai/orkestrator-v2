import { afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import { TerminalHistory, type TerminalHistoryOptions } from "./terminal-history.js";

// Harness shared by the terminal-history-part-*.test.ts files. Each part keeps its own current
// `history` (the tests reassign it), so the harness takes a callback that replaces it after
// every test instead of owning it.

/**
 * Registers the per-test teardown in the calling test file's scope and returns the builders whose
 * results that teardown releases: every history a test built has its timers shut down, and every
 * temporary directory it made is removed.
 */
export function useTerminalHistoryHarness(replaceHistory: () => void): {
  createHistory: (options?: TerminalHistoryOptions) => TerminalHistory;
  temporaryDirectory: () => Promise<string>;
} {
  const directories: string[] = [];
  /** Every history a test built, so teardown releases each one's timers. */
  const histories: TerminalHistory[] = [];

  afterEach(async () => {
    const finished = histories.splice(0);
    for (const created of finished) created.shutdown();
    // Disposal, completion and pruning write after the call returns.
    await Promise.all(finished.map((created) => created.settled()));
    replaceHistory();
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  return {
    createHistory(options: TerminalHistoryOptions = {}): TerminalHistory {
      const created = new TerminalHistory(options);
      histories.push(created);
      return created;
    },
    async temporaryDirectory(): Promise<string> {
      const directory = await mkdtemp(path.join(tmpdir(), "ork-terminal-history-"));
      directories.push(directory);
      return directory;
    },
  };
}

/** What `seq first last` prints through a PTY, which turns each newline into CRLF. */
export function seqOutput(first: number, last: number): string {
  let output = "";
  for (let value = first; value <= last; value += 1) output += `${value}\r\n`;
  return output;
}

export function writeTerminal(terminal: HeadlessTerminal, text: string): Promise<void> {
  return new Promise((resolve) => terminal.write(text, resolve));
}

/** Every archived row of a session, oldest first, following the page cursors back. */
export async function readArchivedRows(
  history: TerminalHistory,
  sessionId: string,
): Promise<string[]> {
  const rows: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await history.page(sessionId, cursor);
    rows.unshift(...(page?.rows ?? []).map((row) => row.text));
    cursor = page?.previousCursor ?? undefined;
  } while (cursor);
  return rows;
}

/** A session whose archive is ready, so a test's output is numbered from a known start. */
export async function readyArchiveDirectory(
  history: TerminalHistory,
  dataDir: string,
  sessionId: string,
): Promise<string> {
  history.configure({ sessionId, dataDir, stableIdentity: sessionId, cols: 80, rows: 24 });
  const snapshot = await history.stateSnapshot(sessionId);
  return path.join(dataDir, "terminal-history", snapshot!.historyId);
}
