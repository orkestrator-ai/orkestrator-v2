import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DesignElement, DesignFrame } from "@orkestrator/protocol/design-canvas";
import type { DesignFrameMeta } from "@orkestrator/protocol/design-operations";
import { clearInspectorDrafts } from "./design-inspector-drafts";
import type { DesignSelection, SelectionValidity } from "./design-selection";
import { DesignInspector, type DesignInspectorProps } from "./DesignInspector";
import type { DesignFrameBridge } from "./frame-bridge";

const cssDescriptor = Object.getOwnPropertyDescriptor(globalThis, "CSS");

const frame: DesignFrame = {
  id: "frame-1",
  name: "Home",
  x: 0,
  y: 0,
  width: 800,
  height: 600,
  html: "<h1 id='title'>Hi</h1>",
  revision: 3,
};
const meta = { contentId: "content-1", structureId: "structure-1" } as DesignFrameMeta;

function element(overrides: Partial<DesignElement> = {}): DesignElement {
  return {
    selector: "#title",
    key: "#title",
    tag: "h1",
    text: "Hi",
    attributes: { id: "title" },
    styles: {
      display: "block",
      position: "static",
      width: "100px",
      height: "20px",
      "font-size": "16px",
      color: "rgb(255, 0, 0)",
      "background-color": "rgba(0, 0, 0, 0)",
      "border-radius": "0px",
    },
    inline: { color: "red" },
    inlinePriority: {},
    rect: { x: 0, y: 0, width: 100, height: 20 },
    ...overrides,
  };
}

function selection(overrides: Partial<DesignSelection> = {}): DesignSelection {
  return {
    frameId: frame.id,
    revision: frame.revision,
    structureId: "structure-1",
    contentId: "content-1",
    element: element(),
    ...overrides,
  };
}

const onApply = mock((_styles: Record<string, string | null>): string | undefined => "intent-1");
const onReselect = mock(() => undefined);
const onClose = mock(() => undefined);
const onAskAgent = mock(() => undefined);

function props(overrides: Partial<DesignInspectorProps> = {}): DesignInspectorProps {
  return {
    environmentKey: "env-key",
    selection: selection(),
    validity: "current" as SelectionValidity,
    frame,
    meta,
    legacy: false,
    status: { pending: false },
    onApply,
    onReselect,
    onClose,
    onAskAgent,
    ...overrides,
  };
}

const textbox = (name: string) => screen.getByRole("textbox", { name }) as HTMLInputElement;
const applyButton = () => screen.getByRole("button", { name: "Apply styles" }) as HTMLButtonElement;
const type = (name: string, value: string) =>
  fireEvent.change(textbox(name), { target: { value } });

beforeEach(() => {
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: { supports: (_property: string, value: string) => !value.includes("bogus") },
  });
  onApply.mockReset();
  onApply.mockImplementation(() => "intent-1");
  onReselect.mockReset();
  onClose.mockReset();
  onAskAgent.mockReset();
});

afterEach(() => {
  cleanup();
  clearInspectorDrafts();
  if (cssDescriptor) Object.defineProperty(globalThis, "CSS", cssDescriptor);
  else delete (globalThis as unknown as Record<string, unknown>).CSS;
});

