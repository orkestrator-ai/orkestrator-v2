import { describe, expect, mock, spyOn, test } from "bun:test";
import { TmuxBackend } from "./tmux-backend.js";
import {
  paneHasSelectionPrompt,
  TmuxSession,
  type TmuxSessionTimingOptions,
} from "./tmux-session-manager.js";

const selection = "Choose a theme\n❯ 1. Dark\n  2. Light\nEnter to confirm · Esc to cancel";
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function session(timing: TmuxSessionTimingOptions = {}) {
  const instance = new TmuxSession(
    "env",
    "tab",
    TmuxBackend.local("/tmp"),
    "/tmp",
    undefined,
    undefined,
    timing,
  );
  const capture = spyOn(instance, "capturePane").mockResolvedValue("❯ ready");
  const alive = spyOn(instance, "tmuxAlive").mockResolvedValue(true);
  const submit = spyOn(instance, "submit").mockResolvedValue(undefined);
  return { instance, capture, alive, submit };
}

describe("initial Claude prompt readiness", () => {
  test("retries a failed capture and waits for selection to clear on the session clock", async () => {
    let now = 0;
    let pause: { ms: number; resume: () => void } | undefined;
    const sleep = mock(
      (ms: number) =>
        new Promise<void>((resolve) => {
          pause = { ms, resume: resolve };
        }),
    );
    const { instance, capture, submit } = session({ now: () => now, sleep });
    capture
      .mockRejectedValueOnce(new Error("transient capture failure"))
      .mockResolvedValueOnce(selection)
      .mockResolvedValueOnce("❯ ready");
    const sending = instance["sendInitialPromptWhenReady"]("hello", true);
    const advance = async (ms: number) => {
      expect(pause?.ms).toBe(ms);
      now += ms;
      const resume = pause!.resume;
      pause = undefined;
      resume();
      await settle();
    };
    expect(capture).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    await advance(800);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    await settle();
    expect(capture).toHaveBeenCalledTimes(1);
    await advance(500);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(submit).not.toHaveBeenCalled();
    await advance(500);
    await sending;
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith("hello");
    expect(instance.status(true).busy).toBe(true);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([800, 500, 500]);
  });

  test.each(["selection", "capture failure"])(
    "times out %s through the injected deadline",
    async (kind) => {
      let now = 0;
      const { instance, capture, submit } = session({
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      });
      if (kind === "selection") capture.mockResolvedValue(selection);
      else capture.mockRejectedValue(new Error("capture unavailable"));
      await expect(instance["sendInitialPromptWhenReady"]("hello", false)).rejects.toThrow(
        "timed out waiting for Claude",
      );
      expect(now).toBe(10 * 60 * 1000);
      expect(submit).not.toHaveBeenCalled();
    },
  );

  test.each(["dead tmux", "dead after capture", "capture failure then dead", "Claude exited"])(
    "aborts for %s",
    async (kind) => {
      const { instance, capture, alive, submit } = session({ sleep: async () => {} });
      if (kind === "dead tmux") alive.mockResolvedValue(false);
      if (kind === "dead after capture" || kind === "capture failure then dead") {
        alive.mockResolvedValueOnce(true).mockResolvedValue(false);
      }
      if (kind === "capture failure then dead")
        capture.mockRejectedValueOnce(new Error("capture failed"));
      if (kind === "Claude exited") capture.mockResolvedValue("[claude exited]");
      await expect(instance["sendInitialPromptWhenReady"]("hello", false)).rejects.toThrow(
        kind === "Claude exited"
          ? "Claude exited before the initial prompt"
          : "tmux session stopped before Claude was ready",
      );
      expect(submit).not.toHaveBeenCalled();
    },
  );
});

test.each([
  [selection, true],
  [`\u001b[32m${selection}\u001b[0m`, true],
  ["1. Dark\nenter to select · esc to cancel", true],
  ["Enter to confirm · Esc to cancel", false],
  ["1. Ordinary transcript line", false],
  ["❯ ready", false],
])("selection prompt fingerprint: %s", (snapshot, expected) => {
  expect(paneHasSelectionPrompt(snapshot)).toBe(expected);
});
