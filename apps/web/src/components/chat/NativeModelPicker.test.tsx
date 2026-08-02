import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NativeModelPicker } from "./NativeModelPicker";

function setMobileViewport(mobile: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query === "(max-width: 767px)" ? mobile : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    }),
  });
}

const models = Array.from({ length: 7 }, (_, index) => ({
  id: `model-${index + 1}`,
  label: `Model ${index + 1}`,
  description: `Model ${index + 1} description`,
}));

function renderPicker(overrides: Partial<Parameters<typeof NativeModelPicker>[0]> = {}) {
  const onModelChange = mock(() => {});
  const onReasoningChange = mock(() => {});
  const onFastModeChange = mock(() => {});
  const result = render(
    <NativeModelPicker
      models={models}
      selectedModelId="model-1"
      selectedModelLabel="A model name that can become very long"
      onModelChange={onModelChange}
      reasoningOptions={[
        { id: "low", label: "Low" },
        { id: "high", label: "High", description: "Deep reasoning" },
      ]}
      selectedReasoningId="high"
      selectedReasoningLabel="High"
      onReasoningChange={onReasoningChange}
      fastModeEnabled
      fastModeAvailable
      onFastModeChange={onFastModeChange}
      {...overrides}
    />,
  );
  return { ...result, onModelChange, onReasoningChange, onFastModeChange };
}

describe("NativeModelPicker", () => {
  afterEach(() => cleanup());

  test("keeps the mobile menu inset, truncates the trigger, and signals overflow", () => {
    setMobileViewport(true);
    const { container } = renderPicker();

    const trigger = screen.getByRole("button", {
      name: "A model name that can become very long (High ⚡)",
    });
    expect(trigger.querySelector(".truncate")).toBeTruthy();
    fireEvent.pointerDown(trigger);

    const picker = document.querySelector<HTMLElement>("[data-native-model-picker]");
    expect(picker?.className).toContain("w-[calc(100vw-1rem)]");
    expect(document.querySelector("[data-native-model-list]")?.className).toContain("max-h-70");
    expect(screen.getByText("Scroll for 2 more models")).toBeTruthy();
    expect(screen.getByText("Reasoning").closest("[data-slot=dropdown-menu-sub-trigger]")).toBeTruthy();
    expect(screen.getByRole("menuitemcheckbox", { name: /Fast/ }).getAttribute("aria-checked")).toBe("true");
    expect(container.querySelectorAll("button[title='Choose model, reasoning, and speed']")).toHaveLength(1);
  });

  test("uses three desktop columns and routes each selection", () => {
    setMobileViewport(false);
    const { onModelChange, onReasoningChange, onFastModeChange } = renderPicker({
      fastModeEnabled: false,
    });
    const trigger = screen.getByTitle("Choose model, reasoning, and speed");

    fireEvent.pointerDown(trigger);
    expect(document.querySelector("[data-native-model-picker] .grid-cols-3")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Models" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Reasoning" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Speed mode" })).toBeTruthy();
    fireEvent.click(screen.getByText("Model 2"));
    expect(onModelChange).toHaveBeenCalledWith("model-2");

    fireEvent.pointerDown(trigger);
    fireEvent.click(screen.getByText("Low"));
    expect(onReasoningChange).toHaveBeenCalledWith("low");

    fireEvent.pointerDown(trigger);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Fast/ }));
    expect(onFastModeChange).toHaveBeenCalledWith(true);
  });
});
