import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TabShell } from "./TabShell";

describe("TabShell", () => {
  afterEach(cleanup);

  test("renders and dims the active marker for an unfocused pane", () => {
    const { container } = render(
      <TabShell isActive isFocused={false}>
        Tab title
      </TabShell>,
    );

    const indicator = container.querySelector("[aria-hidden='true'].bg-primary");
    expect(indicator).toBeTruthy();
    expect(indicator?.className).toContain("opacity-60");
  });

  test("keeps the close control visible on focus and isolates its events", () => {
    const onClick = mock(() => {});
    const onMouseDown = mock(() => {});
    const onClose = mock(() => {});

    render(
      <TabShell
        isActive={false}
        onClick={onClick}
        onMouseDown={onMouseDown}
        onClose={onClose}
        closeLabel="Close First"
        trailing={<span>Trailing control</span>}
      >
        First
      </TabShell>,
    );

    const close = screen.getByRole("button", { name: "Close First" });
    expect(close.className).toContain("md:focus-visible:opacity-100");
    expect(close.className).toContain("focus-visible:ring-2");
    expect(screen.getByText("Trailing control")).toBeTruthy();

    fireEvent.mouseDown(close);
    fireEvent.click(close);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
    expect(onMouseDown).not.toHaveBeenCalled();
  });

  test("omits inactive and unavailable controls", () => {
    const { container } = render(<TabShell isActive={false}>Tab title</TabShell>);

    expect(container.querySelector("[aria-hidden='true'].bg-primary") === null).toBe(true);
    expect(screen.queryByRole("button") === null).toBe(true);
  });
});
