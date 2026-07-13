import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FullscreenSettingsLayout } from "./FullscreenSettingsLayout";

afterEach(cleanup);

const menuItems = [
  { id: "general", label: "General", icon: <span>G</span> },
  { id: "network", label: "Network", icon: <span>N</span> },
];

describe("FullscreenSettingsLayout", () => {
  test("renders nothing while closed", () => {
    const { container } = render(
      <FullscreenSettingsLayout open={false} onOpenChange={() => undefined} title="Settings" menuItems={menuItems}>
        {(section) => section}
      </FullscreenSettingsLayout>,
    );
    expect(container.firstChild).toBeNull();
  });

  test("switches sections, renders the footer, and closes from Escape and the close button", () => {
    const onOpenChange = mock(() => undefined);
    render(
      <FullscreenSettingsLayout
        open
        onOpenChange={onOpenChange}
        title="Settings"
        menuItems={menuItems}
        footer={<button>Save</button>}
      >
        {(section) => <div>section:{section}</div>}
      </FullscreenSettingsLayout>,
    );

    expect(screen.getByText("section:general")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Network/ }));
    expect(screen.getByText("section:network")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(onOpenChange).toHaveBeenCalledTimes(2);
  });

  test("resets the active section when reopened", () => {
    const props = { onOpenChange: () => undefined, title: "Settings", menuItems };
    const { rerender } = render(
      <FullscreenSettingsLayout open {...props}>{(section) => <div>section:{section}</div>}</FullscreenSettingsLayout>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Network/ }));
    rerender(<FullscreenSettingsLayout open={false} {...props}>{(section) => <div>section:{section}</div>}</FullscreenSettingsLayout>);
    rerender(<FullscreenSettingsLayout open {...props}>{(section) => <div>section:{section}</div>}</FullscreenSettingsLayout>);
    expect(screen.getByText("section:general")).toBeTruthy();
  });
});
