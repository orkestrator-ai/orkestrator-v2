import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { AgentModelPicker } from "./AgentModelPicker";

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
  platform: "codex" as const,
  id: `model-${index + 1}`,
  label: `Model ${index + 1}`,
  description: `Model ${index + 1} description`,
}));

function renderPicker(overrides: Partial<Parameters<typeof AgentModelPicker>[0]> = {}) {
  const onModelChange = mock(() => {});
  const onReasoningChange = mock(() => {});
  const onFastModeChange = mock(() => {});
  const result = render(
    <AgentModelPicker
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

function openPicker(title = "Choose model, reasoning, and speed") {
  const trigger = screen.getByTitle(title);
  fireEvent.pointerDown(trigger);
  return trigger;
}

function getMobileTrigger(kind: "reasoning" | "speed") {
  return document.querySelector<HTMLElement>(`[data-native-mobile-${kind}-trigger]`)!;
}

describe("AgentModelPicker", () => {
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
    expect(picker?.className)
      .toContain("max-h-(--radix-dropdown-menu-content-available-height)");
    expect(document.querySelector("[data-native-model-list]")?.className).toContain("max-h-70");
    expect(screen.getByText("Scroll for 2 more models")).toBeTruthy();
    expect(document.querySelector("[data-native-mobile-reasoning-trigger]")).toBeTruthy();
    expect(document.querySelector("[data-native-mobile-speed-trigger]")?.textContent)
      .toContain("On");
    expect(getMobileTrigger("reasoning").getAttribute("aria-haspopup")).toBe("menu");
    expect(getMobileTrigger("reasoning").getAttribute("aria-expanded")).toBe("false");
    expect(getMobileTrigger("reasoning").getAttribute("aria-controls")).toBeTruthy();
    expect(document.querySelectorAll("[data-native-mobile-reasoning-trigger], [data-native-mobile-speed-trigger]"))
      .toHaveLength(2);
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
    const reasoning = document.querySelector<HTMLElement>(
      "[data-native-mobile-reasoning-trigger]",
    )!;
    fireEvent.click(reasoning);
    const low = await screen.findByRole("menuitemradio", { name: /Low/ });
    fireEvent.click(low);
    expect(onReasoningChange).toHaveBeenCalledWith("low");

    cleanup();
    const { onFastModeChange } = renderPicker();
    trigger = screen.getByTitle("Choose model, reasoning, and speed");
    fireEvent.pointerDown(trigger);
    const speed = document.querySelector<HTMLElement>("[data-native-mobile-speed-trigger]")!;
    fireEvent.click(speed);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Normal/ }));
    expect(onFastModeChange).toHaveBeenCalledWith(false);
  });

  test("switches providers on mobile, including agents without model catalogs", () => {
    setMobileViewport(true);
    const onPlatformChange = mock(() => {});
    renderPicker({
      models: [
        { platform: "codex", id: "codex-model", label: "Codex model" },
        { platform: "opencode", id: "opencode-model", label: "OpenCode model" },
      ],
      enabledPlatforms: ["codex", "opencode", "cursor"],
      selectedPlatform: "codex",
      selectedModelId: "codex-model",
      onPlatformChange,
    });

    openPicker();
    expect(screen.getByRole("group", { name: "Agent platforms" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "opencode models" }));
    expect(onPlatformChange).toHaveBeenLastCalledWith("opencode");
    expect(screen.getByRole("menuitemradio", { name: /OpenCode model/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "cursor models" }));
    expect(onPlatformChange).toHaveBeenLastCalledWith("cursor");
    expect(screen.getByText("No models available")).toBeTruthy();
  });

  test.each(["reasoning", "speed"] as const)(
    "returns from the mobile %s view with Back and restores focus",
    async (kind) => {
      setMobileViewport(true);
      renderPicker();
      openPicker();

      const sectionTrigger = getMobileTrigger(kind);
      fireEvent.click(sectionTrigger);
      const view = document.querySelector<HTMLElement>(`[data-native-mobile-${kind}-view]`)!;
      expect(view.getAttribute("role")).toBe("group");
      expect(sectionTrigger.getAttribute("aria-controls")).toBe(view.id);
      expect(screen.queryByPlaceholderText("Search models...")).toBeNull();

      const back = screen.getByRole("menuitem", { name: "Back to model choices" });
      await waitFor(() => expect(document.activeElement).toBe(back));
      fireEvent.click(back);

      await waitFor(() => expect(document.activeElement).toBe(getMobileTrigger(kind)));
      expect(screen.getByPlaceholderText("Search models...")).toBeTruthy();
      expect(getMobileTrigger("reasoning")).toBeTruthy();
      expect(getMobileTrigger("speed")).toBeTruthy();
      expect(document.querySelector("[data-native-mobile-back]")).toBeNull();
    },
  );

  test("supports directional keyboard navigation for mobile drill-in views", async () => {
    setMobileViewport(true);
    renderPicker();
    openPicker();

    const reasoning = getMobileTrigger("reasoning");
    reasoning.focus();
    fireEvent.keyDown(reasoning, { key: "ArrowRight" });
    const back = await screen.findByRole("menuitem", { name: "Back to model choices" });
    await waitFor(() => expect(document.activeElement).toBe(back));

    const selectedReasoning = screen.getByRole("menuitemradio", { name: /High/ });
    selectedReasoning.focus();
    fireEvent.keyDown(selectedReasoning, { key: "ArrowLeft" });
    await waitFor(() => expect(document.activeElement).toBe(getMobileTrigger("reasoning")));

    const speed = getMobileTrigger("speed");
    speed.focus();
    fireEvent.keyDown(speed, { key: "ArrowRight" });
    await waitFor(() => expect(document.activeElement)
      .toBe(screen.getByRole("menuitem", { name: "Back to model choices" })));
    fireEvent.keyDown(screen.getByRole("menuitemradio", { name: /Fast/ }), {
      key: "ArrowLeft",
    });
    await waitFor(() => expect(document.activeElement).toBe(getMobileTrigger("speed")));
  });

  test("opens mobile drill-in views with Enter and Space", async () => {
    setMobileViewport(true);
    renderPicker();
    openPicker();

    const reasoning = getMobileTrigger("reasoning");
    reasoning.focus();
    fireEvent.keyDown(reasoning, { key: "Enter" });
    await screen.findByRole("group", { name: "Reasoning choices" });

    fireEvent.click(screen.getByRole("menuitem", { name: "Back to model choices" }));
    const speed = getMobileTrigger("speed");
    speed.focus();
    fireEvent.keyDown(speed, { key: " " });
    await screen.findByRole("group", { name: "Speed choices" });
  });

  test("resets an active mobile drill-in and search after the menu closes", async () => {
    setMobileViewport(true);
    renderPicker();
    const trigger = openPicker();
    fireEvent.change(screen.getByPlaceholderText("Search models..."), {
      target: { value: "model 7" },
    });
    fireEvent.click(getMobileTrigger("reasoning"));
    const view = screen.getByRole("group", { name: "Reasoning choices" });
    fireEvent.keyDown(view, { key: "Escape" });
    await waitFor(() => expect(document.querySelector("[data-native-model-picker]")).toBeNull());

    fireEvent.pointerDown(trigger);
    expect((screen.getByPlaceholderText("Search models...") as HTMLInputElement).value).toBe("");
    expect(getMobileTrigger("reasoning")).toBeTruthy();
    expect(document.querySelector("[data-native-mobile-back]")).toBeNull();
  });

  test("uses three desktop columns and routes each selection", () => {
    setMobileViewport(false);
    const { onModelChange, onReasoningChange, onFastModeChange } = renderPicker({
      fastModeEnabled: false,
    });
    const trigger = screen.getByTitle("Choose model, reasoning, and speed");

    fireEvent.pointerDown(trigger);
    expect(document.querySelector("[data-native-model-picker] .grid")?.className)
      .toContain("grid-cols-[3rem_repeat(3,minmax(0,1fr))]");
    expect(document.querySelector("[data-native-model-picker]")?.className)
      .toContain("md:h-[23.5rem]");
    expect(screen.getByRole("group", { name: "Models" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Reasoning" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Speed mode" })).toBeTruthy();
    expect(document.querySelector("[data-native-model-list]")?.className)
      .toContain("overflow-y-auto");
    expect(document.querySelector("[data-native-reasoning-list]")?.className)
      .toContain("overflow-y-auto");
    expect(document.querySelector("[data-native-speed-list]")?.className)
      .toContain("overflow-y-auto");
    expect(screen.getByText("Scroll for 2 more models")).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: /Model 7/ })).toBeTruthy();
    fireEvent.click(screen.getByText("Model 2"));
    expect(onModelChange).toHaveBeenCalledWith("model-2");

    fireEvent.pointerDown(trigger);
    fireEvent.click(screen.getByText("Low"));
    expect(onReasoningChange).toHaveBeenCalledWith("low");

    fireEvent.pointerDown(trigger);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Fast/ }));
    expect(onFastModeChange).toHaveBeenCalledWith(true);
  });

  test("keeps long desktop reasoning ladders inside their own scroll region", () => {
    setMobileViewport(false);
    const reasoningOptions = Array.from({ length: 12 }, (_, index) => ({
      id: `effort-${index + 1}`,
      label: `Effort ${index + 1}`,
      description: `A detailed description for reasoning effort ${index + 1}`,
    }));
    renderPicker({
      reasoningOptions,
      selectedReasoningId: "effort-1",
      selectedReasoningLabel: "Effort 1",
    });
    openPicker();

    const reasoningGroup = screen.getByRole("group", { name: "Reasoning" });
    const reasoningList = document.querySelector<HTMLElement>("[data-native-reasoning-list]")!;
    expect(reasoningGroup.className).toContain("min-h-0");
    expect(reasoningGroup.className).toContain("flex-col");
    expect(reasoningList.className).toContain("min-h-0");
    expect(reasoningList.className).toContain("overflow-y-auto");
    expect(screen.getByRole("menuitemradio", { name: /Effort 12/ })).toBeTruthy();
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
    expect(document.querySelector("[data-native-model-picker] .grid")?.className)
      .toContain("grid-cols-[3rem_repeat(2,minmax(0,1fr))]");
  });

  test("omits speed controls when the integration cannot change speed", () => {
    setMobileViewport(false);
    renderPicker({ onFastModeChange: undefined });
    const trigger = screen.getByTitle("Choose model and reasoning");
    fireEvent.pointerDown(trigger);

    expect(document.querySelector("[data-native-model-picker] .grid")?.className)
      .toContain("grid-cols-[3rem_repeat(2,minmax(0,1fr))]");
    expect(screen.queryByRole("group", { name: "Speed mode" })).toBeNull();
    expect(screen.queryByText("Normal")).toBeNull();
    expect(screen.queryByText("Fast")).toBeNull();
  });

  test("filters searchable metadata with normalized queries, orders favorites, and refreshes", () => {
    setMobileViewport(false);
    const onRefreshModels = mock(() => {});
    renderPicker({
      models: [
        { platform: "codex", id: "plain", label: "Plain" },
        { platform: "codex", id: "fav", label: "Favorite model" },
        { platform: "codex", id: "provider/SPECIAL-ID", label: "By id" },
        { platform: "codex", id: "description", label: "By description", description: "Deep Reasoning" },
        { platform: "codex", id: "alias", label: "Hidden Alias" },
      ],
      favorites: [{ platform: "codex", modelId: "fav" }],
      selectedPlatform: "codex",
      selectedModelId: "plain",
      onRefreshModels,
    });
    fireEvent.pointerDown(screen.getByTitle("Choose model, reasoning, and speed"));

    fireEvent.click(screen.getByRole("button", { name: "Favorite models" }));
    const items = screen.getAllByRole("menuitemradio");
    expect(items[0]?.textContent).toContain("Favorite model");
    fireEvent.click(screen.getByRole("button", { name: "codex models" }));
    fireEvent.change(screen.getByPlaceholderText("Search models..."), {
      target: { value: "  special-id  " },
    });
    expect(screen.getByText("1 model found")).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: /By id/ })).toBeTruthy();
    expect(screen.queryByText("Plain")).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("Search models..."), {
      target: { value: "  dEeP rEaSoNiNg  " },
    });
    expect(screen.getByRole("menuitemradio", { name: /By description/ })).toBeTruthy();
    expect(screen.queryByText("By id")).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("Search models..."), {
      target: { value: " HIDDEN ALIAS " },
    });
    expect(screen.getByRole("menuitemradio", { name: /Hidden Alias/ })).toBeTruthy();
    expect(screen.queryByText("By description")).toBeNull();

    fireEvent.click(screen.getByTitle("Refresh models"));
    expect(onRefreshModels).toHaveBeenCalledTimes(1);
    expect(screen.getByPlaceholderText("Search models...")).toBeTruthy();
  });

  test("keeps identical provider model ids distinct in the cross-platform favorites view", () => {
    setMobileViewport(false);
    const onPlatformChange = mock(() => {});
    const { onModelChange } = renderPicker({
      models: [
        { platform: "codex", id: "shared", label: "Shared Codex" },
        { platform: "opencode", id: "shared", label: "Shared OpenCode" },
      ],
      enabledPlatforms: ["codex", "opencode"],
      favorites: [
        { platform: "codex", modelId: "shared" },
        { platform: "opencode", modelId: "shared" },
      ],
      selectedPlatform: "codex",
      selectedModelId: "shared",
      onPlatformChange,
    });

    fireEvent.pointerDown(screen.getByTitle("Choose model, reasoning, and speed"));
    fireEvent.click(screen.getByRole("button", { name: "Favorite models" }));
    const choices = screen.getAllByRole("menuitemradio", { name: /Shared/ });
    expect(choices).toHaveLength(2);
    expect(choices[0]?.getAttribute("aria-checked")).toBe("true");
    expect(choices[1]?.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(choices[1]!);
    expect(onPlatformChange).toHaveBeenCalledWith("opencode");
    expect(onModelChange).toHaveBeenCalledWith("shared");
  });

  test("keeps provider choices visible but disables non-selected providers after lock", () => {
    setMobileViewport(false);
    renderPicker({
      models: [
        { platform: "codex", id: "codex-model", label: "Codex model" },
        { platform: "opencode", id: "opencode-model", label: "OpenCode model" },
      ],
      enabledPlatforms: ["codex", "opencode"],
      selectedPlatform: "codex",
      selectedModelId: "codex-model",
      platformSelectionLocked: true,
    });

    openPicker();
    expect(screen.getByRole("button", { name: "codex models" }).hasAttribute("disabled"))
      .toBe(false);
    expect(screen.getByRole("button", { name: "opencode models" }).hasAttribute("disabled"))
      .toBe(true);
    expect(screen.getByRole("menuitemradio", { name: /Codex model/ })).toBeTruthy();
  });

  test("toggles a model favorite without selecting it and adds it to the favorites view", () => {
    setMobileViewport(false);
    const onModelChange = mock(() => {});

    function FavoritePicker() {
      const [favorites, setFavorites] = useState<Array<{ platform: "codex"; modelId: string }>>([]);
      return (
        <AgentModelPicker
          models={models}
          selectedPlatform="codex"
          selectedModelId="model-1"
          selectedModelLabel="Model 1"
          onModelChange={onModelChange}
          reasoningOptions={[]}
          favorites={favorites}
          onToggleFavorite={(model) => {
            setFavorites((current) => current.some((favorite) => favorite.modelId === model.id)
              ? current.filter((favorite) => favorite.modelId !== model.id)
              : [...current, { platform: "codex", modelId: model.id }]);
          }}
        />
      );
    }

    render(<FavoritePicker />);
    fireEvent.pointerDown(screen.getByTitle("Choose model"));
    const addFavorite = screen.getByRole("button", { name: "Add Model 2 to favorites" });
    expect(addFavorite.getAttribute("aria-pressed")).toBe("false");

    fireEvent.pointerDown(addFavorite);
    fireEvent.click(addFavorite);

    expect(onModelChange).not.toHaveBeenCalled();
    const removeFavorite = screen.getByRole("button", { name: "Remove Model 2 from favorites" });
    expect(removeFavorite.getAttribute("aria-pressed")).toBe("true");
    expect(removeFavorite.querySelector("svg")?.getAttribute("class")).toContain("fill-amber-400");

    fireEvent.click(screen.getByRole("button", { name: "Favorite models" }));
    expect(screen.getByRole("menuitemradio", { name: /Model 2/ })).toBeTruthy();
    expect(screen.queryByRole("menuitemradio", { name: /Model 1/ })).toBeNull();
  });

  test("does not render numeric shortcut hints for model rows", () => {
    setMobileViewport(false);
    renderPicker();
    openPicker();

    expect(document.querySelector("[data-native-model-list]")?.textContent).not.toContain("⌘");
  });

  test("uses singular overflow copy for exactly one hidden model", () => {
    setMobileViewport(true);
    renderPicker({ models: models.slice(0, 6) });
    openPicker();
    expect(screen.getByText("Scroll for 1 more model")).toBeTruthy();
    expect(screen.queryByText("Scroll for 1 more models")).toBeNull();
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

  test("uses the model-only generated title and honors a custom title", () => {
    setMobileViewport(false);
    renderPicker({
      reasoningOptions: [],
      selectedReasoningId: undefined,
      selectedReasoningLabel: undefined,
      onReasoningChange: undefined,
      onFastModeChange: undefined,
    });
    expect(screen.getByTitle("Choose model")).toBeTruthy();
    cleanup();

    renderPicker({ title: "Select runtime" });
    expect(screen.getByTitle("Select runtime")).toBeTruthy();
    expect(screen.queryByTitle("Choose model, reasoning, and speed")).toBeNull();
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

  test("shows only model names, providers, and reasoning names", () => {
    setMobileViewport(false);
    renderPicker({
      reasoningOptions: [
        { id: "low", label: "Low", annotation: "current", description: "Quick answers" },
        { id: "high", label: "High", annotation: "default", description: "Deep reasoning" },
      ],
    });
    fireEvent.pointerDown(screen.getByTitle("Choose model, reasoning, and speed"));
    expect(screen.getByText("Model 1")).toBeTruthy();
    expect(screen.getAllByText("Codex").length).toBeGreaterThan(0);
    expect(screen.queryByText("Model 1 description")).toBeNull();
    expect(screen.getByRole("menuitemradio", { name: "Low" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "High" })).toBeTruthy();
    expect(screen.queryByText("Low (current)")).toBeNull();
    expect(screen.queryByText("High (default)")).toBeNull();
    expect(screen.queryByText("Quick answers")).toBeNull();
    expect(screen.queryByText("Deep reasoning")).toBeNull();
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
    const speed = document.querySelector<HTMLElement>("[data-native-mobile-speed-trigger]")!;
    expect(speed.textContent).toContain("Unavailable");
    expect(speed.hasAttribute("data-disabled")).toBe(false);
    fireEvent.click(speed);
    expect(screen.getByRole("menuitemradio", { name: /Fast.*Not available/ })
      .hasAttribute("data-disabled")).toBe(true);
  });

  test.each([
    { enabled: null, summary: "Unknown", normalChecked: "false", fastChecked: "false" },
    { enabled: false, summary: "Off", normalChecked: "true", fastChecked: "false" },
  ] as const)(
    "shows the mobile $summary speed summary and radio state",
    ({ enabled, summary, normalChecked, fastChecked }) => {
      setMobileViewport(true);
      renderPicker({ fastModeEnabled: enabled, fastModeAvailable: true });
      openPicker();
      const speed = getMobileTrigger("speed");
      expect(speed.textContent).toContain(summary);
      fireEvent.click(speed);
      expect(screen.getByRole("menuitemradio", { name: /Normal/ }).getAttribute("aria-checked"))
        .toBe(normalChecked);
      expect(screen.getByRole("menuitemradio", { name: /Fast/ }).getAttribute("aria-checked"))
        .toBe(fastChecked);
    },
  );

  test("disables every open choice when settings become locked", () => {
    setMobileViewport(false);
    function LockablePicker() {
      const [locked, setLocked] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setLocked(true)}>Lock settings</button>
          <AgentModelPicker
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
