import { afterEach, describe, expect, mock, test } from "bun:test";
import { useLayoutEffect } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import { SettingsPageLayout } from "./SettingsPageLayout";
import { FullscreenSettingsLayout, SettingsHeaderActions } from "./FullscreenSettingsLayout";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AgentModelPicker } from "@/components/chat/AgentModelPicker";
import { Z_FULLSCREEN_POPOVER } from "@/constants/z-index";
import { useConfigStore } from "@/stores/configStore";

afterEach(cleanup);

const menuItems = [
  { id: "general", label: "General", icon: <span>G</span> },
  { id: "network", label: "Network", icon: <span>N</span> },
];

describe("FullscreenSettingsLayout", () => {
  test("follows a newly requested section while already open", () => {
    const view = (defaultSection: string) => (
      <FullscreenSettingsLayout
        open
        onOpenChange={() => undefined}
        title="Settings"
        menuItems={menuItems}
        defaultSection={defaultSection}
      >
        {(section) => <p>active:{section}</p>}
      </FullscreenSettingsLayout>
    );
    const { rerender } = render(view("general"));
    expect(screen.getByText("active:general")).toBeTruthy();
    rerender(view("network"));
    expect(screen.getByText("active:network")).toBeTruthy();
  });

  test("a repeated request for the same section navigates every time", () => {
    const view = (sectionRequest: number) => (
      <FullscreenSettingsLayout
        open
        onOpenChange={() => undefined}
        title="Settings"
        menuItems={menuItems}
        defaultSection="network"
        sectionRequest={sectionRequest}
      >
        {(section) => <p>active:{section}</p>}
      </FullscreenSettingsLayout>
    );
    const { rerender } = render(view(1));
    expect(screen.getByText("active:network")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /General/ }));
    expect(screen.getByText("active:general")).toBeTruthy();
    rerender(view(2));
    expect(screen.getByText("active:network")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /General/ }));
    rerender(view(3));
    expect(screen.getByText("active:network")).toBeTruthy();
    // An unrelated re-render is not a request.
    fireEvent.click(screen.getByRole("button", { name: /General/ }));
    rerender(view(3));
    expect(screen.getByText("active:general")).toBeTruthy();
  });

  test("keeps the application surface independent of a light terminal background", () => {
    const originalConfig = useConfigStore.getState().config;
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          terminalAppearance: {
            ...state.config.global.terminalAppearance,
            backgroundColor: "#ffffff",
          },
        },
      },
    }));

    try {
      render(
        <FullscreenSettingsLayout
          open
          onOpenChange={() => undefined}
          title="Settings"
          menuItems={menuItems}
        >
          {(section) => section}
        </FullscreenSettingsLayout>,
      );

      const dialog = screen.getByRole("dialog", { name: "Settings" });
      expect(dialog.className).toContain("bg-background");
      expect(dialog.style.getPropertyValue("--color-background")).toBe("");
    } finally {
      useConfigStore.setState({ config: originalConfig });
    }
  });

  test("renders nothing while closed", () => {
    const { container } = render(
      <FullscreenSettingsLayout
        open={false}
        onOpenChange={() => undefined}
        title="Settings"
        menuItems={menuItems}
      >
        {(section) => section}
      </FullscreenSettingsLayout>,
    );
    expect(container.firstChild).toBeNull();
  });

  test("switches sections, renders actions next to close, and closes from Escape and the close button", () => {
    const onOpenChange = mock(() => undefined);
    render(
      <FullscreenSettingsLayout
        open
        onOpenChange={onOpenChange}
        title="Settings"
        menuItems={menuItems}
        headerActions={<button>Save</button>}
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
    const saveButton = screen.getByRole("button", { name: "Save" });
    const headerActions = saveButton.closest('[data-slot="settings-header-actions"]');
    expect(headerActions).toBeTruthy();
    expect(headerActions?.nextElementSibling).toBe(
      screen.getByRole("button", { name: "Close settings" }),
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(onOpenChange).toHaveBeenCalledTimes(2);
  });

  test("a header lead leaves the section heading with its content", () => {
    render(
      <FullscreenSettingsLayout
        open
        onOpenChange={() => undefined}
        title="Settings"
        menuItems={menuItems}
        headerStart={(section) => <span>machines for {section}</span>}
      >
        {(section) => (
          <SettingsPageLayout title={menuItems.find((item) => item.id === section)?.label} />
        )}
      </FullscreenSettingsLayout>,
    );

    const title = screen.getByRole("heading", { name: "General" });
    expect(title.closest('[data-slot="settings-content-scrollport"]')).toBeTruthy();
    expect(screen.getAllByRole("heading", { name: "General" })).toHaveLength(1);
    // Once in the desktop header and once in its own row on a narrow screen.
    expect(screen.getAllByText("machines for general")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /Network/ }));
    expect(screen.getAllByText("machines for network")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Network" })).toBeTruthy();
  });

  test("renders section-owned actions in the header", () => {
    render(
      <FullscreenSettingsLayout
        open
        onOpenChange={() => undefined}
        title="Settings"
        menuItems={menuItems}
      >
        {() => (
          <div>
            Section content
            <SettingsHeaderActions>
              <button>Reset</button>
              <button>Save changes</button>
            </SettingsHeaderActions>
          </div>
        )}
      </FullscreenSettingsLayout>,
    );

    const resetButton = screen.getByRole("button", { name: "Reset" });
    const saveButton = screen.getByRole("button", { name: "Save changes" });
    const headerActions = resetButton.closest('[data-slot="settings-header-actions"]');
    expect(headerActions).toBeTruthy();
    expect(headerActions?.contains(saveButton)).toBe(true);
    expect(screen.getByText("Section content").contains(resetButton)).toBe(false);
  });

  test("renders section-owned actions in place without a layout provider", () => {
    render(
      <div data-testid="standalone-section">
        Section content
        <SettingsHeaderActions>
          <button>Standalone save</button>
        </SettingsHeaderActions>
      </div>,
    );

    expect(
      screen
        .getByTestId("standalone-section")
        .contains(screen.getByRole("button", { name: "Standalone save" })),
    ).toBe(true);
  });

  test("keeps direct and portaled actions in separately owned containers", () => {
    const props = {
      open: true,
      onOpenChange: () => undefined,
      title: "Settings",
      menuItems,
      headerActions: <button>Direct action</button>,
    };
    const { rerender } = render(
      <FullscreenSettingsLayout {...props}>
        {() => (
          <SettingsHeaderActions>
            <button>Section action</button>
          </SettingsHeaderActions>
        )}
      </FullscreenSettingsLayout>,
    );

    const directAction = screen.getByRole("button", { name: "Direct action" });
    const sectionAction = screen.getByRole("button", { name: "Section action" });
    const actionGroup = directAction.closest('[data-slot="settings-header-actions"]');
    expect(actionGroup).toBeTruthy();
    expect(actionGroup).toBe(sectionAction.closest('[data-slot="settings-header-actions"]'));
    expect(directAction.parentElement).not.toBe(sectionAction.parentElement);

    rerender(
      <FullscreenSettingsLayout {...props}>
        {() => <div>Section content</div>}
      </FullscreenSettingsLayout>,
    );
    expect(screen.getByRole("button", { name: "Direct action" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Section action" }) === null).toBe(true);
  });

  test("restores section-owned actions after the layout closes and reopens", () => {
    const props = { onOpenChange: () => undefined, title: "Settings", menuItems };
    const children = () => (
      <SettingsHeaderActions>
        <button>Persistent action</button>
      </SettingsHeaderActions>
    );
    const { rerender } = render(
      <FullscreenSettingsLayout open {...props}>
        {children}
      </FullscreenSettingsLayout>,
    );
    expect(screen.getByRole("button", { name: "Persistent action" })).toBeTruthy();

    rerender(
      <FullscreenSettingsLayout open={false} {...props}>
        {children}
      </FullscreenSettingsLayout>,
    );
    expect(screen.queryByRole("button", { name: "Persistent action" }) === null).toBe(true);

    rerender(
      <FullscreenSettingsLayout open {...props}>
        {children}
      </FullscreenSettingsLayout>,
    );
    const restoredAction = screen.getByRole("button", { name: "Persistent action" });
    expect(restoredAction.closest('[data-slot="settings-header-actions"]')).toBeTruthy();
  });

  test("allows the mobile section selector to shrink beside persistent actions", () => {
    render(
      <FullscreenSettingsLayout
        open
        onOpenChange={() => undefined}
        title="Settings"
        menuItems={menuItems}
        headerActions={<button>Save</button>}
      >
        {(section) => <div>{section}</div>}
      </FullscreenSettingsLayout>,
    );

    const selector = screen.getByRole("combobox", { name: "Settings section" });
    const actions = screen
      .getByRole("button", { name: "Save" })
      .closest('[data-slot="settings-header-actions"]');
    expect(selector.className).toContain("min-w-0");
    expect(selector.className).toContain("flex-1");
    expect(actions?.className).toContain("min-w-0");
    expect(actions?.nextElementSibling).toBe(
      screen.getByRole("button", { name: "Close settings" }),
    );
  });

  test("portals the fullscreen layer outside its triggering container", () => {
    const { container } = render(
      <div data-testid="transformed-tool-popover">
        <FullscreenSettingsLayout
          open
          onOpenChange={() => undefined}
          title="Settings"
          menuItems={menuItems}
        >
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
      <FullscreenSettingsLayout
        open
        onOpenChange={() => undefined}
        title="Settings"
        menuItems={menuItems}
      >
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
      <FullscreenSettingsLayout
        open
        onOpenChange={() => undefined}
        title="Settings"
        menuItems={menuItems}
      >
        {() => (
          <Select value="one" onValueChange={onValueChange}>
            <SelectTrigger aria-label="Nested setting">
              <SelectValue />
            </SelectTrigger>
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
    expect(option.closest('[data-slot="select-content"]')?.className).toContain("z-[70]");

    fireEvent.click(option);
    expect(onValueChange).toHaveBeenCalledWith("two");
  });

  test("raises descendant dropdown menus above the fullscreen surface", () => {
    const onSelect = mock(() => undefined);
    render(
      <FullscreenSettingsLayout
        open
        onOpenChange={() => undefined}
        title="Settings"
        menuItems={menuItems}
      >
        {() => (
          <DropdownMenu>
            <DropdownMenuTrigger aria-label="Nested dropdown">Open</DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={onSelect}>Haiku</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </FullscreenSettingsLayout>,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Nested dropdown" }));
    const item = screen.getByRole("menuitem", { name: "Haiku" });
    const menu = item.closest('[data-slot="dropdown-menu-content"]');
    expect(menu?.className).toContain("z-[70]");
    expect(menu?.className).not.toContain("z-50");

    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  // The synthetic dropdown above proves the context wiring; this one proves the
  // component the fix exists for. `DropdownMenuContent` merges the caller's
  // `className` *after* the inherited layer, so a `z-*` added to the picker's
  // own content classes would silently win and put Settings → Defaults back
  // behind the fullscreen surface with every other test still green.
  test("raises the real agent model picker above the fullscreen surface", () => {
    render(
      <FullscreenSettingsLayout
        open
        onOpenChange={() => undefined}
        title="Settings"
        menuItems={menuItems}
      >
        {() => (
          <AgentModelPicker
            ariaLabel="Default model"
            models={[
              {
                platform: "codex",
                id: "model-1",
                label: "Model 1",
                description: "Model 1 description",
              },
            ]}
            selectedModelId="model-1"
            selectedModelLabel="Model 1"
            onModelChange={() => undefined}
            reasoningOptions={[{ id: "high", label: "High" }]}
            selectedReasoningId="high"
            selectedReasoningLabel="High"
          />
        )}
      </FullscreenSettingsLayout>,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Default model" }));
    const menu = document.querySelector("[data-native-model-picker]");
    expect(menu).toBeTruthy();
    expect(menu?.className).toContain(Z_FULLSCREEN_POPOVER);
    expect(menu?.className).not.toContain("z-50");
    expect(screen.getByRole("menuitemradio", { name: /Model 1/ })).toBeTruthy();
  });

  test("uses Escape to close the mobile selector before closing settings", () => {
    const onOpenChange = mock(() => undefined);
    render(
      <FullscreenSettingsLayout
        open
        onOpenChange={onOpenChange}
        title="Settings"
        menuItems={menuItems}
      >
        {(section) => <div>section:{section}</div>}
      </FullscreenSettingsLayout>,
    );

    const selector = screen.getByRole("combobox", { name: "Settings section" });
    fireEvent.keyDown(selector, { key: "Enter" });
    expect(screen.getByRole("option", { name: /Network/ })).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("option", { name: /Network/ }), { key: "Escape" });
    expect(screen.queryByRole("option", { name: /Network/ }) === null).toBe(true);
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

  test("falls back to the first section when an external default is invalid", () => {
    render(
      <FullscreenSettingsLayout
        open
        onOpenChange={() => undefined}
        title="Settings"
        menuItems={menuItems}
        defaultSection="missing"
      >
        {(section) => <div>section:{section}</div>}
      </FullscreenSettingsLayout>,
    );
    expect(screen.getByText("section:general")).toBeTruthy();
  });

  test("scrolls the section list independently on short windows", () => {
    render(
      <FullscreenSettingsLayout
        open
        onOpenChange={() => undefined}
        title="Settings"
        menuItems={menuItems}
      >
        {(section) => <div>section:{section}</div>}
      </FullscreenSettingsLayout>,
    );

    const navigation = screen.getByRole("navigation", { name: "Settings sections" });
    // The nav must be allowed to shrink below its content height to overflow.
    expect(navigation.className).toContain("min-h-0");
    expect(navigation.className).toContain("flex-1");
    expect(navigation.className).toContain("overflow-y-auto");
    expect(navigation.parentElement?.className).toContain("min-h-0");
    // The sidebar title stays pinned while the list scrolls.
    expect(screen.getByText("Settings").parentElement?.className).toContain("shrink-0");
  });

  test("keeps the active section visible in the scrollable list", () => {
    const original = HTMLElement.prototype.scrollIntoView;
    const scrolled: string[] = [];
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.textContent ?? "");
    };
    try {
      const view = (defaultSection: string) => (
        <FullscreenSettingsLayout
          open
          onOpenChange={() => undefined}
          title="Settings"
          menuItems={menuItems}
          defaultSection={defaultSection}
        >
          {(section) => <div>section:{section}</div>}
        </FullscreenSettingsLayout>
      );
      const { rerender } = render(view("general"));
      expect(scrolled).toEqual(["GGeneral"]);

      rerender(view("network"));
      expect(scrolled).toEqual(["GGeneral", "NNetwork"]);
      expect(screen.getByRole("button", { name: /Network/ }).getAttribute("aria-current")).toBe(
        "page",
      );
      expect(screen.getByRole("button", { name: /General/ }).hasAttribute("aria-current")).toBe(
        false,
      );

      // Unrelated re-renders do not yank the list back to the active item.
      rerender(view("network"));
      expect(scrolled).toEqual(["GGeneral", "NNetwork"]);
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
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
      <FullscreenSettingsLayout open {...props}>
        {(section) => <div>section:{section}</div>}
      </FullscreenSettingsLayout>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Network/ }));
    rerender(
      <FullscreenSettingsLayout open={false} {...props}>
        {(section) => <div>section:{section}</div>}
      </FullscreenSettingsLayout>,
    );
    rerender(
      <FullscreenSettingsLayout open {...props}>
        {(section) => <div>section:{section}</div>}
      </FullscreenSettingsLayout>,
    );
    expect(screen.getByText("section:general")).toBeTruthy();
  });

  test("takes focus when it opens and returns it to the opener when it closes", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    const view = (open: boolean) => (
      <FullscreenSettingsLayout
        open={open}
        onOpenChange={() => undefined}
        title="Settings"
        menuItems={menuItems}
      >
        {() => <button type="button">Inside</button>}
      </FullscreenSettingsLayout>
    );
    try {
      opener.focus();
      const { rerender } = render(view(true));
      expect(document.activeElement).toBe(screen.getByRole("button", { name: /General/ }));

      screen.getByRole("button", { name: "Inside" }).focus();
      rerender(view(false));
      expect(document.activeElement).toBe(opener);
    } finally {
      opener.remove();
    }
  });

  test("leaves focus another owner placed when it closes", () => {
    const opener = document.createElement("button");
    const elsewhere = document.createElement("button");
    document.body.append(opener, elsewhere);
    // Another owner moves focus in the commit that closes the layout.
    function FocusElsewhereOnClose({ open }: { open: boolean }) {
      useLayoutEffect(() => {
        if (!open) elsewhere.focus();
      }, [open]);
      return null;
    }
    const view = (open: boolean) => (
      <>
        <FullscreenSettingsLayout
          open={open}
          onOpenChange={() => undefined}
          title="Settings"
          menuItems={menuItems}
        >
          {() => null}
        </FullscreenSettingsLayout>
        <FocusElsewhereOnClose open={open} />
      </>
    );
    try {
      opener.focus();
      const { rerender } = render(view(true));
      rerender(view(false));
      expect(document.activeElement).toBe(elsewhere);
    } finally {
      opener.remove();
      elsewhere.remove();
    }
  });

  test("keeps Tab and Shift+Tab inside the layer", () => {
    render(
      <FullscreenSettingsLayout
        open
        onOpenChange={() => undefined}
        title="Settings"
        menuItems={menuItems}
      >
        {() => <button type="button">Last control</button>}
      </FullscreenSettingsLayout>,
    );
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    const first = screen.getByRole("button", { name: /General/ });
    const last = screen.getByRole("button", { name: "Last control" });

    // The initial control supports reverse wrapping before any forward Tab.
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  test("pulls focus back when it moves to the page underneath", () => {
    const underneath = document.createElement("button");
    document.body.append(underneath);
    try {
      render(
        <FullscreenSettingsLayout
          open
          onOpenChange={() => undefined}
          title="Settings"
          menuItems={menuItems}
        >
          {() => <button type="button">Inside</button>}
        </FullscreenSettingsLayout>,
      );
      const inside = screen.getByRole("button", { name: "Inside" });
      inside.focus();

      underneath.focus();

      expect(document.activeElement).toBe(inside);
    } finally {
      underneath.remove();
    }
  });

  test("lets a select opened inside it take focus, then traps again once it closes", async () => {
    const underneath = document.createElement("button");
    document.body.append(underneath);
    try {
      render(
        <FullscreenSettingsLayout
          open
          onOpenChange={() => undefined}
          title="Settings"
          menuItems={menuItems}
        >
          {() => <button type="button">Inside</button>}
        </FullscreenSettingsLayout>,
      );
      const picker = screen.getByRole("combobox", { name: "Settings section" });
      fireEvent.keyDown(picker, { key: "Enter" });
      const listbox = await screen.findByRole("listbox");
      // The select's own focus scope pauses the layer's trap while it is open,
      // so focus can sit in the select's portal outside the layer.
      await waitFor(() => expect(listbox.contains(document.activeElement)).toBe(true));
      fireEvent.click(screen.getByRole("option", { name: /Network/ }));
      await waitFor(() => expectDomAbsent(screen.queryByRole("listbox")));

      const inside = screen.getByRole("button", { name: "Inside" });
      inside.focus();
      underneath.focus();
      expect(document.activeElement).toBe(inside);
    } finally {
      underneath.remove();
    }
  });
});
