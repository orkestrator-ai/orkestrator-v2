import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DesignStyleField, pickerColor } from "./DesignStyleField";

const cssDescriptor = Object.getOwnPropertyDescriptor(globalThis, "CSS");
const getContextDescriptor = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  "getContext",
);

function setSupports(implementation: (property: string, value: string) => boolean) {
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: { supports: implementation },
  });
}

function setContext(value: unknown) {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: mock(() => value),
  });
}

afterEach(() => {
  cleanup();
  if (cssDescriptor) Object.defineProperty(globalThis, "CSS", cssDescriptor);
  else delete (globalThis as unknown as Record<string, unknown>).CSS;
  if (getContextDescriptor)
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", getContextDescriptor);
});

test("pickerColor rejects stylesheet-dependent and unsupported colors without using canvas", () => {
  setSupports(() => true);
  const getContext = mock(() => null);
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: getContext,
  });

  for (const value of ["var(--accent)", "currentcolor", "inherit", "initial", "unset", "revert"])
    expect(pickerColor(value)).toBeNull();
  expect(getContext).not.toHaveBeenCalled();

  setSupports(() => false);
  expect(pickerColor("not-a-color")).toBeNull();
  expect(getContext).not.toHaveBeenCalled();
});

test("pickerColor falls back when color support or the 2D canvas context is unavailable", () => {
  setSupports(() => {
    throw new Error("CSS parser unavailable");
  });
  expect(pickerColor("red")).toBeNull();

  setSupports(() => true);
  setContext(null);
  expect(pickerColor("red")).toBeNull();
});

test("pickerColor resolves RGB channels and alpha from the browser canvas", () => {
  setSupports(() => true);
  setContext({
    fillStyle: "",
    fillRect: mock(() => undefined),
    getImageData: mock(() => ({ data: new Uint8ClampedArray([10, 20, 30, 102]) })),
  });
  expect(pickerColor("rgba(10, 20, 30, .4)")).toEqual({ hex: "#0a141e", alpha: 0.4 });
});

test("the color input preserves partial transparency when changing hue", () => {
  setSupports(() => true);
  setContext({
    fillStyle: "",
    fillRect: mock(() => undefined),
    getImageData: mock(() => ({ data: new Uint8ClampedArray([10, 20, 30, 102]) })),
  });
  const onChange = mock((_value: string) => undefined);
  render(
    <DesignStyleField
      property={{ name: "background-color", label: "Background", color: true }}
      value="rgba(10, 20, 30, .4)"
      onChange={onChange}
    />,
  );
  fireEvent.change(screen.getByLabelText("Pick background-color"), {
    target: { value: "#336699" },
  });
  expect(onChange).toHaveBeenCalledWith("rgba(51, 102, 153, 0.4)");
});

test("custom input mode resets to the stylesheet preset when the selected element changes", async () => {
  const property = { name: "font-weight", label: "Weight", options: ["400", "700"] };
  const onChange = mock((_value: string) => undefined);
  const view = render(
    <DesignStyleField property={property} value="" onChange={onChange} scopeKey="frame-a:#one" />,
  );
  fireEvent.pointerDown(screen.getByRole("combobox", { name: "font-weight" }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  fireEvent.click(await screen.findByRole("option", { name: "Custom…" }));
  expect(screen.getByRole("textbox", { name: "font-weight" })).toBeTruthy();

  view.rerender(
    <DesignStyleField property={property} value="" onChange={onChange} scopeKey="frame-a:#two" />,
  );
  expect(screen.queryByRole("textbox", { name: "font-weight" }) === null).toBe(true);
  expect(screen.getByRole("combobox", { name: "font-weight" }).textContent).toContain(
    "Use stylesheet",
  );
  view.rerender(
    <DesignStyleField property={property} value="" onChange={onChange} scopeKey="frame-a:#one" />,
  );
  expect(screen.getByRole("combobox", { name: "font-weight" })).toBeTruthy();
});
