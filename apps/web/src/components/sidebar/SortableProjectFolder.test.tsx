import { afterEach, expect, mock, test } from "bun:test";
import { DndContext, KeyboardSensor, useSensor, useSensors } from "@dnd-kit/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { SortableProjectFolder } from "./SortableProjectFolder";

afterEach(cleanup);

function KeyboardDragContext({
  onDragStart,
  children,
}: {
  onDragStart: () => void;
  children: ReactNode;
}) {
  const sensors = useSensors(useSensor(KeyboardSensor));
  return (
    <DndContext sensors={sensors} onDragStart={onDragStart}>
      {children}
    </DndContext>
  );
}

for (const [key, code] of [
  ["Enter", "Enter"],
  [" ", "Space"],
]) {
  test(`${code} preserves native opening on the heading and starts dragging only from the grip`, () => {
    const onOpen = mock(() => {});
    const onDragStart = mock(() => {});
    const onToggleCollapse = mock(() => {});
    render(
      <KeyboardDragContext onDragStart={onDragStart}>
        <SortableProjectFolder
          name="github.com/acme/app"
          label="acme/app"
          repository
          onOpen={onOpen}
          openMachineName="This computer"
          projectCount={1}
          isCollapsed={false}
          onToggleCollapse={onToggleCollapse}
        >
          <span>Member</span>
        </SortableProjectFolder>
      </KeyboardDragContext>,
    );
    const heading = screen.getByRole("button", { name: "Open acme/app on This computer" });
    act(() => heading.focus());
    expect(fireEvent.keyDown(heading, { key, code })).toBe(true);
    expect(fireEvent.keyUp(heading, { key, code })).toBe(true);
    // Happy DOM does not generate the native button click from keyboard events.
    // The browser suite covers that default action; here verify it stays uncancelled.
    fireEvent.click(heading);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onDragStart).not.toHaveBeenCalled();
    expect(onToggleCollapse).not.toHaveBeenCalled();

    const grip = screen.getByRole("button", { name: "Move repository acme/app" });
    act(() => grip.focus());
    expect(fireEvent.keyDown(grip, { key, code })).toBe(false);
    expect(onDragStart).toHaveBeenCalledTimes(1);
    expect(grip.getAttribute("aria-pressed")).toBe("true");
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onToggleCollapse).not.toHaveBeenCalled();
  });
}

test.each([false, true])(
  "right-click is captured only when folder actions exist (actions: %s)",
  async (hasActions) => {
    render(
      <SortableProjectFolder
        name="acme/app"
        repository
        onOpen={() => {}}
        projectCount={1}
        isCollapsed={false}
        onToggleCollapse={() => {}}
        onSort={hasActions ? () => {} : undefined}
      >
        <span>Member</span>
      </SortableProjectFolder>,
    );
    let notCancelled = false;
    await act(async () => {
      notCancelled = fireEvent.contextMenu(screen.getByRole("button", { name: "Open acme/app" }));
    });
    expect(notCancelled).toBe(!hasActions);
    expect(screen.queryByRole("menu") !== null).toBe(hasActions);
    if (hasActions) expect(screen.getByRole("menuitem", { name: "Sort" })).toBeTruthy();
  },
);
