import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DesignFrame } from "@orkestrator/protocol/design-canvas";
import { DesignFrameInspector, parseFrameField } from "./DesignFrameInspector";

const committed: DesignFrame = {
  id: "frame-1",
  name: "Home",
  x: 10,
  y: 20,
  width: 800,
  height: 600,
  html: "<main></main>",
  revision: 2,
};

const onSubmit = mock((_patch: Record<string, unknown>, _label: string) => undefined);
const onClose = mock(() => undefined);

const field = (name: string) =>
  screen.getByRole(name === "Name" ? "textbox" : "spinbutton", { name }) as HTMLInputElement;

beforeEach(() => {
  onSubmit.mockReset();
  onClose.mockReset();
});
afterEach(() => cleanup());

describe("parseFrameField", () => {
  test("validates names, dimensions, and coordinates", () => {
    expect(parseFrameField("name", "  Hero ")).toEqual({ ok: true, value: "Hero" });
    expect(parseFrameField("name", "  ")).toMatchObject({ ok: false });
    expect(parseFrameField("name", "x".repeat(121))).toMatchObject({ ok: false });
    expect(parseFrameField("width", "32")).toEqual({ ok: true, value: 32 });
    expect(parseFrameField("width", "31")).toMatchObject({ ok: false });
    expect(parseFrameField("height", "4097")).toMatchObject({ ok: false });
    expect(parseFrameField("width", "12.5")).toMatchObject({ ok: false });
    expect(parseFrameField("x", "-100000")).toEqual({ ok: true, value: -100000 });
    expect(parseFrameField("y", "100001")).toMatchObject({ ok: false });
    expect(parseFrameField("x", "")).toMatchObject({ ok: false });
  });
});

describe("DesignFrameInspector", () => {
  test("renders labelled numeric fields from the projected frame", () => {
    render(
      <DesignFrameInspector
        frame={committed}
        committed={committed}
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole("complementary", { name: "Frame properties" }).className).toContain(
      "design-inspector",
    );
    expect(field("Name").value).toBe("Home");
    expect(field("X").value).toBe("10");
    expect(field("Y").value).toBe("20");
    expect(field("Width").value).toBe("800");
    expect(field("Height").value).toBe("600");
    expect(screen.queryByText("Saving frame changes…") === null).toBe(true);
  });

  test("submits an absolute value on Enter and on blur", () => {
    render(
      <DesignFrameInspector
        frame={committed}
        committed={committed}
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    );
    fireEvent.change(field("Width"), { target: { value: "1024" } });
    fireEvent.keyDown(field("Width"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith({ width: 1024 }, "Resize frame");
    fireEvent.blur(field("Width"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    fireEvent.change(field("X"), { target: { value: "-50" } });
    fireEvent.blur(field("X"));
    expect(onSubmit).toHaveBeenLastCalledWith({ x: -50 }, "Move frame");
    fireEvent.change(field("Name"), { target: { value: " Landing " } });
    fireEvent.blur(field("Name"));
    expect(onSubmit).toHaveBeenLastCalledWith({ name: "Landing" }, "Rename frame");
  });

  test("invalid values show an associated error and are not submitted", () => {
    render(
      <DesignFrameInspector
        frame={committed}
        committed={committed}
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    );
    fireEvent.change(field("Height"), { target: { value: "5000" } });
    fireEvent.keyDown(field("Height"), { key: "Enter" });
    fireEvent.blur(field("Height"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(field("Height").getAttribute("aria-invalid")).toBe("true");
    const error = document.getElementById(field("Height").getAttribute("aria-describedby")!);
    expect(error?.textContent).toBe("Use 32–4096 pixels");
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.keyDown(field("Height"), { key: "Escape" });
    expect(field("Height").value).toBe("600");
    expect(field("Height").getAttribute("aria-invalid")).toBeNull();
  });

  test("unchanged values are not submitted", () => {
    render(
      <DesignFrameInspector
        frame={committed}
        committed={committed}
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    );
    fireEvent.change(field("Width"), { target: { value: "800" } });
    fireEvent.blur(field("Width"));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("the Apply button submits every changed field as one edit", () => {
    render(
      <DesignFrameInspector
        frame={committed}
        committed={committed}
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    );
    fireEvent.change(field("Width"), { target: { value: "900" } });
    fireEvent.change(field("Y"), { target: { value: "5" } });
    fireEvent.submit(screen.getByRole("button", { name: "Apply" }).closest("form")!);
    expect(onSubmit).toHaveBeenCalledWith({ y: 5, width: 900 }, "Edit frame properties");
  });

  test("device presets submit both dimensions and show the active preset", () => {
    const view = render(
      <DesignFrameInspector
        frame={committed}
        committed={committed}
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mobile 390" }));
    expect(onSubmit).toHaveBeenCalledWith(
      { width: 390, height: 844 },
      "Resize frame to Mobile 390",
    );
    const projected = { ...committed, width: 390, height: 844 };
    view.rerender(
      <DesignFrameInspector
        frame={projected}
        committed={committed}
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole("button", { name: "Mobile 390" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("status").textContent).toBe("Saving frame changes…");
    expect(field("Width").value).toBe("390");
  });

  test("close calls onClose", () => {
    render(
      <DesignFrameInspector
        frame={committed}
        committed={committed}
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close frame properties" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