describe("DesignInspector", () => {
  test("groups controls into labelled sections", () => {
    render(<DesignInspector {...props()} />);
    const inspector = screen.getByRole("complementary", { name: "Element inspector" });
    expect(inspector.className).toContain("design-inspector");
    for (const title of ["Layout", "Size and spacing", "Typography", "Appearance", "Advanced"])
      expect(screen.getByRole("region", { name: title })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "position" })).toBeTruthy();
    expect(screen.getByLabelText("Pick background-color")).toBeTruthy();
    expect(applyButton().disabled).toBe(true);
  });

  test("shows the authored inline override separately from the computed value", () => {
    render(<DesignInspector {...props()} />);
    expect(textbox("color").value).toBe("red");
    const colorField = textbox("color").closest("[data-property]")!;
    expect(colorField.textContent).toContain("inline");
    expect(colorField.textContent).toContain("computed rgb(255, 0, 0)");
    expect(textbox("width").value).toBe("");
    expect(textbox("width").placeholder).toBe("100px");
    expect(textbox("width").closest("[data-property]")!.textContent).not.toContain("inline");
    expect(screen.queryByRole("button", { name: "Reset width" }) === null).toBe(true);
  });

  test("per-property reset removes the inline declaration instead of assigning the computed value", () => {
    render(<DesignInspector {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset color" }));
    expect(textbox("color").value).toBe("");
    expect(textbox("color").getAttribute("data-changed")).toBe("true");
    fireEvent.click(applyButton());
    expect(onApply).toHaveBeenCalledWith({ color: null });
  });

  test("changed fields are marked and can be reverted individually", () => {
    render(<DesignInspector {...props()} />);
    type("width", "50px");
    expect(textbox("width").getAttribute("data-changed")).toBe("true");
    expect(textbox("height").getAttribute("data-changed")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Revert width" }));
    expect(textbox("width").value).toBe("");
    expect(applyButton().disabled).toBe(true);
  });

  test("an invalid value blocks Apply with an associated error", () => {
    render(<DesignInspector {...props()} />);
    type("width", "bogus");
    const field = textbox("width");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    const describedBy = field.getAttribute("aria-describedby")!.split(" ");
    const messages = describedBy.map((id) => document.getElementById(id)?.textContent ?? "");
    expect(messages).toContain("Not a valid value for width");
    expect(applyButton().disabled).toBe(true);
    fireEvent.submit(applyButton().closest("form")!);
    expect(onApply).not.toHaveBeenCalled();
  });

  test("accepts !important and sends the declaration unchanged", () => {
    render(<DesignInspector {...props()} />);
    type("width", "10px !important");
    expect(textbox("width").getAttribute("aria-invalid")).toBeNull();
    fireEvent.click(applyButton());
    expect(onApply).toHaveBeenCalledWith({ width: "10px !important" });
  });

  test("a stale selection disables editing, keeps the draft, and offers Reselect and Discard", () => {
    const view = render(<DesignInspector {...props()} />);
    type("width", "50px");
    view.rerender(<DesignInspector {...props({ validity: "stale" })} />);
    expect(screen.getByText(/Changed elsewhere — Reselect/)).toBeTruthy();
    expect(textbox("width").disabled).toBe(true);
    expect(textbox("width").value).toBe("50px");
    expect(applyButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reselect" }));
    expect(onReselect).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(textbox("width").value).toBe("");
  });

  test("a draft survives remount with the same target and environment", () => {
    const first = render(<DesignInspector {...props()} />);
    type("width", "50px");
    first.unmount();
    render(<DesignInspector {...props({ environmentKey: "other-env" })} />);
    expect(textbox("width").value).toBe("");
    cleanup();
    render(<DesignInspector {...props()} />);
    expect(textbox("width").value).toBe("50px");
    expect(applyButton().disabled).toBe(false);
  });

  test("a draft from an earlier structure is offered, not applied automatically", () => {
    const first = render(<DesignInspector {...props()} />);
    type("width", "50px");
    first.unmount();
    render(
      <DesignInspector
        {...props({ selection: selection({ structureId: "structure-2", revision: 4 }) })}
      />,
    );
    expect(textbox("width").value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Restore draft" }));
    expect(textbox("width").value).toBe("50px");
  });

  test("a successful apply clears only the applied fields and restores focus", () => {
    const view = render(<DesignInspector {...props()} />);
    type("width", "50px");
    fireEvent.click(applyButton());
    expect(onApply).toHaveBeenCalledWith({ width: "50px" });
    view.rerender(<DesignInspector {...props({ status: { pending: true } })} />);
    expect(screen.getByText("Applying…")).toBeTruthy();
    type("height", "10px");
    view.rerender(<DesignInspector {...props({ status: { pending: false } })} />);
    expect(textbox("width").value).toBe("");
    expect(textbox("height").value).toBe("10px");
    expect(document.activeElement).toBe(applyButton());
  });

  test("a refused apply keeps the draft", () => {
    onApply.mockImplementation(() => undefined);
    render(<DesignInspector {...props()} />);
    type("width", "50px");
    fireEvent.click(applyButton());
    expect(textbox("width").value).toBe("50px");
    expect(applyButton().disabled).toBe(false);
  });

  test("backend failure details are shown near Apply and on the rejected field", () => {
    const view = render(<DesignInspector {...props()} />);
    type("width", "50px");
    fireEvent.click(applyButton());
    view.rerender(<DesignInspector {...props({ status: { pending: true } })} />);
    view.rerender(
      <DesignInspector
        {...props({
          status: {
            pending: false,
            failure: {
              code: "invalid-input",
              message: "Invalid style values",
              retry: "never",
              details: { properties: ["width"] },
            },
          },
        })}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Invalid style values");
    expect(alert.textContent).toContain("Rejected: width");
    expect(textbox("width").value).toBe("50px");
    expect(textbox("width").getAttribute("aria-invalid")).toBe("true");
    expect(applyButton().disabled).toBe(true);
    type("width", "60px");
    expect(textbox("width").getAttribute("aria-invalid")).toBeNull();
  });

  test("reports no-op applies", () => {
    render(<DesignInspector {...props({ status: { pending: false, unchanged: ["color"] } })} />);
    expect(screen.getByRole("status").textContent).toContain("No change: values already applied");
  });

  test("custom properties can be added through the advanced section", () => {
    render(<DesignInspector {...props()} />);
    const name = screen.getByRole("textbox", { name: "New property name" });
    fireEvent.change(name, { target: { value: "Bad Name" } });
    fireEvent.click(screen.getByRole("button", { name: "Add property" }));
    expect(name.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(name, { target: { value: "--brand" } });
    fireEvent.click(screen.getByRole("button", { name: "Add property" }));
    type("--brand", "#123456");
    expect(screen.getByText(/only where var\(\) uses it/)).toBeTruthy();
    fireEvent.click(applyButton());
    expect(onApply).toHaveBeenCalledWith({ "--brand": "#123456" });
  });

  test("shows bounded details, truncation, SVG, and legacy notices", () => {
    render(
      <DesignInspector
        {...props({
          legacy: true,
          selection: selection({
            element: element({ svg: true, attributesTruncated: true, textTruncated: true }),
          }),
        })}
      />,
    );
    expect(screen.getByText(/SVG element/)).toBeTruthy();
    expect(screen.getByText(/does not track element structure/)).toBeTruthy();
    expect(screen.getByText("Text truncated")).toBeTruthy();
    expect(screen.getByText("Some attributes are not shown.")).toBeTruthy();
  });

  test("close and ask-agent controls call their handlers", () => {
    render(<DesignInspector {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Close inspector" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask agent" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onAskAgent).toHaveBeenCalledTimes(1);
  });

  test("previews the draft locally and restores authoritative HTML on reset", async () => {
    const ask = mock(async (_operation: unknown) => ({ invalid: [], unchanged: [] }));
    const bridge = {
      ask,
      closed: false,
      renderedContentId: "content-1",
    } as unknown as DesignFrameBridge;
    render(<DesignInspector {...props({ bridge })} />);
    type("width", "50px");
    await waitFor(() =>
      expect(ask).toHaveBeenCalledWith({
        op: "previewStyles",
        selector: "#title",
        styles: { width: "50px" },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(ask).toHaveBeenCalledWith({ op: "render", html: frame.html }));
    expect(
      ask.mock.calls.some(([operation]) => (operation as { op: string }).op === "serialize"),
    ).toBe(false);
  });

  test("a runtime-rejected preview value blocks Apply", async () => {
    const ask = mock(async (_operation: unknown) => ({ invalid: ["width"], unchanged: [] }));
    const bridge = {
      ask,
      closed: false,
      renderedContentId: "content-1",
    } as unknown as DesignFrameBridge;
    render(<DesignInspector {...props({ bridge })} />);
    type("width", "50px");
    await waitFor(() => expect(textbox("width").getAttribute("aria-invalid")).toBe("true"));
    expect(applyButton().disabled).toBe(true);
  });
});
