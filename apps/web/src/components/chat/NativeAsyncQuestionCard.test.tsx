import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { NativeAsyncQuestionPart } from "@/lib/chat/native-message-types";
import { AsyncQuestionResponseContext } from "./NativeMessage.shared";
import { NativeAsyncQuestionCard, serializeAsyncQuestionAnswers } from "./NativeAsyncQuestionCard";
import { usePromptDraftStore } from "@/stores/promptDraftStore";

afterEach(() => {
  cleanup();
  usePromptDraftStore.getState().reset();
});

const part: NativeAsyncQuestionPart = {
  type: "async-question",
  content: "Which target?",
  asyncQuestion: {
    itemId: "item-1",
    questions: [
      { id: "item-1:0", title: "Which target?", options: ["Staging", "Production"] },
      { id: "item-1:1", title: "Any constraints?", options: [] },
    ],
  },
};

describe("NativeAsyncQuestionCard", () => {
  test("renders the agent's accompanying text with activity-neutral copy", () => {
    render(
      <AsyncQuestionResponseContext.Provider value={{ responses: [] }}>
        <NativeAsyncQuestionCard part={{ ...part, content: "I need this before deployment." }} />
      </AsyncQuestionResponseContext.Provider>,
    );

    expect(screen.getByText("I need this before deployment.")).toBeTruthy();
    expect(screen.getByText("Codex has a question")).toBeTruthy();
    expect(screen.queryByText(/continuing to work/i) === null).toBe(true);
  });

  test("preselects the first option without submitting it", () => {
    const respond = mock(async () => {});
    render(
      <AsyncQuestionResponseContext.Provider value={{ responses: [], respond }}>
        <NativeAsyncQuestionCard part={part} />
      </AsyncQuestionResponseContext.Provider>,
    );

    expect(screen.getByRole("button", { name: "Staging" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(respond).not.toHaveBeenCalled();
  });

  test("queues one labelled ordinary user response", async () => {
    const respond = mock(async () => {});
    render(
      <AsyncQuestionResponseContext.Provider value={{ responses: [], respond }}>
        <NativeAsyncQuestionCard part={part} />
      </AsyncQuestionResponseContext.Provider>,
    );
    fireEvent.change(screen.getByLabelText("Custom answer for Any constraints?"), {
      target: { value: "No downtime" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));

    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond).toHaveBeenCalledWith(
      "item-1",
      "Answers to your questions:\n\n- Which target?: Staging\n- Any constraints?: No downtime",
    );
  });

  test("rehydrates a sent response as a read-only card", () => {
    render(
      <AsyncQuestionResponseContext.Provider
        value={{
          responses: [
            {
              itemId: "item-1",
              requestId: "async-question:item-1",
              state: "sent",
            },
          ],
        }}
      >
        <NativeAsyncQuestionCard part={part} />
      </AsyncQuestionResponseContext.Provider>,
    );

    expect(screen.getByText("Your answer was sent to Codex.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send answer" }) === null).toBe(true);
  });

  test("keeps unfinished answers across an unmount", () => {
    const renderCard = () =>
      render(
        <AsyncQuestionResponseContext.Provider
          value={{ responses: [], draftScope: "env-env-1:tab-question" }}
        >
          <NativeAsyncQuestionCard part={part} />
        </AsyncQuestionResponseContext.Provider>,
      );
    const first = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Production" }));
    fireEvent.change(screen.getByLabelText("Custom answer for Any constraints?"), {
      target: { value: "After 5pm" },
    });
    first.unmount();

    renderCard();
    expect(screen.getByRole("button", { name: "Production" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(
      (screen.getByLabelText("Custom answer for Any constraints?") as HTMLTextAreaElement).value,
    ).toBe("After 5pm");
  });

  test("shows a submission error and allows retry", async () => {
    const respond = mock(async () => {
      throw new Error("Bridge unavailable");
    });
    render(
      <AsyncQuestionResponseContext.Provider value={{ responses: [], respond }}>
        <NativeAsyncQuestionCard part={part} />
      </AsyncQuestionResponseContext.Provider>,
    );
    fireEvent.change(screen.getByLabelText("Custom answer for Any constraints?"), {
      target: { value: "No downtime" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Bridge unavailable");
    expect(
      (screen.getByRole("button", { name: "Send answer" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  test("renders a failed durable response with recovery guidance", () => {
    render(
      <AsyncQuestionResponseContext.Provider
        value={{
          responses: [{ itemId: "item-1", requestId: "async-question:item-1", state: "failed" }],
        }}
      >
        <NativeAsyncQuestionCard part={part} />
      </AsyncQuestionResponseContext.Provider>,
    );

    expect(screen.getByRole("status").textContent).toContain("could not be sent");
  });
});

describe("serializeAsyncQuestionAnswers", () => {
  test("keeps titles attached to answers", () => {
    expect(
      serializeAsyncQuestionAnswers(part.asyncQuestion.questions, {
        "item-1:0": { option: "Production", freeText: "" },
        "item-1:1": { option: "", freeText: "After 5pm" },
      }),
    ).toContain("- Any constraints?: After 5pm");
  });
});
