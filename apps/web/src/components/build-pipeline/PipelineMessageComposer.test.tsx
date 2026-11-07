/**
 * The pipeline message box's queue and Auto-steer: with the setting on, a plain
 * message sent while a turn runs is queued and steered out of the queue; with it
 * off, it waits in the queue with a Steer button, as on a native agent tab.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { BuildPipeline } from "@/stores/buildPipelineStore";
import { configStore } from "@/stores/configStore";
import { mockToastError, mockToastInfo, mockToastSuccess } from "../../../../../tests/mocks/sonner";
import {
  BuildChatTab,
  pipeline,
  removeQueuedMock,
  restoreBuildChatTabMocks,
  sendMessageMock,
  steerPipelineMock,
  steerQueuedMock,
  tabData,
  buildChatScope,
  cleanupBuildChatScope,
  pipelineStore,
  renderInBuildChat,
} from "./build-chat-tab-test-support";
import { newReviewValidationRun } from "@orkestrator/protocol/review-workflow";
import { queuedSteerNotice } from "./PipelineMessageComposer";

afterAll(restoreBuildChatTabMocks);
afterEach(cleanupBuildChatScope);

const buildSession = pipeline.sessions[0]!;
const running: BuildPipeline = {
  ...pipeline,
  phase: "building",
  sessions: [{ ...buildSession, status: "running" }],
  currentSessionIndex: 0,
};
const betweenTurns: BuildPipeline = {
  ...running,
  sessions: [{ ...buildSession, status: "idle" }],
};
const queuedMessage = { id: "q1", text: "use the helper", createdAt: "2026-07-29T00:02:00.000Z" };

const originalConfig = buildChatScope().store(configStore).getState().config;

function setAutoSteer(autoSteer: boolean) {
  buildChatScope()
    .store(configStore)
    .setState({
      config: { ...originalConfig, global: { ...originalConfig.global, autoSteer } },
    });
}

function renderComposer(next: BuildPipeline = running) {
  pipelineStore().setState({
    pipelines: new Map([[next.id, next]]),
    buildEnvironmentIds: new Set([next.environmentId]),
  });
  renderInBuildChat(<BuildChatTab data={tabData} />);
  return screen.getByLabelText("Send a message to the agent") as HTMLTextAreaElement;
}

function sendText(box: HTMLTextAreaElement, text: string) {
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
}

function currentQueue(): string[] {
  return (
    pipelineStore()
      .getState()
      .pipelines.get(running.id)
      ?.pendingUserMessages?.map(({ text }) => text) ?? []
  );
}

beforeEach(() => {
  cleanup();
  sendMessageMock.mockClear();
  steerPipelineMock.mockClear();
  steerQueuedMock.mockClear();
  removeQueuedMock.mockClear();
  mockToastError.mockClear();
  mockToastInfo.mockClear();
  mockToastSuccess.mockClear();
  setAutoSteer(false);
});

afterEach(() => {
  buildChatScope().store(configStore).setState({ config: originalConfig });
});

describe("Auto-steer on", () => {
  beforeEach(() => setAutoSteer(true));

  test("queues a plain message and steers it into the running turn", async () => {
    const box = renderComposer();
    fireEvent.change(box, { target: { value: "  use the helper  " } });
    expect(screen.getByRole("button", { name: "Send message" }).getAttribute("title")).toBe(
      "Steer the current Codex turn",
    );
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(steerQueuedMock).toHaveBeenCalledWith(running.id, "queued-1"));
    expect(sendMessageMock).toHaveBeenCalledWith(running.id, "use the helper");
    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith("Steered the active Codex turn"),
    );
    expect(box.value).toBe("");
    expect(currentQueue()).toEqual([]);
    expect(screen.queryByTestId("compose-queue-strip") === null).toBe(true);
  });

  test("steers the new row when older text is identical", async () => {
    const box = renderComposer({ ...running, pendingUserMessages: [queuedMessage] });
    sendText(box, queuedMessage.text);
    await waitFor(() => expect(steerQueuedMock).toHaveBeenCalledWith(running.id, "queued-1"));
  });

  test("never steers an old matching row when the send reply omits the new row", async () => {
    sendMessageMock.mockImplementationOnce(async () => ({
      ...running,
      pendingUserMessages: [queuedMessage],
    }));
    const box = renderComposer({ ...running, pendingUserMessages: [queuedMessage] });
    sendText(box, queuedMessage.text);
    await waitFor(() => expect(mockToastInfo).toHaveBeenCalled());
    expect(steerQueuedMock).not.toHaveBeenCalled();
    expect(currentQueue()).toEqual([queuedMessage.text]);
  });

  test("a refused steer leaves the message queued and says so", async () => {
    steerQueuedMock.mockImplementationOnce(async (pipelineId: string) => ({
      pipeline: {
        ...pipelineStore().getState().pipelines.get(pipelineId)!,
        pendingUserMessages: [{ ...queuedMessage, id: "queued-1" }],
        backendRevision: 30,
      },
      delivery: "queued" as const,
      notice: "The turn is not accepting steering.",
    }));
    const box = renderComposer();

    sendText(box, "use the helper");

    await waitFor(() =>
      expect(mockToastInfo).toHaveBeenCalledWith(
        "The turn is not accepting steering. Your message was queued instead.",
      ),
    );
    expect(mockToastError).not.toHaveBeenCalled();
    expect(box.value).toBe("");
    expect(currentQueue()).toEqual(["use the helper"]);
  });

  test("a message that lost the race is reported as the next turn", async () => {
    steerQueuedMock.mockImplementationOnce(async (pipelineId: string) => ({
      pipeline: {
        ...pipelineStore().getState().pipelines.get(pipelineId)!,
        backendRevision: 31,
      },
      delivery: "gone" as const,
    }));
    const box = renderComposer();

    sendText(box, "use the helper");

    await waitFor(() =>
      expect(mockToastInfo).toHaveBeenCalledWith(
        "Codex finished the turn first, so your message was sent as the next turn.",
      ),
    );
    expect(box.value).toBe("");
  });

  test("an unconfirmed steer warns and hands the text back", async () => {
    steerQueuedMock.mockImplementationOnce(async (pipelineId: string) => ({
      pipeline: {
        ...pipelineStore().getState().pipelines.get(pipelineId)!,
        backendRevision: 32,
      },
      delivery: "unconfirmed" as const,
      notice: "Delivery could not be confirmed. Check the transcript before sending it again.",
    }));
    const box = renderComposer();

    sendText(box, "use the helper");

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "Delivery could not be confirmed. Check the transcript before sending it again.",
      ),
    );
    await waitFor(() => expect(box.value).toBe("use the helper"));
  });

  test("a steer request that fails keeps the message in the queue only", async () => {
    steerQueuedMock.mockRejectedValueOnce(new Error("backend offline"));
    const box = renderComposer();

    sendText(box, "use the helper");

    await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1));
    expect(String(mockToastError.mock.calls[0]?.[0])).toContain("saved to the queue");
    expect(String(mockToastError.mock.calls[0]?.[0])).toContain("backend offline");
    expect(box.value).toBe("");
    expect(currentQueue()).toEqual(["use the helper"]);
  });

  test("a failed queue write keeps the draft and steers nothing", async () => {
    sendMessageMock.mockRejectedValueOnce(new Error("queue full"));
    const box = renderComposer();

    sendText(box, "use the helper");

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Failed to send the message", {
        description: "queue full",
      }),
    );
    expect(steerQueuedMock).not.toHaveBeenCalled();
    expect(box.value).toBe("use the helper");
  });

  test("only queues when no turn is running", async () => {
    const box = renderComposer(betweenTurns);

    sendText(box, "use the helper");

    await waitFor(() => expect(sendMessageMock).toHaveBeenCalled());
    await waitFor(() => expect(box.value).toBe(""));
    expect(steerQueuedMock).not.toHaveBeenCalled();
  });

  test("only queues while a dispatch is unconfirmed", async () => {
    const box = renderComposer({
      ...running,
      pendingPromptAttempt: {
        dispatchVersion: 1,
        id: "attempt",
        sessionId: buildSession.sdkSessionId,
        requestId: "request",
        phase: "building",
        prompt: "next",
        useTaskImages: false,
        startedAt: "2026-07-29T00:02:00.000Z",
      },
    });

    sendText(box, "use the helper");

    await waitFor(() => expect(sendMessageMock).toHaveBeenCalled());
    await waitFor(() => expect(box.value).toBe(""));
    expect(steerQueuedMock).not.toHaveBeenCalled();
  });

  test("only queues on an agent that cannot steer", async () => {
    const box = renderComposer({
      ...running,
      sessions: [{ ...running.sessions[0]!, agent: "grok" }],
    });

    sendText(box, "use the helper");

    await waitFor(() => expect(sendMessageMock).toHaveBeenCalled());
    await waitFor(() => expect(box.value).toBe(""));
    expect(steerQueuedMock).not.toHaveBeenCalled();
    expect(mockToastInfo).not.toHaveBeenCalled();
  });

  test("leaves commands in the queue", async () => {
    for (const command of ["/compact", "$skill do the thing"]) {
      cleanup();
      steerQueuedMock.mockClear();
      const box = renderComposer();

      sendText(box, command);

      await waitFor(() => expect(sendMessageMock).toHaveBeenCalledWith(running.id, command));
      await waitFor(() => expect(box.value).toBe(""));
      expect(steerQueuedMock).not.toHaveBeenCalled();
      sendMessageMock.mockClear();
    }
  });

  test("an explicit /steer still goes straight to the running turn", async () => {
    const box = renderComposer();

    sendText(box, "/steer change course");

    await waitFor(() =>
      expect(steerPipelineMock).toHaveBeenCalledWith(running.id, "change course"),
    );
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(steerQueuedMock).not.toHaveBeenCalled();
  });
});

describe("Auto-steer off", () => {
  test("a sent message waits in the queue with a Steer button", async () => {
    const box = renderComposer();
    fireEvent.change(box, { target: { value: "use the helper" } });
    expect(screen.getByRole("button", { name: "Send message" }).getAttribute("title")).toBe(
      "Add to queue",
    );

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(screen.getByText("1 queued")).toBeTruthy());
    expect(steerQueuedMock).not.toHaveBeenCalled();
    const strip = within(screen.getByTestId("compose-queue-item"));
    expect(strip.getByText("use the helper")).toBeTruthy();
    expect(strip.getByRole("button", { name: /^Steer queued prompt 1 of 1/ })).toBeTruthy();
    // The pipeline's queue has no separate manager to open.
    expect(screen.queryByRole("button", { name: /View queued prompts/ }) === null).toBe(true);
  });

  test("the Steer button moves that message into the running turn", async () => {
    renderComposer({
      ...running,
      pendingUserMessages: [
        queuedMessage,
        { id: "q2", text: "and the tests", createdAt: "2026-07-29T00:03:00.000Z" },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: /^Steer queued prompt 2 of 2/ }));

    await waitFor(() => expect(steerQueuedMock).toHaveBeenCalledWith(running.id, "q2"));
    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith("Steered the active Codex turn"),
    );
    expect(currentQueue()).toEqual(["use the helper"]);
  });

  test("a refused Steer click is an error and the message stays queued", async () => {
    steerQueuedMock.mockImplementationOnce(async (pipelineId: string) => ({
      pipeline: pipelineStore().getState().pipelines.get(pipelineId)!,
      delivery: "queued" as const,
      notice: "The turn is not accepting steering.",
    }));
    renderComposer({ ...running, pendingUserMessages: [queuedMessage] });

    fireEvent.click(screen.getByRole("button", { name: /^Steer queued prompt 1 of 1/ }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "The turn is not accepting steering. The message is still queued.",
      ),
    );
    expect(currentQueue()).toEqual(["use the helper"]);
  });

  test("a Steer click that loses the race says the message already left", async () => {
    steerQueuedMock.mockImplementationOnce(async (pipelineId: string) => ({
      pipeline: {
        ...pipelineStore().getState().pipelines.get(pipelineId)!,
        pendingUserMessages: undefined,
      },
      delivery: "gone" as const,
    }));
    renderComposer({ ...running, pendingUserMessages: [queuedMessage] });

    fireEvent.click(screen.getByRole("button", { name: /^Steer queued prompt 1 of 1/ }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "This message already left the queue, so it was not used to steer.",
      ),
    );
  });

  test("an unconfirmed Steer click hands the text back without overwriting a draft", async () => {
    const unconfirmed = async (pipelineId: string) => ({
      pipeline: {
        ...pipelineStore().getState().pipelines.get(pipelineId)!,
        pendingUserMessages: undefined,
      },
      delivery: "unconfirmed" as const,
      notice: "Delivery could not be confirmed.",
    });
    steerQueuedMock.mockImplementationOnce(unconfirmed);
    const box = renderComposer({ ...running, pendingUserMessages: [queuedMessage] });
    fireEvent.change(box, { target: { value: "half written" } });

    fireEvent.click(screen.getByRole("button", { name: /^Steer queued prompt 1 of 1/ }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Delivery could not be confirmed."),
    );
    expect(box.value).toBe("half written");
    expect(
      screen.getByText("Retained message — check the transcript before sending again"),
    ).toBeTruthy();
    expect(screen.getByText(queuedMessage.text)).toBeTruthy();
  });

  test("no Steer button between turns, on a paused build, or for a command", () => {
    const queued = [queuedMessage];
    renderComposer({ ...betweenTurns, pendingUserMessages: queued });
    expect(screen.queryByRole("button", { name: /^Steer queued prompt/ }) === null).toBe(true);
    cleanup();

    renderComposer({ ...running, phase: "paused", pendingUserMessages: queued });
    expect(screen.queryByRole("button", { name: /^Steer queued prompt/ }) === null).toBe(true);
    cleanup();

    renderComposer({
      ...running,
      pendingUserMessages: [{ ...queuedMessage, text: "/compact" }],
    });
    expect(screen.queryByRole("button", { name: /^Steer queued prompt/ }) === null).toBe(true);
    expect(screen.getByRole("button", { name: /^Remove queued prompt/ })).toBeTruthy();
  });

  test("Remove takes the message back", async () => {
    renderComposer({ ...running, pendingUserMessages: [queuedMessage] });

    fireEvent.click(screen.getByRole("button", { name: /^Remove queued prompt/ }));

    await waitFor(() => expect(removeQueuedMock).toHaveBeenCalledWith(running.id, "q1"));
    await waitFor(() => expect(screen.queryByTestId("compose-queue-strip") === null).toBe(true));
  });

  test("Edit loads the message into the box and takes it out of the queue", async () => {
    const box = renderComposer({ ...running, pendingUserMessages: [queuedMessage] });

    fireEvent.click(screen.getByRole("button", { name: /^Edit queued prompt/ }));

    await waitFor(() => expect(box.value).toBe("use the helper"));
    expect(currentQueue()).toEqual([]);
  });

  test("Edit retains text typed while removal is pending", async () => {
    let finish!: (value: { pipeline: BuildPipeline; removed: boolean }) => void;
    removeQueuedMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const box = renderComposer({ ...running, pendingUserMessages: [queuedMessage] });
    fireEvent.click(screen.getByRole("button", { name: /^Edit queued prompt/ }));
    await waitFor(() => expect(removeQueuedMock).toHaveBeenCalled());
    fireEvent.change(box, { target: { value: "new typing" } });
    finish({ pipeline: { ...running, backendRevision: 50 }, removed: true });
    await waitFor(() => expect(screen.getByText(queuedMessage.text)).toBeTruthy());
    expect(box.value).toBe("new typing");
  });

  test("retained steer text rehydrates alongside an occupied draft", () => {
    const box = renderComposer({
      ...running,
      pendingUserSteers: [{ ...queuedMessage, requestId: "attempt-1" }],
    });
    fireEvent.change(box, { target: { value: "new draft" } });
    expect(screen.getByText(queuedMessage.text)).toBeTruthy();
    expect(box.value).toBe("new draft");
  });

  test("validation blocks send and steer but keeps edit and remove available", () => {
    setAutoSteer(true);
    const box = renderComposer({
      ...running,
      pendingUserMessages: [queuedMessage],
      validationRun: newReviewValidationRun("validation", {
        headRef: "1".repeat(40),
        commands: [],
        limitations: ["Fixture validation"],
      }),
    });
    expect(box.disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Send message" }).getAttribute("title")).toContain(
      "Validation",
    );
    expect(screen.queryByRole("button", { name: /^Steer queued prompt/ }) === null).toBe(true);
    expect(screen.getByRole("button", { name: /^Edit queued prompt/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Remove queued prompt/ })).toBeTruthy();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(steerQueuedMock).not.toHaveBeenCalled();
  });

  test("Edit refuses to overwrite a draft", () => {
    const box = renderComposer({ ...running, pendingUserMessages: [queuedMessage] });
    fireEvent.change(box, { target: { value: "half written" } });

    fireEvent.click(screen.getByRole("button", { name: /^Edit queued prompt/ }));

    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(removeQueuedMock).not.toHaveBeenCalled();
    expect(box.value).toBe("half written");
  });

  test("Edit does not load a message that already left the queue", async () => {
    removeQueuedMock.mockImplementationOnce(async (pipelineId: string) => ({
      pipeline: pipelineStore().getState().pipelines.get(pipelineId)!,
      removed: false,
    }));
    const box = renderComposer({ ...running, pendingUserMessages: [queuedMessage] });

    fireEvent.click(screen.getByRole("button", { name: /^Edit queued prompt/ }));

    await waitFor(() => expect(removeQueuedMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "This message already left the queue, so it can no longer be changed.",
      ),
    );
    expect(box.value).toBe("");
  });

  test("ArrowUp moves to the queue and Escape returns to the caret", () => {
    const box = renderComposer({ ...running, pendingUserMessages: [queuedMessage] });
    fireEvent.change(box, { target: { value: "draft" } });
    box.focus();
    box.setSelectionRange(2, 2);

    fireEvent.keyDown(box, { key: "ArrowUp" });
    const steer = screen.getByRole("button", { name: /^Steer queued prompt 1 of 1/ });
    expect(document.activeElement).toBe(steer);

    fireEvent.keyDown(steer, { key: "Escape" });
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe(2);
  });

  test("ArrowUp below the first line stays in the box", () => {
    const box = renderComposer({ ...running, pendingUserMessages: [queuedMessage] });
    fireEvent.change(box, { target: { value: "one\ntwo" } });
    box.focus();
    box.setSelectionRange(6, 6);

    fireEvent.keyDown(box, { key: "ArrowUp" });

    expect(document.activeElement).toBe(box);
  });
});

describe("queuedSteerNotice", () => {
  test("words each outcome for the source that asked", () => {
    expect(queuedSteerNotice({ delivery: "steered" }, "Claude", "steer-button").tone).toBe(
      "success",
    );
    expect(queuedSteerNotice({ delivery: "queued" }, "Claude", "auto-steer")).toEqual({
      tone: "info",
      message: "The running turn could not be steered. Your message was queued instead.",
    });
    expect(queuedSteerNotice({ delivery: "queued" }, "Claude", "steer-button")).toEqual({
      tone: "error",
      message: "The running turn could not be steered. The message is still queued.",
    });
    expect(queuedSteerNotice({ delivery: "unconfirmed" }, "Claude", "auto-steer").tone).toBe(
      "error",
    );
    for (const source of ["auto-steer", "steer-button"] as const) {
      expect(queuedSteerNotice({ delivery: "next-turn" }, "Claude", source)).toEqual({
        tone: "info",
        message: "Claude has finished its turn, so your message will be sent as a new turn.",
      });
    }
  });
});

describe("waiting on background work", () => {
  const waiting: BuildPipeline = {
    ...running,
    sessions: [{ ...buildSession, status: "running", awaitingBackgroundWork: true }],
  };

  test("says what the agent is doing and offers no steer", () => {
    const box = renderComposer({ ...waiting, pendingUserMessages: [queuedMessage] });

    expect(screen.getByRole("status").textContent).toBe("Codex is waiting on background work…");
    expect(screen.queryByText(/is thinking/) === null).toBe(true);
    expect(screen.queryByRole("button", { name: /^Steer queued prompt/ }) === null).toBe(true);
    fireEvent.change(box, { target: { value: "use the helper" } });
    expect(screen.getByRole("button", { name: "Send message" }).getAttribute("title")).toBe(
      "Send message",
    );
  });

  test("Auto-steer sends the message without trying to steer", async () => {
    setAutoSteer(true);
    const box = renderComposer(waiting);

    sendText(box, "use the helper");

    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledWith(running.id, "use the helper"));
    expect(steerQueuedMock).not.toHaveBeenCalled();
  });

  test("the stall banner says the turn already finished", () => {
    renderComposer({
      ...waiting,
      stallWarning: {
        sessionId: buildSession.sdkSessionId,
        detectedAt: "2026-07-29T00:03:30.000Z",
      },
    });

    expect(
      screen.getByText(/finished its turn and is waiting on background work, but its transcript/),
    ).toBeTruthy();
  });
});
