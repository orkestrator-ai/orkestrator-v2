// Terminal history under sustained output: what it does when output arrives
// faster than the headless parser takes it (docs/development/terminal-latency.md).
// The shared harness lives in terminal-history-test-support.ts.
import { describe, expect, test } from "bun:test";
import { type TerminalHistory } from "./terminal-history.js";
import { useTerminalHistoryHarness } from "./terminal-history-test-support.js";

let history: TerminalHistory;
const { createHistory, temporaryDirectory } = useTerminalHistoryHarness(() => {
  history = createHistory();
});
history = createHistory();

/** About `bytes` of numbered lines, `label` on every one so each chunk is recognisable. */
function lines(label: string, bytes: number): string {
  const rows: string[] = [];
  let size = 0;
  for (let row = 0; size < bytes; row += 1) {
    const line = `${label}-${String(row).padStart(6, "0")}\r\n`;
    rows.push(line);
    size += line.length;
  }
  return rows.join("");
}

describe.serial("terminal history under load", () => {
  test("serializes only the newest of the checkpoints queued behind a parse backlog", async () => {
    const dataDir = await temporaryDirectory();
    const stableIdentity = "flooded-terminal";
    let serializations = 0;
    history = createHistory({ serializeHook: () => (serializations += 1) });
    history.configure({ sessionId: "flood", dataDir, stableIdentity, cols: 40, rows: 8 });
    // Four 600 KB chunks in one turn, as a coalesced flood arrives: the first
    // and third each schedule a checkpoint (the first by time, the third at
    // a megabyte), both queued behind parsing that has not started yet.
    const chunks = ["first", "second", "third", "fourth"].map((label) => lines(label, 600_000));
    chunks.forEach((chunk, index) => history.append("flood", chunk, index + 1, 1));
    await history.settled();
    expect(serializations).toBe(1);

    // A crash now (no completion checkpoint) restores the coalesced one: the
    // state after the third chunk, which superseded the first's.
    history.shutdown();
    history = createHistory();
    history.configure({ sessionId: "restored", dataDir, stableIdentity, cols: 40, rows: 8 });
    const restored = await history.stateSnapshot("restored");
    expect(restored?.output).toContain(chunks[2]!.trimEnd().split("\r\n").at(-1)!);
    expect(restored?.output).not.toContain("first-");
  });
});
