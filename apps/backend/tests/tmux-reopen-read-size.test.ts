import { describe, expect, test } from "bun:test";
import { WORKLOADS, measureTmuxReopen } from "../scripts/tmux-reopen-read-size";
import { TMUX_TRANSCRIPT_PAGE_BYTES } from "../src/core/tmux-transcript-reader";

/**
 * The read a tab reopen costs in a container (BG-14), measured by the same
 * harness the before-and-after numbers come from: bytes through a fake
 * `docker exec`, on a transcript the length of the longest seen on a real host.
 */
describe("tmux tab reopen read size", () => {
  const longest = WORKLOADS.find((workload) => workload.name.startsWith("longest"))!;

  test("a reopen reads one bounded window, where it used to read the whole file", async () => {
    const result = await measureTmuxReopen(longest);

    expect(result.fileBytes).toBeGreaterThan(30_000_000);
    // Before: `test -f` and `cat` of everything.
    expect(result.before.bytes).toBe(result.fileBytes);
    expect(result.before.lines).toBe(longest.lines);
    // After: one exec, a page and its short header.
    expect(result.after.execs).toBe(1);
    expect(result.after.bytes).toBeLessThanOrEqual(TMUX_TRANSCRIPT_PAGE_BYTES + 64);
    expect(result.after.lines).toBeGreaterThan(100);
    expect(result.after.lines).toBeLessThan(longest.lines);
  });

  test("the tail's one pass is paid once, and a transcript under a page reads whole", async () => {
    const result = await measureTmuxReopen(longest);
    expect(result.afterFirstPass.bytes).toBeLessThanOrEqual(
      result.fileBytes + TMUX_TRANSCRIPT_PAGE_BYTES + 64,
    );

    const median = await measureTmuxReopen(
      WORKLOADS.find((workload) => workload.name.startsWith("median"))!,
    );
    expect(median.after.lines).toBe(median.before.lines);
  });
});
