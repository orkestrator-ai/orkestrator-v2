import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FullscreenSettingsLayout } from "./FullscreenSettingsLayout";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
    expect(dialog.className).toContain("md:top-[var(--desktop-title-bar-height)]");
  });

  test("changes sections through the mobile selector", () => {
    render(
      <FullscreenSettingsLayout open onOpenChange={() => undefined} title="Settings" menuItems={menuItems}>
        {(section) => <div>section:{section}</div>}
      </FullscreenSettingsLayout>,
    );

    const selector = screen.getByRole("combobox", { name: "Settings section" });
    fireEvent.keyDown(selector, { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: /Network/ }));

    expect(screen.getByText("section:network")).toBeTruthy();
    expect(selector.textContent).toContain("Network");
  });

  test("raises descendant select portals above the fullscreen surface", () => {
    const onValueChange = mock(() => undefined);
    render(
      <FullscreenSettingsLayout open onOpenChange={() => undefined} title="Settings" menuItems={menuItems}>
        {() => (
          <Select value="one" onValueChange={onValueChange}>
            <SelectTrigger aria-label="Nested setting"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="one">One</SelectItem>
              <SelectItem value="two">Two</SelectItem>
            </SelectContent>
          </Select>
        )}
      </FullscreenSettingsLayout>,
    );

    const selector = screen.getByRole("combobox", { name: "Nested setting" });
    fireEvent.keyDown(selector, { key: "Enter" });
    const option = screen.getByRole("option", { name: "Two" });
    expect(option.closest('[data-slot="select-content"]')?.className)
      .toContain("z-[70]");

    fireEvent.click(option);
    expect(onValueChange).toHaveBeenCalledWith("two");
  });

  test("uses Escape to close the mobile selector before closing settings", () => {
    const onOpenChange = mock(() => undefined);
    render(
      <FullscreenSettingsLayout open onOpenChange={onOpenChange} title="Settings" menuItems={menuItems}>
        {(section) => <div>section:{section}</div>}
      </FullscreenSettingsLayout>,
    );

    const selector = screen.getByRole("combobox", { name: "Settings section" });
    fireEvent.keyDown(selector, { key: "Enter" });
    expect(screen.getByRole("option", { name: /Network/ })).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("option", { name: /Network/ }), { key: "Escape" });
    expect(screen.queryByRole("option", { name: /Network/ })).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("honors an explicit default section", () => {
    render(
      <FullscreenSettingsLayout
        open
        onOpenChange={() => undefined}
        title="Settings"
        menuItems={menuItems}
        defaultSection="network"
      >
        {(section) => <div>section:{section}</div>}
      </FullscreenSettingsLayout>,
    );
    expect(screen.getByText("section:network")).toBeTruthy();
  });

  test("handles an empty menu", () => {
    render(
      <FullscreenSettingsLayout open onOpenChange={() => undefined} title="Settings" menuItems={[]}>
        {(section) => <div>section:{section || "empty"}</div>}
      </FullscreenSettingsLayout>,
    );
    expect(screen.getByText("section:empty")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Settings section" }).textContent).toBe("");
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
