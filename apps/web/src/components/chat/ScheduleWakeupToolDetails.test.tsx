import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { TerminalProvider } from "@/contexts";
import type { NativeMessagePart } from "@/lib/chat/native-message-types";
import { NativeMessage } from "./NativeMessage";

afterEach(cleanup);

let messageCounter = 0;

function renderParts(parts: NativeMessagePart[]) {
  messageCounter += 1;
  return render(
    <TerminalProvider>
      <NativeMessage
        message={{
          // Unique per test so persisted expansion state cannot leak between them.
          id: `schedule-wakeup-${messageCounter}`,
          role: "assistant",
          content: "",
          createdAt: "2026-10-21T20:45:00.000Z",
          parts,
        }}
      />
    </TerminalProvider>,
  );
}

const WAKEUP_ARGS = {
  delaySeconds: 1800,
  noop: true,
  prompt: "Check whether the three research agents have finished; then write the plan.",
  reason: "Fallback heartbeat while three research agents run.",
};

const WAKEUP_OUTPUT =
  "Next wakeup scheduled for 21:16:00 (in 1859s). If you owe the user a status update this tick, " +
  "write it now as ordinary response text; then end the turn.";

function wakeupPart(overrides: Partial<NativeMessagePart> = {}): NativeMessagePart {
  return {
    type: "tool-invocation",
    content: "",
    toolUseId: `wake-${messageCounter}`,
    toolName: "ScheduleWakeup",
    toolState: "success",
    toolArgs: WAKEUP_ARGS,
    toolOutput: WAKEUP_OUTPUT,
    ...overrides,
  } as NativeMessagePart;
}

describe("ScheduleWakeup tool row", () => {
  test("renders the wakeup fields instead of JSON", () => {
    const { container } = renderParts([wakeupPart()]);

    expect(
      screen.getByText("in 30m · Fallback heartbeat while three research agents run."),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("ScheduleWakeup"));

    const details = screen.getByTestId("schedule-wakeup-tool");
    expect(container.textContent).not.toContain('"delaySeconds"');
    expect(details.textContent).toContain("Wakes in 30m 59s");
    expect(details.textContent).toContain("at 21:16:00");
    expect(within(details).getByText("No change")).toBeTruthy();
    expect(within(details).getByText(WAKEUP_ARGS.reason)).toBeTruthy();
    expect(within(details).getByText(WAKEUP_ARGS.prompt)).toBeTruthy();
    // The harness's result text stays visible below the fields.
    expect(container.textContent).toContain(WAKEUP_OUTPUT);
  });

  test("uses the requested delay before the call settles", () => {
    renderParts([wakeupPart({ toolState: "pending", toolOutput: undefined })]);
    fireEvent.click(screen.getByText("ScheduleWakeup"));

    const details = screen.getByTestId("schedule-wakeup-tool");
    expect(details.textContent).toContain("Wakes in 30m");
    expect(details.textContent).not.toContain(" at ");
  });

  test("shows a stopped loop and the autonomous sentinel", () => {
    renderParts([
      wakeupPart({ toolArgs: { stop: true }, toolOutput: "Loop stopped." }),
      wakeupPart({
        toolUseId: "wake-autonomous",
        toolArgs: { delaySeconds: 60, noop: false, prompt: "<<autonomous-loop-dynamic>>" },
        toolOutput: undefined,
      }),
    ]);
    for (const trigger of screen.getAllByText("ScheduleWakeup")) fireEvent.click(trigger);

    const [stopped, autonomous] = screen.getAllByTestId("schedule-wakeup-tool");
    expect(within(stopped!).getByText("Loop stopped")).toBeTruthy();
    expect(within(autonomous!).getByText("Continue the autonomous loop")).toBeTruthy();
    expect(within(autonomous!).getByText("Progress")).toBeTruthy();
    expect(autonomous!.textContent).not.toContain("<<autonomous-loop-dynamic>>");
  });
});
