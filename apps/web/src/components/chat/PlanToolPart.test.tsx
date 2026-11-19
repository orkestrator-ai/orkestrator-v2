import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { RichMessageContext } from "@/lib/chat/rich-identity";
import { buildPlanRevisionIndex } from "@/lib/plan-revisions";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import { mockWriteText } from "../../../../../tests/mocks/clipboard";
import { PlanToolPart } from "./PlanToolPart";
import { PlanCardScopeContext, type PlanCardScope } from "./plan-card-context";

afterEach(() => {
  cleanup();
  mockWriteText.mockClear();
});

const FIRST = "# First approach\n\nUse a queue.";
const SECOND = "# Second approach\n\nUse a stream.";

function conversation(): NativeMessage[] {
  return [
    {
      id: "a1",
      role: "assistant",
      content: "",
      createdAt: "2026-11-19T10:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "Plan",
          toolName: "createPlan",
          toolUseId: "p1",
          toolState: "success",
          toolOutput: FIRST,
        },
      ],
    },
    {
      id: "a2",
      role: "assistant",
      content: "",
      createdAt: "2026-11-19T10:05:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "Plan",
          toolName: "createPlan",
          toolUseId: "p2",
          toolState: "success",
          toolOutput: SECOND,
        },
      ],
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
          toolUseId="p1"
          toolState="success"
          toolOutput={FIRST}
        />,
      )}
      {inMessage(
        "a2",
        scope,
        <PlanToolPart
          toolName="createPlan"
          toolUseId="p2"
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
      actions: { planKey: "tool:p2", pending: false, implement, switchToBuild },
    });

    const previous = screen.getByRole("region", { name: "Superseded plan: First approach" });
    const current = screen.getByRole("region", { name: "Implementation plan: Second approach" });
    expect(within(previous).queryByRole("button", { name: "Implement this plan" }) === null).toBe(
      true,
    );
    expect(within(current).getByText(/revision 2 of this plan/)).toBeTruthy();
    expect(within(current).getByText(/usual permission rules still apply/)).toBeTruthy();

    fireEvent.click(within(current).getByRole("button", { name: "Implement this plan" }));
    await waitFor(() => expect(implement).toHaveBeenCalledWith("tool:p2", "Second approach"));

    fireEvent.click(within(current).getByRole("button", { name: "Switch to Build" }));
    await waitFor(() => expect(switchToBuild).toHaveBeenCalled());
  });

  test("disables the actions while a transition is in flight", () => {
    const index = buildPlanRevisionIndex(conversation(), { historyComplete: true });
    renderBoth({
      index,
      actions: { planKey: "tool:p2", pending: true, implement: mock(), switchToBuild: mock() },
    });
    const button = screen.getByRole("button", { name: "Implement this plan" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  test("shows the drafting state of a plan still being written", () => {
    const messages = conversation();
    const index = buildPlanRevisionIndex(
      [
        ...messages,
        {
          id: "a3",
          role: "assistant",
          content: "",
          createdAt: "2026-11-19T10:06:00.000Z",
          parts: [
            {
              type: "tool-invocation",
              content: "Plan",
              toolName: "createPlan",
              toolUseId: "p3",
              toolState: "pending",
            },
          ],
        },
      ],
      { historyComplete: true },
    );
    renderInAppCommandScope(
      inMessage(
        "a3",
        { index },
        <PlanToolPart toolName="createPlan" toolUseId="p3" toolState="pending" />,
      ),
    );
    expect(screen.getByText("Drafting…")).toBeTruthy();
    expect(screen.getByText("Writing plan…")).toBeTruthy();
  });
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
});
