import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { RichMessageContext } from "@/lib/chat/rich-identity";
import { buildPlanRevisionIndex } from "@/lib/plan-revisions";
import type { NativeMessage, NativeMessagePart } from "@/lib/chat/native-message-types";
import { mockWriteText } from "../../../../../tests/mocks/clipboard";
import { mockToastError } from "../../../../../tests/mocks/sonner";
import { MessagePart } from "./NativeMessage.renderer";
import { ToolDetailLoaderContext } from "./NativeMessage.shared";
import type { NativeAgentToolDetails } from "@orkestrator/protocol/native-agent";
import { PlanToolPart } from "./PlanToolPart";
import { PlanCardScopeContext, type PlanCardScope } from "./plan-card-context";

afterEach(() => {
  cleanup();
  mockWriteText.mockClear();
});

const FIRST = "# First approach\n\nUse a queue.";
const SECOND = "# Second approach\n\nUse a stream.";

type PlanPart = Extract<NativeMessagePart, { type: "tool-invocation" }>;

const first: PlanPart = {
  type: "tool-invocation",
  content: "Plan",
  toolName: "createPlan",
  toolUseId: "p1",
  toolState: "success",
  toolOutput: FIRST,
};
const second: PlanPart = { ...first, toolUseId: "p2", toolOutput: SECOND };

function conversation(): NativeMessage[] {
  return [
    {
      id: "a1",
      role: "assistant",
      content: "",
      createdAt: "2026-11-19T10:00:00.000Z",
      parts: [first],
    },
    {
      id: "a2",
      role: "assistant",
      content: "",
      createdAt: "2026-11-19T10:05:00.000Z",
      parts: [second],
    },
  ];
}

function inMessage(messageId: string, scope: PlanCardScope | null, children: ReactNode) {
  return (
    <PlanCardScopeContext.Provider value={scope}>
      <RichMessageContext.Provider value={{ messageId, role: "assistant" }}>
        {children}
      </RichMessageContext.Provider>
    </PlanCardScopeContext.Provider>
  );
}

function renderBoth(scope: PlanCardScope) {
  return renderInAppCommandScope(
    <>
      {inMessage(
        "a1",
        scope,
        <PlanToolPart
          toolName="createPlan"
          sourcePart={first}
          toolState="success"
          toolOutput={FIRST}
        />,
      )}
      {inMessage(
        "a2",
        scope,
        <PlanToolPart
          toolName="createPlan"
          sourcePart={second}
          toolState="success"
          toolOutput={SECOND}
        />,
      )}
    </>,
  );
}

