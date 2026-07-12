import { describe, expect, it } from "bun:test";
import {
  CODEX_SESSION_STALE_AFTER_MS,
  createCodexSessionRefreshController,
} from "./session-refresh";

describe("createCodexSessionRefreshController", () => {
  it("does not request a watchdog refresh while activity is still fresh", () => {
    const controller = createCodexSessionRefreshController();

    controller.markActivity(1_000);

    expect(controller.shouldRefresh(1_000)).toBe(false);
    expect(controller.shouldRefresh(1_000 + CODEX_SESSION_STALE_AFTER_MS - 1)).toBe(false);
    expect(controller.shouldRefresh(1_000 + CODEX_SESSION_STALE_AFTER_MS)).toBe(true);
  });

  it("only applies the latest async refresh result", () => {
    const controller = createCodexSessionRefreshController();

    const firstRequest = controller.beginRequest();
    const secondRequest = controller.beginRequest();

    expect(controller.shouldApplyRequest(firstRequest)).toBe(false);
    expect(controller.shouldApplyRequest(secondRequest)).toBe(true);
  });
});
