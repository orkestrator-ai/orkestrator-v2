import { expect, spyOn, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import * as sortable from "@dnd-kit/sortable";
import { SortableCoordinatorTab } from "./CoordinatorPaneTree";

test("coordinator tabs omit non-unit scales when dragged over unequal-width tabs", () => {
  const useSortable = sortable.useSortable;
  const sortableSpy = spyOn(sortable, "useSortable").mockImplementation((options) => ({
    ...useSortable(options),
    transform: { x: 120, y: -6, scaleX: 2.5, scaleY: 0.75 },
    transition: "transform 200ms ease",
    isDragging: true,
  }));
  try {
    render(
      <SortableCoordinatorTab
        conversationId="conversation-1"
        paneId="pane-1"
        isActive
        style={{ width: 120 }}
        data-testid="coordinator-tab"
      >
        Coordinator
      </SortableCoordinatorTab>,
    );

    const tab = screen.getByTestId("coordinator-tab");
    expect(tab.style.transform).toBe("translate3d(120px, -6px, 0)");
    expect(tab.style.transition).toBe("transform 200ms ease");
    expect(tab.style.width).toBe("120px");
  } finally {
    cleanup();
    sortableSpy.mockRestore();
  }
});
