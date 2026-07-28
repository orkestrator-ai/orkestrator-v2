import { describe, expect, test } from "bun:test";
import {
  getClaudeTmuxCapturePolling,
  HIDDEN_TUI_CAPTURE_INTERVAL_MS,
  VISIBLE_TUI_CAPTURE_INTERVAL_MS,
} from "@/lib/claude-tmux-polling";

describe("ClaudeTmuxChatTab snapshot polling", () => {
  test("keeps inactive hidden sessions polling every three seconds for prompt detection", () => {
    expect(getClaudeTmuxCapturePolling(false, true)).toEqual({
      enabled: true,
      intervalMs: HIDDEN_TUI_CAPTURE_INTERVAL_MS,
    });
    expect(HIDDEN_TUI_CAPTURE_INTERVAL_MS).toBe(3_000);
  });

  test("uses the responsive cadence only for the visible TUI and stops hidden idle sessions", () => {
    expect(getClaudeTmuxCapturePolling(true, false)).toEqual({
      enabled: true,
      intervalMs: VISIBLE_TUI_CAPTURE_INTERVAL_MS,
    });
    expect(getClaudeTmuxCapturePolling(false, false)).toEqual({
      enabled: false,
      intervalMs: HIDDEN_TUI_CAPTURE_INTERVAL_MS,
    });
  });
});
