import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { AgentModelPicker } from "./AgentModelPicker";
import { PLATFORM_ICON_CLASS } from "@/components/icons/AgentIcons";

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

function showPlatformCatalog(platform: string) {
  fireEvent.click(screen.getByRole("button", { name: `${platform} models` }));
}

function getTriggerPlatformIcon(platform: string) {
  return screen
    .getByTitle("Choose model, reasoning, and speed")
    .querySelector(`[data-native-model-platform='${platform}']`);
}

function getModelRowPlatformIcon(platform: string, root: ParentNode = document) {
  return root.querySelector(`[data-native-model-row-platform='${platform}']`);
}

function getReorderHint() {
  return document.querySelector("[data-native-favorite-reorder-hint]");
}

function getMobileTrigger(kind: "reasoning" | "speed") {
  return document.querySelector<HTMLElement>(`[data-native-mobile-${kind}-trigger]`)!;
}

function setSortableRect(element: Element, top: number) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      bottom: top + 56,
      height: 56,
      left: 0,
      right: 320,
      top,
      width: 320,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }),
  });
}

async function dragFavoriteRow(activeKey: string, overKey: string) {
  const active = document.querySelector(`[data-favorite-sortable="${activeKey}"]`)!;
  const over = document.querySelector(`[data-favorite-sortable="${overKey}"]`)!;
  setSortableRect(active, 0);
  setSortableRect(over, 100);
  fireEvent.pointerDown(active, {
    button: 0,
    clientX: 16,
    clientY: 16,
    isPrimary: true,
    pointerId: 1,
  });
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.pointerMove(over, {
    clientX: 16,
    clientY: 40,
    isPrimary: true,
    pointerId: 1,
  });
  fireEvent.pointerMove(over, {
    clientX: 16,
    clientY: 130,
    isPrimary: true,
    pointerId: 1,
  });
  fireEvent.pointerUp(over, {
    clientX: 16,
    clientY: 130,
    isPrimary: true,
    pointerId: 1,
  });
}

