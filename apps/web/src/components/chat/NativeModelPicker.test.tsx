import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
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

  test("routes mobile model, reasoning, and speed selections", async () => {
    setMobileViewport(true);
    const { onModelChange } = renderPicker();
    let trigger = screen.getByTitle("Choose model, reasoning, and speed");

    fireEvent.pointerDown(trigger);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Model 2/ }));
    expect(onModelChange).toHaveBeenCalledWith("model-2");

    cleanup();
    const { onReasoningChange } = renderPicker();
    trigger = screen.getByTitle("Choose model, reasoning, and speed");
    fireEvent.pointerDown(trigger);
    const reasoning = screen.getByText("Reasoning").closest(
      "[data-slot=dropdown-menu-sub-trigger]",
    )!;
    (reasoning as HTMLElement).focus();
    fireEvent.keyDown(reasoning, { key: "ArrowRight" });
    const low = await screen.findByRole("menuitemradio", { name: /Low/ });
    fireEvent.click(low);
    expect(onReasoningChange).toHaveBeenCalledWith("low");

    cleanup();
    const { onFastModeChange } = renderPicker();
    trigger = screen.getByTitle("Choose model, reasoning, and speed");
    fireEvent.pointerDown(trigger);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /^Fast/ }));
    expect(onFastModeChange).toHaveBeenCalledWith(false);
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
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Fast/ }));
    expect(onFastModeChange).toHaveBeenCalledWith(true);
  });

  test("uses radio semantics for the selected desktop choices", () => {
    setMobileViewport(false);
    renderPicker();
    fireEvent.pointerDown(screen.getByTitle("Choose model, reasoning, and speed"));

    expect(screen.getByRole("menuitemradio", { name: /Model 1/ }).getAttribute("aria-checked"))
      .toBe("true");
    expect(screen.getByRole("menuitemradio", { name: /High/ }).getAttribute("aria-checked"))
      .toBe("true");
    expect(screen.getByRole("menuitemradio", { name: /Fast/ }).getAttribute("aria-checked"))
      .toBe("true");
    expect(screen.getByRole("menuitemradio", { name: /Normal/ }).getAttribute("aria-checked"))
      .toBe("false");
  });

  test("disables unavailable reasoning choices and omits an empty ladder", () => {
    setMobileViewport(false);
    renderPicker({ onReasoningChange: undefined });
    fireEvent.pointerDown(screen.getByTitle("Choose model, reasoning, and speed"));
    expect(screen.getByRole("menuitemradio", { name: /High/ }).hasAttribute("data-disabled"))
      .toBe(true);
    cleanup();

    renderPicker({ reasoningOptions: [], selectedReasoningId: undefined });
    fireEvent.pointerDown(screen.getByTitle("Choose model and speed"));
    expect(screen.queryByRole("group", { name: "Reasoning" })).toBeNull();
    expect(screen.queryByText("No reasoning options")).toBeNull();
    expect(document.querySelector("[data-native-model-picker] .grid-cols-2")).toBeTruthy();
  });

  test("omits speed controls when the integration cannot change speed", () => {
    setMobileViewport(false);
    renderPicker({ onFastModeChange: undefined });
    const trigger = screen.getByTitle("Choose model and reasoning");
    fireEvent.pointerDown(trigger);

    expect(document.querySelector("[data-native-model-picker] .grid-cols-2")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Speed mode" })).toBeNull();
    expect(screen.queryByText("Normal")).toBeNull();
    expect(screen.queryByText("Fast")).toBeNull();
  });

  test("filters searchable metadata, orders favorites first, and refreshes in place", () => {
    setMobileViewport(false);
    const onRefreshModels = mock(() => {});
    renderPicker({
      models: [
        { id: "plain", label: "Plain" },
        { id: "fav", label: "Favorite model", favorite: true },
        { id: "alias", label: "Other", searchText: "hidden alias" },
      ],
      selectedModelId: "plain",
      onRefreshModels,
    });
    fireEvent.pointerDown(screen.getByTitle("Choose model, reasoning, and speed"));

    const items = screen.getAllByRole("menuitemradio");
    expect(items[0]?.textContent).toContain("Favorite model");
    fireEvent.change(screen.getByPlaceholderText("Search models..."), {
      target: { value: "hidden" },
    });
    expect(screen.getByText("1 model found")).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: /Other/ })).toBeTruthy();
    expect(screen.queryByText("Plain")).toBeNull();

    fireEvent.click(screen.getByTitle("Refresh models"));
    expect(onRefreshModels).toHaveBeenCalledTimes(1);
    expect(screen.getByPlaceholderText("Search models...")).toBeTruthy();
  });

  test("shows empty and unmatched states without offering phantom choices", () => {
    setMobileViewport(false);
    renderPicker({ models: [] });
    fireEvent.pointerDown(screen.getByTitle("Choose model, reasoning, and speed"));
    expect(screen.getByText("No models available")).toBeTruthy();
    cleanup();

    renderPicker();
    fireEvent.pointerDown(screen.getByTitle("Choose model, reasoning, and speed"));
    fireEvent.change(screen.getByPlaceholderText("Search models..."), {
      target: { value: "not-a-model" },
    });
    expect(screen.getByText("No matches")).toBeTruthy();
    expect(screen.getByText("0 models found")).toBeTruthy();
  });

  test("represents an unknown fast-mode snapshot without selecting either speed", () => {
    setMobileViewport(false);
    renderPicker({ fastModeEnabled: null });
    const trigger = screen.getByRole("button", {
      name: /speed unknown/,
    });
    expect(trigger.textContent).toContain("? speed");
    fireEvent.pointerDown(trigger);
    expect(screen.getByRole("menuitemradio", { name: /Normal/ }).getAttribute("aria-checked"))
      .toBe("false");
    expect(screen.getByRole("menuitemradio", { name: /Fast/ }).getAttribute("aria-checked"))
      .toBe("false");
  });

  test("renders the fast-only trigger branch when there is no reasoning label", () => {
    setMobileViewport(false);
    renderPicker({
      selectedReasoningId: undefined,
      selectedReasoningLabel: undefined,
      reasoningOptions: [],
      fastModeEnabled: true,
    });
    const trigger = screen.getByRole("button", {
      name: "A model name that can become very long (⚡)",
    });
    expect(trigger.textContent).toContain("(⚡)");
  });

  test("disables the trigger and unavailable fast selection", () => {
    setMobileViewport(false);
    renderPicker({ disabled: true });
    expect(screen.getByTitle("Choose model, reasoning, and speed").hasAttribute("disabled"))
      .toBe(true);
    cleanup();

    renderPicker({ fastModeAvailable: false, fastModeEnabled: false });
    fireEvent.pointerDown(screen.getByTitle("Choose model, reasoning, and speed"));
    expect(screen.getByRole("menuitemradio", { name: /Fast/ }).hasAttribute("data-disabled"))
      .toBe(true);
    expect(screen.getByRole("menuitemradio", { name: /Normal/ }).hasAttribute("data-disabled"))
      .toBe(true);
  });

  test("renders reasoning annotations", () => {
    setMobileViewport(false);
    renderPicker({
      reasoningOptions: [
        { id: "low", label: "Low", annotation: "current" },
        { id: "high", label: "High", annotation: "default" },
      ],
    });
    fireEvent.pointerDown(screen.getByTitle("Choose model, reasoning, and speed"));
    expect(screen.getByText("Low (current)")).toBeTruthy();
    expect(screen.getByText("High (default)")).toBeTruthy();
  });

  test("keeps search keystrokes in the input and clears the query after close", () => {
    setMobileViewport(false);
    renderPicker();
    const trigger = screen.getByTitle("Choose model, reasoning, and speed");
    fireEvent.pointerDown(trigger);
    const search = screen.getByPlaceholderText("Search models...");
    fireEvent.change(search, { target: { value: "model 7" } });
    fireEvent.keyDown(search, { key: "m" });
    expect(screen.getByText("1 model found")).toBeTruthy();

    fireEvent.keyDown(search, { key: "Escape" });
    fireEvent.pointerDown(trigger);
    expect((screen.getByPlaceholderText("Search models...") as HTMLInputElement).value).toBe("");
  });

  test("covers mobile empty, unknown, and unavailable states", () => {
    setMobileViewport(true);
    renderPicker({
      models: [],
      reasoningOptions: [],
      selectedReasoningId: undefined,
      selectedReasoningLabel: undefined,
      fastModeEnabled: null,
      fastModeAvailable: false,
    });
    const trigger = screen.getByTitle("Choose model and speed");
    fireEvent.pointerDown(trigger);
    expect(screen.getByText("No models available")).toBeTruthy();
    expect(screen.queryByText("Reasoning")).toBeNull();
    const fast = screen.getByRole("menuitemcheckbox", { name: /Fast.*Unavailable/ });
    expect(fast.hasAttribute("data-disabled")).toBe(true);
    expect(fast.getAttribute("aria-checked")).toBe("false");
  });

  test("disables every open choice when settings become locked", () => {
    setMobileViewport(false);
    function LockablePicker() {
      const [locked, setLocked] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setLocked(true)}>Lock settings</button>
          <NativeModelPicker
            models={models}
            selectedModelId="model-1"
            selectedModelLabel="Model 1"
            onModelChange={() => {}}
            reasoningOptions={[{ id: "high", label: "High" }]}
            selectedReasoningId="high"
            selectedReasoningLabel="High"
            onReasoningChange={() => {}}
            fastModeEnabled={false}
            fastModeAvailable
            onFastModeChange={() => {}}
            disabled={locked}
          />
        </>
      );
    }
    render(<LockablePicker />);
    fireEvent.pointerDown(screen.getByTitle("Choose model, reasoning, and speed"));
    fireEvent.click(screen.getByText("Lock settings"));

    expect(screen.getByRole("menuitemradio", { name: /Model 2/ }).hasAttribute("data-disabled"))
      .toBe(true);
    expect(screen.getByRole("menuitemradio", { name: /High/ }).hasAttribute("data-disabled"))
      .toBe(true);
    expect(screen.getByRole("menuitemradio", { name: /Normal/ }).hasAttribute("data-disabled"))
      .toBe(true);
    expect(screen.getByRole("menuitemradio", { name: /Fast/ }).hasAttribute("data-disabled"))
      .toBe(true);
  });
});
