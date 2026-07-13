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
    const sectionSelector = screen.getByRole("combobox", { name: "Settings section" });
    expect(sectionSelector.textContent).toContain("General");
    const desktopNavigation = screen.getByRole("navigation", { name: "Settings sections" });
    expect(desktopNavigation.parentElement?.className).toContain("hidden");
    expect(desktopNavigation.parentElement?.className).toContain("md:flex");
    fireEvent.click(screen.getByRole("button", { name: /Network/ }));
    expect(screen.getByText("section:network")).toBeTruthy();
    expect(sectionSelector.textContent).toContain("Network");
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(onOpenChange).toHaveBeenCalledTimes(2);
  });

  test("portals the fullscreen layer outside its triggering container", () => {
    const { container } = render(
      <div data-testid="transformed-tool-popover">
        <FullscreenSettingsLayout open onOpenChange={() => undefined} title="Settings" menuItems={menuItems}>
          {(section) => <div>section:{section}</div>}
        </FullscreenSettingsLayout>
      </div>,
    );

    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
    expect(dialog.className).toContain("inset-0");
    expect(dialog.className).not.toContain("top-11");
    expect(dialog.className).toContain("md:top-7");
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