describe("AgentModelPicker", () => {
  afterEach(() => cleanup());

  test("follows a platform restored after the picker first renders", () => {
    setMobileViewport(false);
    function HydratingPicker() {
      const [platform, setPlatform] = useState<"claude" | "codex">("claude");
      return (
        <>
          <button type="button" onClick={() => setPlatform("codex")}>Hydrate Codex</button>
          <AgentModelPicker
            models={[
              { platform: "claude", id: "claude-model", label: "Claude model" },
              { platform: "codex", id: "codex-model", label: "Codex model" },
            ]}
            enabledPlatforms={["claude", "codex"]}
            selectedPlatform={platform}
            selectedModelId={`${platform}-model`}
            selectedModelLabel={`${platform} model`}
            onModelChange={() => {}}
            reasoningOptions={[]}
          />
        </>
      );
    }
    render(<HydratingPicker />);

    fireEvent.click(screen.getByRole("button", { name: "Hydrate Codex" }));
    fireEvent.pointerDown(screen.getByTitle("Choose model"));

    expect(screen.getByRole("button", { name: "codex models" }).getAttribute("aria-pressed"))
      .toBe("true");
    expect(screen.getByRole("menuitemradio", { name: /Codex model/ })).toBeTruthy();
  });

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
    showPlatformCatalog("codex");
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

  test("shows the selected platform icon before the model name", () => {
    setMobileViewport(false);
    renderPicker({ selectedPlatform: "codex" });

    const trigger = screen.getByTitle("Choose model, reasoning, and speed");
    const icon = getTriggerPlatformIcon("codex");
    const label = [...trigger.querySelectorAll("span")].find((node) =>
      node.textContent?.startsWith("A model name that can become very long"),
    );
    expect(icon).toBeTruthy();
    expect(icon?.querySelector("svg")).toBeTruthy();
    expect(label).toBeTruthy();
    expect(
      Boolean(icon && label && (icon.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING)),
    ).toBe(true);
  });

  test.each([
    ["claude", "text-orange-400"],
    ["codex", "text-emerald-400"],
    ["opencode", "text-green-500"],
    ["cursor", "text-violet-400"],
    ["grok", "text-sky-400"],
  ] as const)("renders the %s platform icon in its accent colour", (platform, accentClass) => {
    setMobileViewport(false);
    renderPicker({
      models: [{ platform, id: "model-1", label: "Model 1" }],
      selectedPlatform: platform,
      selectedModelId: "model-1",
      selectedModelLabel: "Model 1",
    });

    // The shared accent map is what makes each provider distinguishable at a
    // glance, so assert the colour and not merely that an icon rendered.
    const icon = getTriggerPlatformIcon(platform);
    expect(icon).toBeTruthy();
    expect(icon?.querySelector("svg")?.getAttribute("class")).toContain(accentClass);
  });

  test("uses the exported accent map rather than a private copy of it", () => {
    // Guards against the map drifting back out of AgentIcons into this file.
    expect(PLATFORM_ICON_CLASS).toEqual({
      claude: "text-orange-400",
      codex: "text-emerald-400",
      opencode: "text-green-500",
      cursor: "text-violet-400",
      grok: "text-sky-400",
    });
  });

  test("infers the trigger platform from the selected model when it is not passed", () => {
    setMobileViewport(false);
    renderPicker({
      models: [
        { platform: "codex", id: "gpt", label: "GPT" },
        { platform: "claude", id: "opus", label: "Opus" },
      ],
      selectedPlatform: undefined,
      selectedModelId: "opus",
      selectedModelLabel: "Opus",
    });

    // The selected model wins over the first catalog entry.
    expect(getTriggerPlatformIcon("claude")).toBeTruthy();
    expect(getTriggerPlatformIcon("codex") === null).toBe(true);
  });

  test("prefers the explicit platform over the selected model's platform", () => {
    setMobileViewport(false);
    renderPicker({
      models: [{ platform: "codex", id: "gpt", label: "GPT" }],
      selectedPlatform: "claude",
      selectedModelId: "gpt",
      selectedModelLabel: "GPT",
    });

    expect(getTriggerPlatformIcon("claude")).toBeTruthy();
    expect(getTriggerPlatformIcon("codex") === null).toBe(true);
  });

  test("falls back to the first catalog model when the selection matches nothing", () => {
    setMobileViewport(false);
    renderPicker({
      models: [
        { platform: "grok", id: "grok-1", label: "Grok 1" },
        { platform: "claude", id: "opus", label: "Opus" },
      ],
      selectedPlatform: undefined,
      selectedModelId: "not-in-catalog",
      selectedModelLabel: "Unknown model",
    });

    expect(getTriggerPlatformIcon("grok")).toBeTruthy();
  });

  test("renders no trigger icon when there is no platform to show", () => {
    setMobileViewport(false);
    renderPicker({
      models: [],
      selectedPlatform: undefined,
      selectedModelId: undefined,
      selectedModelLabel: "Loading models",
    });

    const trigger = screen.getByTitle("Choose model, reasoning, and speed");
    expect(trigger.querySelector("[data-native-model-platform]") === null).toBe(true);
    expect(trigger.textContent).toContain("Loading models");
  });

  test("keeps the trigger icon out of the accessibility tree", () => {
    setMobileViewport(false);
    renderPicker({ selectedPlatform: "codex" });

    // The icon is decorative; the accessible name already names the model.
    expect(getTriggerPlatformIcon("codex")?.getAttribute("aria-hidden")).toBe("true");
    expect(
      screen.getByRole("button", { name: "A model name that can become very long (High ⚡)" }),
    ).toBeTruthy();
  });

  test("shows each favorite row's own platform icon before its provider label", () => {
    setMobileViewport(false);
    renderPicker({
      models: [
        { platform: "codex", id: "gpt", label: "GPT" },
        { platform: "claude", id: "opus", label: "Opus" },
      ],
      enabledPlatforms: ["claude", "codex"],
      selectedPlatform: "codex",
      selectedModelId: "gpt",
      selectedModelLabel: "GPT",
      favorites: [
        { platform: "codex", modelId: "gpt" },
        { platform: "claude", modelId: "opus" },
      ],
    });
    openPicker();

    const gpt = screen.getByRole("menuitemradio", { name: /GPT/ });
    const opus = screen.getByRole("menuitemradio", { name: /Opus/ });
    const gptIcon = getModelRowPlatformIcon("codex", gpt);
    const opusIcon = getModelRowPlatformIcon("claude", opus);

    expect(gptIcon?.querySelector("svg")).toBeTruthy();
    expect(opusIcon?.querySelector("svg")).toBeTruthy();
    expect(getModelRowPlatformIcon("claude", gpt) === null).toBe(true);
    expect(getModelRowPlatformIcon("codex", opus) === null).toBe(true);
    expect(gptIcon?.nextElementSibling?.textContent).toBe("Codex");
    expect(opusIcon?.nextElementSibling?.textContent).toBe("Claude");
  });

  test("pairs the platform icon with a distinct provider label", () => {
    setMobileViewport(false);
    renderPicker({
      models: [{
        platform: "opencode",
        id: "sonnet",
        label: "Sonnet",
        providerLabel: "Anthropic",
      }],
      enabledPlatforms: ["opencode"],
      selectedPlatform: "opencode",
      selectedModelId: "sonnet",
      selectedModelLabel: "Sonnet",
    });
    openPicker();
    showPlatformCatalog("opencode");

    const row = screen.getByRole("menuitemradio", { name: /Sonnet/ });
    expect(getModelRowPlatformIcon("opencode", row)?.querySelector("svg")).toBeTruthy();
    expect(row.textContent).toContain("Anthropic");
    expect(row.textContent?.includes("OpenCode")).toBe(false);
  });

  test.each([
    ["claude", "text-orange-400"],
    ["codex", "text-emerald-400"],
    ["opencode", "text-green-500"],
    ["cursor", "text-violet-400"],
    ["grok", "text-sky-400"],
  ] as const)("renders the %s model-row platform icon in its accent colour", (platform, accentClass) => {
    setMobileViewport(false);
    renderPicker({
      models: [{ platform, id: "model-1", label: "Model 1" }],
      selectedPlatform: platform,
      selectedModelId: "model-1",
      selectedModelLabel: "Model 1",
    });
    openPicker();
    showPlatformCatalog(platform);

    const icon = getModelRowPlatformIcon(platform);
    expect(icon).toBeTruthy();
    expect(icon?.querySelector("svg")?.getAttribute("class")).toContain(accentClass);
  });

  test("keeps the model-row platform icon out of the accessibility tree", () => {
    setMobileViewport(false);
    renderPicker({ selectedPlatform: "codex" });
    openPicker();
    showPlatformCatalog("codex");

    const row = screen.getByRole("menuitemradio", { name: /Model 1/ });
    expect(getModelRowPlatformIcon("codex", row)?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: /Model 1/ })).toBeTruthy();
  });

  test("routes mobile model, reasoning, and speed selections", async () => {
    setMobileViewport(true);
    const { onModelChange } = renderPicker();
    let trigger = screen.getByTitle("Choose model, reasoning, and speed");

    fireEvent.pointerDown(trigger);
    showPlatformCatalog("codex");
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
      expect(screen.queryByPlaceholderText("Search models...") === null).toBe(true);

      const back = screen.getByRole("menuitem", { name: "Back to model choices" });
      await waitFor(() => expect(document.activeElement).toBe(back));
      fireEvent.click(back);

      await waitFor(() => expect(document.activeElement).toBe(getMobileTrigger(kind)));
      expect(screen.getByPlaceholderText("Search models...")).toBeTruthy();
      expect(getMobileTrigger("reasoning")).toBeTruthy();
      expect(getMobileTrigger("speed")).toBeTruthy();
      expect(document.querySelector("[data-native-mobile-back]") === null).toBe(true);
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
    await waitFor(() => expect(document.querySelector("[data-native-model-picker]") === null).toBe(true));

    fireEvent.pointerDown(trigger);
    expect((screen.getByPlaceholderText("Search models...") as HTMLInputElement).value).toBe("");
    expect(getMobileTrigger("reasoning")).toBeTruthy();
    expect(document.querySelector("[data-native-mobile-back]") === null).toBe(true);
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
    showPlatformCatalog("codex");
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

  test("walks the desktop platform rail with Left and Right", () => {
    setMobileViewport(false);
    const onPlatformChange = mock(() => {});
    renderPicker({
      models: [
        { platform: "claude", id: "claude-model", label: "Claude model" },
        { platform: "codex", id: "codex-model", label: "Codex model" },
      ],
      enabledPlatforms: ["claude", "codex"],
      selectedPlatform: "claude",
      selectedModelId: "claude-model",
      favorites: [{ platform: "codex", modelId: "codex-model" }],
      onPlatformChange,
    });

    openPicker();
    expect(screen.getByRole("button", { name: "Favorite models" }).getAttribute("aria-pressed"))
      .toBe("true");
    const rail = screen.getByRole("group", { name: "Agent platforms" });
    const railButtons = [...rail.querySelectorAll("button")];
    expect(railButtons[0]?.getAttribute("aria-label")).toBe("Favorite models");
    // A Radix menu calls preventDefault on Tab, so the rail's buttons are
    // unreachable by keyboard without these keys.
    const list = document.querySelector("[data-native-model-list]")!;
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(onPlatformChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "claude models" }).getAttribute("aria-pressed"))
      .toBe("true");
    expect(screen.getByRole("menuitemradio", { name: /Claude model/ })).toBeTruthy();

    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(onPlatformChange).toHaveBeenCalledTimes(1);
    expect(onPlatformChange).toHaveBeenLastCalledWith("codex");
    expect(screen.getByRole("button", { name: "codex models" }).getAttribute("aria-pressed"))
      .toBe("true");
    expect(screen.getByRole("menuitemradio", { name: /Codex model/ })).toBeTruthy();

    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(screen.getByRole("button", { name: "claude models" }).getAttribute("aria-pressed"))
      .toBe("true");
    // selectedPlatform is still Claude: returning to it is a view change.
    expect(onPlatformChange).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(screen.getByRole("button", { name: "Favorite models" }).getAttribute("aria-pressed"))
      .toBe("true");
    expect(onPlatformChange).toHaveBeenCalledTimes(1);

    // And the ends wrap onto a different provider.
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(onPlatformChange).toHaveBeenCalledTimes(2);
    expect(onPlatformChange).toHaveBeenLastCalledWith("codex");
  });

  test("does not re-notify the selected platform after a favourites glance", () => {
    setMobileViewport(false);
    const onPlatformChange = mock(() => {});
    renderPicker({
      models: [
        { platform: "claude", id: "claude-model", label: "Claude model" },
        { platform: "codex", id: "codex-model", label: "Codex model" },
      ],
      enabledPlatforms: ["claude", "codex"],
      selectedPlatform: "claude",
      selectedModelId: "claude-model",
      favorites: [{ platform: "codex", modelId: "codex-model" }],
      onPlatformChange,
    });

    openPicker();
    const list = document.querySelector("[data-native-model-list]")!;
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: "claude models" }).getAttribute("aria-pressed"))
      .toBe("true");
    expect(onPlatformChange).not.toHaveBeenCalled();

    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(screen.getByRole("button", { name: "Favorite models" }).getAttribute("aria-pressed"))
      .toBe("true");
    expect(screen.queryByRole("menuitemradio", { name: /Claude model/ }) === null).toBe(true);
    expect(onPlatformChange).not.toHaveBeenCalled();
  });

  test("leaves the desktop rail alone when platform selection is locked", () => {
    setMobileViewport(false);
    const onPlatformChange = mock(() => {});
    renderPicker({
      models: [
        { platform: "claude", id: "claude-model", label: "Claude model" },
        { platform: "codex", id: "codex-model", label: "Codex model" },
      ],
      enabledPlatforms: ["claude", "codex"],
      selectedPlatform: "claude",
      selectedModelId: "claude-model",
      platformSelectionLocked: true,
      favorites: [{ platform: "codex", modelId: "codex-model" }],
      onPlatformChange,
    });

    openPicker();
    fireEvent.keyDown(document.querySelector("[data-native-model-list]")!, { key: "ArrowRight" });
    expect(onPlatformChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Favorite models" }).getAttribute("aria-pressed"))
      .toBe("true");
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
    showPlatformCatalog("codex");

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
    expect(screen.queryByRole("group", { name: "Reasoning" }) === null).toBe(true);
    expect(screen.queryByText("No reasoning options") === null).toBe(true);
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
    expect(screen.queryByRole("group", { name: "Speed mode" }) === null).toBe(true);
    expect(screen.queryByText("Normal") === null).toBe(true);
    expect(screen.queryByText("Fast") === null).toBe(true);
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
    expect(screen.queryByText("Plain") === null).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("Search models..."), {
      target: { value: "  dEeP rEaSoNiNg  " },
    });
    expect(screen.getByRole("menuitemradio", { name: /By description/ })).toBeTruthy();
    expect(screen.queryByText("By id") === null).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("Search models..."), {
      target: { value: " HIDDEN ALIAS " },
    });
    expect(screen.getByRole("menuitemradio", { name: /Hidden Alias/ })).toBeTruthy();
    expect(screen.queryByText("By description") === null).toBe(true);

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

  test("uses an atomic model selection callback for cross-platform choices", () => {
    setMobileViewport(false);
    const onPlatformChange = mock(() => {});
    const onModelSelect = mock(() => {});
    const { onModelChange } = renderPicker({
      models: [
        { platform: "codex", id: "codex-model", label: "Codex model" },
        { platform: "opencode", id: "opencode-model", label: "OpenCode model" },
      ],
      enabledPlatforms: ["codex", "opencode"],
      favorites: [{ platform: "opencode", modelId: "opencode-model" }],
      selectedPlatform: "codex",
      selectedModelId: "codex-model",
      onPlatformChange,
      onModelSelect,
    });

    fireEvent.pointerDown(screen.getByTitle("Choose model, reasoning, and speed"));
    fireEvent.click(screen.getByRole("button", { name: "Favorite models" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /OpenCode model/ }));

    expect(onModelSelect).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "opencode", id: "opencode-model" }),
    );
    expect(onPlatformChange).not.toHaveBeenCalled();
    expect(onModelChange).not.toHaveBeenCalled();
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
    showPlatformCatalog("codex");
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
    showPlatformCatalog("codex");
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
    expect(screen.queryByRole("menuitemradio", { name: /Model 1/ }) === null).toBe(true);
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
    showPlatformCatalog("codex");
    expect(screen.getByText("Scroll for 1 more model")).toBeTruthy();
    expect(screen.queryByText("Scroll for 1 more models") === null).toBe(true);
  });

  test("shows empty and unmatched states without offering phantom choices", () => {
    setMobileViewport(false);
    renderPicker({ models: [] });
    fireEvent.pointerDown(screen.getByTitle("Choose model, reasoning, and speed"));
    expect(screen.getByText("No favorite models")).toBeTruthy();
    cleanup();

    renderPicker();
    fireEvent.pointerDown(screen.getByTitle("Choose model, reasoning, and speed"));
    showPlatformCatalog("codex");
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

  test("does not paint speed onto the trigger when the platform has no speed surface", () => {
    setMobileViewport(false);
    renderPicker({
      fastModeEnabled: null,
      fastModeAvailable: false,
      speedCapable: false,
      onFastModeChange: undefined,
      selectedReasoningLabel: "Default",
    });
    const trigger = screen.getByRole("button", {
      name: "A model name that can become very long (Default)",
    });
    expect(trigger.textContent).toContain("Default");
    expect(trigger.textContent).not.toContain("speed");
    expect(trigger.textContent).not.toContain("?");
    expect(trigger.getAttribute("title")).toBe("Choose model and reasoning");
  });

  test("still reports unknown speed on a speed-capable platform with no callback yet", () => {
    // Claude and Codex own speed but pass through a window where the composer
    // snapshot has not arrived: `fastModeAvailable` is false, so there is no
    // callback, and `fastModeEnabled` is null. That is the case the hint exists
    // for, and gating it on the callback rather than the platform would hide it.
    setMobileViewport(false);
    renderPicker({
      fastModeEnabled: null,
      fastModeAvailable: false,
      speedCapable: true,
      onFastModeChange: undefined,
      selectedReasoningLabel: "Default",
    });
    const trigger = screen.getByRole("button", { name: /speed unknown/ });
    expect(trigger.textContent).toContain("? speed");
  });

  test("treats a speed-capable platform as the default when the prop is omitted", () => {
    // The prop defaults to true so an existing caller keeps the hint; only a
    // platform that explicitly has no speed surface opts out.
    setMobileViewport(false);
    renderPicker({
      fastModeEnabled: null,
      fastModeAvailable: false,
      onFastModeChange: undefined,
      selectedReasoningLabel: "Default",
    });
    expect(screen.getByRole("button", { name: /speed unknown/ })).toBeTruthy();
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
    expect(screen.queryByTitle("Choose model, reasoning, and speed") === null).toBe(true);
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
    showPlatformCatalog("codex");
    expect(screen.getByText("Model 1")).toBeTruthy();
    expect(screen.getAllByText("Codex").length).toBeGreaterThan(0);
    expect(screen.queryByText("Model 1 description") === null).toBe(true);
    expect(screen.getByRole("menuitemradio", { name: "Low" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "High" })).toBeTruthy();
    expect(screen.queryByText("Low (current)") === null).toBe(true);
    expect(screen.queryByText("High (default)") === null).toBe(true);
    expect(screen.queryByText("Quick answers") === null).toBe(true);
    expect(screen.queryByText("Deep reasoning") === null).toBe(true);
  });

  test("keeps search keystrokes in the input and clears the query after close", () => {
    setMobileViewport(false);
    renderPicker();
    const trigger = screen.getByTitle("Choose model, reasoning, and speed");
    fireEvent.pointerDown(trigger);
    showPlatformCatalog("codex");
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
    expect(screen.getByText("No favorite models")).toBeTruthy();
    expect(screen.queryByText("Reasoning") === null).toBe(true);
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
    showPlatformCatalog("codex");
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

  test("opens on favorites first and marks favourite rows as reorderable", () => {
    setMobileViewport(false);
    const onReorderFavorites = mock(() => {});
    renderPicker({
      models: [
        { platform: "codex", id: "model-1", label: "Model 1" },
        { platform: "codex", id: "model-2", label: "Model 2" },
        { platform: "claude", id: "opus", label: "Opus" },
      ],
      enabledPlatforms: ["claude", "codex"],
      selectedPlatform: "claude",
      selectedModelId: "opus",
      favorites: [
        { platform: "codex", modelId: "model-2" },
        { platform: "codex", modelId: "model-1" },
      ],
      onReorderFavorites,
    });
    openPicker();

    const rail = screen.getByRole("group", { name: "Agent platforms" });
    expect(rail.querySelector("button")?.getAttribute("aria-label")).toBe("Favorite models");
    expect(screen.getByRole("button", { name: "Favorite models" }).getAttribute("aria-pressed"))
      .toBe("true");
    expect(document.querySelector("[data-native-model-list]")?.getAttribute("data-favorite-reorder"))
      .toBe("drag");
    expect(document.querySelector('[data-favorite-sortable="codex:model-2"]')).toBeTruthy();
    expect(document.querySelector('[data-favorite-sortable="codex:model-1"]')).toBeTruthy();
    const favoriteRadios = screen.getAllByRole("menuitemradio").filter((item) =>
      /Model [12]/.test(item.textContent ?? ""),
    );
    expect(favoriteRadios[0]?.textContent).toContain("Model 2");
    expect(favoriteRadios[1]?.textContent).toContain("Model 1");

    fireEvent.change(screen.getByPlaceholderText("Search models..."), {
      target: { value: "model 1" },
    });
    const filteredModelList = document.querySelector("[data-native-model-list]");
    expect(filteredModelList).toBeTruthy();
    expect(filteredModelList!.getAttribute("data-favorite-reorder") === null).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("Search models..."), {
      target: { value: "" },
    });

    showPlatformCatalog("claude");
    expect(document.querySelector("[data-favorite-sortable]") === null).toBe(true);
    const catalogModelList = document.querySelector("[data-native-model-list]");
    expect(catalogModelList).toBeTruthy();
    expect(catalogModelList!.getAttribute("data-favorite-reorder") === null).toBe(true);
  });

  test("does not render a drag-handle icon on sortable favorite rows", () => {
    setMobileViewport(false);
    renderPicker({
      models: models.slice(0, 2),
      enabledPlatforms: ["codex"],
      selectedPlatform: "codex",
      favorites: [
        { platform: "codex", modelId: "model-1" },
        { platform: "codex", modelId: "model-2" },
      ],
      onReorderFavorites: () => {},
    });
    openPicker();

    expect(document.querySelector("[data-favorite-sortable]")).toBeTruthy();
    expect(document.querySelector(".lucide-grip-vertical") === null).toBe(true);
    expect(
      [...document.querySelectorAll("[data-native-model-list] svg")]
        .some((svg) => (svg.getAttribute("class") ?? "").includes("grip")),
    ).toBe(false);
  });

  test("names the drag gesture that replaced the handle, and only where it applies", () => {
    setMobileViewport(false);
    renderPicker({
      models: [
        { platform: "codex", id: "model-1", label: "Model 1" },
        { platform: "codex", id: "model-2", label: "Model 2" },
        { platform: "claude", id: "opus", label: "Opus" },
      ],
      enabledPlatforms: ["claude", "codex"],
      selectedPlatform: "codex",
      favorites: [
        { platform: "codex", modelId: "model-1" },
        { platform: "codex", modelId: "model-2" },
      ],
      onReorderFavorites: () => {},
    });
    openPicker();

    expect(getReorderHint()?.textContent).toBe("Drag to reorder");
    expect(getReorderHint()?.getAttribute("data-native-favorite-reorder-hint")).toBe("drag");
    expect(document.querySelector("[data-native-model-list]")?.getAttribute("data-favorite-reorder"))
      .toBe("drag");

    // Searching suspends reordering, so the hint must go with it.
    fireEvent.change(screen.getByPlaceholderText("Search models..."), {
      target: { value: "model 1" },
    });
    expect(getReorderHint() === null).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("Search models..."), {
      target: { value: "" },
    });
    expect(getReorderHint()?.textContent).toBe("Drag to reorder");

    // A single-platform catalog view is not reorderable.
    showPlatformCatalog("claude");
    expect(getReorderHint() === null).toBe(true);
  });

  test("names the long-press gesture on mobile, where no cursor affordance exists", () => {
    setMobileViewport(true);
    renderPicker({
      models: [
        { platform: "codex", id: "model-1", label: "Model 1" },
        { platform: "codex", id: "model-2", label: "Model 2" },
      ],
      selectedPlatform: "codex",
      favorites: [
        { platform: "codex", modelId: "model-1" },
        { platform: "codex", modelId: "model-2" },
      ],
      onReorderFavorites: () => {},
    });
    openPicker();

    expect(getReorderHint()?.textContent).toBe("Long-press to reorder");
    expect(document.querySelector("[data-native-model-list]")?.getAttribute("data-favorite-reorder"))
      .toBe("long-press");
  });

  test("omits the reorder hint when favorites cannot be reordered", () => {
    setMobileViewport(false);
    const withoutHandler = renderPicker({
      models: models.slice(0, 2),
      enabledPlatforms: ["codex"],
      selectedPlatform: "codex",
      favorites: [
        { platform: "codex", modelId: "model-1" },
        { platform: "codex", modelId: "model-2" },
      ],
    });
    openPicker();
    expect(document.querySelector("[data-native-model-list]")).toBeTruthy();
    expect(getReorderHint() === null).toBe(true);
    withoutHandler.unmount();

    // One favorite has nothing to reorder against.
    renderPicker({
      models: models.slice(0, 2),
      enabledPlatforms: ["codex"],
      selectedPlatform: "codex",
      favorites: [{ platform: "codex", modelId: "model-1" }],
      onReorderFavorites: () => {},
    });
    openPicker();
    expect(getReorderHint() === null).toBe(true);
  });

  test("opens on the selected platform when no favorites exist", () => {
    setMobileViewport(false);
    renderPicker({
      models: models.slice(0, 2),
      enabledPlatforms: ["codex"],
      selectedPlatform: "codex",
      favorites: [],
    });
    openPicker();

    expect(screen.getByRole("button", { name: "codex models" }).getAttribute("aria-pressed"))
      .toBe("true");
    expect(screen.getByRole("button", { name: "Favorite models" }).getAttribute("aria-pressed"))
      .toBe("false");
    expect(screen.getByRole("menuitemradio", { name: /Model 1/ })).toBeTruthy();
  });

  test("persists the new order after a desktop pointer drag", async () => {
    setMobileViewport(false);
    const onReorderFavorites = mock(() => {});
    renderPicker({
      models: models.slice(0, 2),
      enabledPlatforms: ["codex"],
      selectedPlatform: "codex",
      favorites: [
        { platform: "codex", modelId: "model-1" },
        { platform: "codex", modelId: "model-2" },
      ],
      onReorderFavorites,
    });
    openPicker();

    await dragFavoriteRow("codex:model-1", "codex:model-2");

    await waitFor(() => expect(onReorderFavorites).toHaveBeenCalledWith([
      { platform: "codex", modelId: "model-2" },
      { platform: "codex", modelId: "model-1" },
    ]));
  });

  test("supports keyboard drag activation and movement for favorite rows", async () => {
    setMobileViewport(false);
    const onReorderFavorites = mock(() => {});
    renderPicker({
      models: models.slice(0, 2),
      enabledPlatforms: ["codex"],
      selectedPlatform: "codex",
      favorites: [
        { platform: "codex", modelId: "model-1" },
        { platform: "codex", modelId: "model-2" },
      ],
      onReorderFavorites,
    });
    openPicker();

    const active = document.querySelector('[data-favorite-sortable="codex:model-1"]')!;
    setSortableRect(active, 0);
    expect(active.getAttribute("role")).toBe("button");
    expect(active.getAttribute("tabindex")).toBe("0");
    (active as HTMLElement).focus();
    fireEvent.keyDown(active, { code: "Space", key: " " });
    expect(active.className).toContain("opacity-50");
    await act(async () => {
      fireEvent.keyDown(active, { code: "ArrowDown", key: "ArrowDown" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect((active as HTMLElement).style.transform).not.toBe("");
    fireEvent.keyDown(active, { code: "Space", key: " " });
    await waitFor(() => expect(active.className).not.toContain("opacity-50"));
    expect(onReorderFavorites).not.toHaveBeenCalled();
  });

  test("persists the new order after a mobile long press", async () => {
    setMobileViewport(true);
    const onReorderFavorites = mock(() => {});
    renderPicker({
      models: models.slice(0, 2),
      enabledPlatforms: ["codex"],
      selectedPlatform: "codex",
      favorites: [
        { platform: "codex", modelId: "model-1" },
        { platform: "codex", modelId: "model-2" },
      ],
      onReorderFavorites,
    });
    openPicker();

    const active = document.querySelector('[data-favorite-sortable="codex:model-1"]')!;
    const over = document.querySelector('[data-favorite-sortable="codex:model-2"]')!;
    setSortableRect(active, 0);
    setSortableRect(over, 100);
    fireEvent.pointerDown(active, {
      button: 0,
      clientX: 16,
      clientY: 16,
      isPrimary: true,
      pointerId: 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 450));
    fireEvent.pointerMove(over, {
      clientX: 16,
      clientY: 40,
      isPrimary: true,
      pointerId: 2,
    });
    fireEvent.pointerMove(over, {
      clientX: 16,
      clientY: 130,
      isPrimary: true,
      pointerId: 2,
    });
    fireEvent.pointerUp(over, {
      clientX: 16,
      clientY: 130,
      isPrimary: true,
      pointerId: 2,
    });

    await waitFor(() => expect(onReorderFavorites).toHaveBeenCalledWith([
      { platform: "codex", modelId: "model-2" },
      { platform: "codex", modelId: "model-1" },
    ]));
  });

  test("uses a long-press drag on mobile favourite rows", () => {
    setMobileViewport(true);
    renderPicker({
      models: [
        { platform: "codex", id: "model-1", label: "Model 1" },
        { platform: "codex", id: "model-2", label: "Model 2" },
      ],
      selectedPlatform: "codex",
      favorites: [
        { platform: "codex", modelId: "model-1" },
        { platform: "codex", modelId: "model-2" },
      ],
      onReorderFavorites: () => {},
    });
    openPicker();

    expect(document.querySelector("[data-native-model-list]")?.getAttribute("data-favorite-reorder"))
      .toBe("long-press");
    expect(document.querySelector('[data-favorite-sortable="codex:model-1"]')).toBeTruthy();
  });
});
