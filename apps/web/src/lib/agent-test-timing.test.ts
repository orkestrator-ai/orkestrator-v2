import { describe, expect, test } from "bun:test";
import {
  FILES_PANEL_POLL_INTERVAL_MS,
  MIN_AGENT_TEST_FILES_PANEL_POLL_MS,
  filesPanelPollIntervalMs,
  filesPanelPollOverride,
} from "./agent-test-timing";

describe("Files panel poll override", () => {
  test("accepts only whole numbers that shorten the poll", () => {
    expect(filesPanelPollOverride(1_000)).toBe(1_000);
    expect(filesPanelPollOverride(MIN_AGENT_TEST_FILES_PANEL_POLL_MS)).toBe(
      MIN_AGENT_TEST_FILES_PANEL_POLL_MS,
    );
    expect(filesPanelPollOverride(FILES_PANEL_POLL_INTERVAL_MS)).toBe(FILES_PANEL_POLL_INTERVAL_MS);
    for (const value of [
      undefined,
      null,
      "1000",
      1_000.5,
      MIN_AGENT_TEST_FILES_PANEL_POLL_MS - 1,
      FILES_PANEL_POLL_INTERVAL_MS + 1,
      Number.NaN,
    ]) {
      expect(filesPanelPollOverride(value)).toBeUndefined();
    }
  });

  test("is ignored outside an agent-test dev renderer", () => {
    // `bun test` is not a Vite dev renderer of an agent-test profile, so a
    // value on the window changes nothing.
    window.orkestratorAgentTestTiming = { filesPanelPollMs: 1_000 };
    try {
      expect(filesPanelPollIntervalMs()).toBe(FILES_PANEL_POLL_INTERVAL_MS);
    } finally {
      delete window.orkestratorAgentTestTiming;
    }
  });
});