describe("PlanToolPart revisions", () => {
  test("makes the current plan unmistakable and keeps the superseded one readable", () => {
    const index = buildPlanRevisionIndex(conversation(), { historyComplete: true });
    renderBoth({ index });

    const previous = screen.getByRole("region", { name: "Superseded plan: First approach" });
    const current = screen.getByRole("region", { name: "Implementation plan: Second approach" });

    expect(within(previous).getByText("Superseded")).toBeTruthy();
    expect(within(previous).getByText("Revision 1 of 2")).toBeTruthy();
    expect(within(previous).getByText(/A newer plan replaced this one/)).toBeTruthy();
    expect(within(previous).getByText("Use a queue.")).toBeTruthy();

    expect(within(current).getByText("Current plan")).toBeTruthy();
    expect(within(current).getByText("Revision 2 of 2")).toBeTruthy();
    expect(within(current).queryByText(/A newer plan replaced/) === null).toBe(true);
    // No actions were offered, so neither card claims anything can be implemented.
    expect(screen.queryByRole("button", { name: "Implement this plan" }) === null).toBe(true);
  });

  test("offers implementation only on the plan the actions are bound to", async () => {
    const index = buildPlanRevisionIndex(conversation(), { historyComplete: true });
    const implement = mock(async () => {});
    const switchToBuild = mock(async () => {});
    renderBoth({
      index,
      actions: {
        planKey: "tool:p2",
        pending: false,
        implement,
        switchToBuild,
        reportVisibility: mock(),
      },
    });

    const previous = screen.getByRole("region", { name: "Superseded plan: First approach" });
    const current = screen.getByRole("region", { name: "Implementation plan: Second approach" });
    expect(within(previous).queryByRole("button", { name: "Implement this plan" }) === null).toBe(
      true,
    );
    expect(within(current).getByText(/revision 2 of this plan/)).toBeTruthy();
    expect(within(current).getByText(/usual permission rules still apply/)).toBeTruthy();

    fireEvent.click(within(current).getByRole("button", { name: "Implement this plan" }));
    await waitFor(() => expect(implement).toHaveBeenCalledWith(index.byKey.get("tool:p2"), SECOND));

    fireEvent.click(within(current).getByRole("button", { name: "Switch to Build" }));
    await waitFor(() => expect(switchToBuild).toHaveBeenCalled());
  });

  test("disables the actions while a transition is in flight", () => {
    const index = buildPlanRevisionIndex(conversation(), { historyComplete: true });
    renderBoth({
      index,
      actions: {
        planKey: "tool:p2",
        pending: true,
        implement: mock(),
        switchToBuild: mock(),
        reportVisibility: mock(),
      },
    });
    const button = screen.getByRole("button", { name: "Implement this plan" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  test("shows the drafting state of a plan still being written", () => {
    const messages = conversation();
    const draft: PlanPart = {
      ...second,
      toolUseId: "p3",
      toolState: "pending",
      toolOutput: undefined,
    };
    messages.push({ ...messages[1]!, id: "a3", parts: [draft] });
    const index = buildPlanRevisionIndex(messages, { historyComplete: true });
    renderInAppCommandScope(
      inMessage(
        "a3",
        { index },
        <PlanToolPart toolName="createPlan" sourcePart={draft} toolState="pending" />,
      ),
    );
    expect(screen.getByText("Drafting…")).toBeTruthy();
    expect(screen.getByText("Writing plan…")).toBeTruthy();
  });

  test.each([true, false])(
    "guards implementation during a deferred read (success: %s)",
    async (success) => {
      const detailRef = `deferred-plan-${success}`;
      const part = {
        ...second,
        toolUseId: undefined,
        sourceMessageId: "source-row",
        sourcePartId: "plan",
        toolOutput: undefined,
        detailRef,
      };
      const index = buildPlanRevisionIndex([{ ...conversation()[1]!, parts: [part] }], {
        historyComplete: true,
      });
      const planKey = index.currentKey!;
      const implement = mock();
      const switchToBuild = mock();
      const details = Promise.withResolvers<NativeAgentToolDetails>();
      renderInAppCommandScope(
        inMessage(
          "a2",
          {
            index,
            actions: {
              planKey,
              pending: false,
              implement,
              switchToBuild,
              reportVisibility: mock(),
            },
          },
          <ToolDetailLoaderContext.Provider value={() => details.promise}>
            <MessagePart part={part} partKey="plan" />
          </ToolDetailLoaderContext.Provider>,
        ),
      );
      const button = screen.getByRole<HTMLButtonElement>("button", { name: "Implement this plan" });
      expect(screen.getByText("Revision 1 of 1")).toBeTruthy();
      expect(screen.getByText("Loading plan…")).toBeTruthy();
      expect(button.disabled).toBe(true);
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "Switch to Build" }).disabled,
      ).toBe(false);
      await act(async () => {
        if (success) details.resolve({ detailRef, toolOutput: SECOND });
        else details.reject(new Error("Plan details unavailable"));
      });
      if (success) {
        expect(
          screen.getByRole("region", { name: "Implementation plan: Second approach" }),
        ).toBeTruthy();
        expect(button.disabled).toBe(false);
        fireEvent.click(button);
        expect(implement).toHaveBeenCalledWith(index.byKey.get(planKey), SECOND);
      } else {
        expect(screen.getByText("Plan details unavailable")).toBeTruthy();
        expect(button.disabled).toBe(true);
        expect(implement).not.toHaveBeenCalled();
      }
    },
  );
});

describe("PlanToolPart copy and export", () => {
  test("copies the plan Markdown", async () => {
    renderInAppCommandScope(
      inMessage("a1", null, <PlanToolPart toolName="createPlan" toolOutput={FIRST} />),
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy plan as Markdown" }));
    await waitFor(() => expect(mockWriteText).toHaveBeenCalledWith(FIRST));
    expect(await screen.findByRole("button", { name: "Copied plan Markdown" })).toBeTruthy();
  });

  test("exports the plan as a Markdown file named after it", async () => {
    const createObjectURL = spyOn(URL, "createObjectURL").mockReturnValue("blob:plan");
    const revokeObjectURL = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const clicked: string[] = [];
    const click = spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.download);
    });
    try {
      renderInAppCommandScope(
        inMessage("a1", null, <PlanToolPart toolName="createPlan" toolOutput={FIRST} />),
      );
      fireEvent.click(screen.getByRole("button", { name: "Export plan as Markdown file" }));

      expect(clicked).toEqual(["First approach.md"]);
      const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
      expect(blob.type).toBe("text/markdown");
      expect(await blob.text()).toBe(FIRST);
    } finally {
      click.mockRestore();
      createObjectURL.mockRestore();
      revokeObjectURL.mockRestore();
    }
  });

  test("offers no copy or export before the plan has content", () => {
    renderInAppCommandScope(
      inMessage("a1", null, <PlanToolPart toolName="createPlan" toolState="pending" />),
    );
    expect(screen.queryByRole("button", { name: "Copy plan as Markdown" }) === null).toBe(true);
    expect(screen.getByText("writing...")).toBeTruthy();
  });

  test("reports clipboard and download failures", async () => {
    mockWriteText.mockRejectedValueOnce(new Error("Clipboard unavailable"));
    const createObjectURL = spyOn(URL, "createObjectURL").mockImplementationOnce(() => {
      throw new Error("Download unavailable");
    });
    try {
      renderInAppCommandScope(<PlanToolPart toolName="createPlan" toolOutput={FIRST} />);
      fireEvent.click(screen.getByRole("button", { name: "Copy plan as Markdown" }));
      await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("Failed to copy the plan"));
      expect(screen.getByRole("button", { name: "Copy plan as Markdown" })).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Export plan as Markdown file" }));
      expect(mockToastError).toHaveBeenCalledWith("Failed to export the plan");
    } finally {
      createObjectURL.mockRestore();
    }
  });
});
