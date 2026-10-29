import { afterEach, describe, expect, test, type Mock } from "bun:test";
import { invoke } from "@/lib/native/backend";
import {
  previewGraphRunCodeRewind,
  restartGraphRunActivation,
  rewindGraphRunCode,
} from "./graph-run-rewind";

// `@/lib/native/backend` is replaced once for every suite in tests/setup.ts.
const invokeMock = invoke as unknown as Mock<(...args: unknown[]) => Promise<unknown>>;

afterEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
});

const HEAD = "c".repeat(40);

describe("graph run rewind wrappers", () => {
  test("call the item 210 backend commands with their arguments", async () => {
    const calls: [() => Promise<unknown>, string, Record<string, unknown>][] = [
      [
        () => restartGraphRunActivation({ runId: "run-1", activationKey: "build#attempt=1" }),
        "graph_run_restart",
        { runId: "run-1", activationKey: "build#attempt=1" },
      ],
      [
        () =>
          restartGraphRunActivation({
            runId: "run-1",
            activationKey: "build#attempt=1",
            requestId: "click-1",
          }),
        "graph_run_restart",
        { runId: "run-1", activationKey: "build#attempt=1", requestId: "click-1" },
      ],
      [
        () => previewGraphRunCodeRewind({ runId: "run-1", activationKey: "build#attempt=1" }),
        "graph_run_rewind_code_preview",
        { runId: "run-1", activationKey: "build#attempt=1" },
      ],
      [
        () =>
          rewindGraphRunCode({
            runId: "run-1",
            activationKey: "build#attempt=1",
            expectedHead: HEAD,
            requestId: "click-2",
          }),
        "graph_run_rewind_code",
        {
          runId: "run-1",
          activationKey: "build#attempt=1",
          expectedHead: HEAD,
          requestId: "click-2",
        },
      ],
    ];
    for (const [call, command, args] of calls) {
      await call();
      expect(invokeMock).toHaveBeenLastCalledWith(command, args);
    }
  });

  test("pass the backend's answer through", async () => {
    const answer = { run: { id: "run-1" }, rewind: { id: "click-1" }, repeated: true } as never;
    invokeMock.mockImplementation(async () => answer);
    await expect(
      restartGraphRunActivation({ runId: "run-1", activationKey: "build#attempt=1" }),
    ).resolves.toBe(answer);
  });
});
