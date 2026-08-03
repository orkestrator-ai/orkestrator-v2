import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  filterAndOrderOpenCodeModels,
  OpenCodeModelSelect,
  type OpenCodeModelSelectOption,
} from "../../../apps/web/src/components/opencode/OpenCodeModelSelect";

const models: OpenCodeModelSelectOption[] = [
  {
    id: "openrouter/openai/gpt-5",
    name: "GPT-5",
    description: "openrouter",
  },
  {
    id: "anthropic/claude-sonnet",
    name: "Claude Sonnet",
    description: "anthropic",
  },
  {
    id: "openrouter/google/gemini",
    name: "Gemini",
    description: "openrouter",
  },
];

afterEach(cleanup);

function renderPicker({
  options = models,
  favorites = ["openrouter/google/gemini"],
  value = "anthropic/claude-sonnet",
  onValueChange = mock(() => {}),
  disabled = false,
  showDescriptionInTrigger,
  emptyLabel,
  className,
}: {
  options?: OpenCodeModelSelectOption[];
  favorites?: string[];
  value?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  showDescriptionInTrigger?: boolean;
  emptyLabel?: string;
  className?: string;
} = {}) {
  render(
    <>
      <label htmlFor="model-select">Model</label>
      <OpenCodeModelSelect
        id="model-select"
        value={value}
        options={options}
        favoriteModelIds={favorites}
        onValueChange={onValueChange}
        disabled={disabled}
        showDescriptionInTrigger={showDescriptionInTrigger}
        emptyLabel={emptyLabel}
        className={className}
      />
    </>,
  );
  return {
    trigger: screen.getByRole("combobox", { name: "Model" }),
    onValueChange,
  };
}

function openPicker(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, {
    button: 0,
    ctrlKey: false,
  });
  return screen.getByRole("searchbox", {
    name: "Search OpenCode models",
  }) as HTMLInputElement;
}

describe("filterAndOrderOpenCodeModels", () => {
  test("puts unique known favorites first and excludes them from the remaining models", () => {
    expect(
      filterAndOrderOpenCodeModels(
        models,
        [
          "missing/model",
          "openrouter/google/gemini",
          "openrouter/google/gemini",
        ],
        "",
      ),
    ).toEqual({
      favorites: [models[2]],
      models: [models[1], models[0]],
    });
  });

  test("filters by model id, name, or provider description", () => {
    expect(filterAndOrderOpenCodeModels(models, [], "  OPENAI ")).toEqual({
      favorites: [],
      models: [models[0]],
    });
    expect(filterAndOrderOpenCodeModels(models, [], "sonnet")).toEqual({
      favorites: [],
      models: [models[1]],
    });
    expect(filterAndOrderOpenCodeModels(models, [], "anthropic")).toEqual({
      favorites: [],
      models: [models[1]],
    });
  });

  test("sorts models from the same provider by name", () => {
    const sameProvider = [
      { id: "provider/z", name: "Zulu", description: "provider" },
      { id: "provider/a", name: "Alpha", description: "provider" },
    ];

    expect(
      filterAndOrderOpenCodeModels(sameProvider, [], "").models.map(
        (model) => model.name,
      ),
    ).toEqual(["Alpha", "Zulu"]);
  });

  test("drops a favorite that does not match the current search", () => {
    // A favorite is pinned, not exempt from filtering: a query it cannot match
    // must remove it from the favorites section rather than leave it stranded
    // above unrelated results.
    expect(
      filterAndOrderOpenCodeModels(models, ["openrouter/google/gemini"], "gpt"),
    ).toEqual({ favorites: [], models: [models[0]!] });

    // ...while a query it does match keeps it pinned.
    expect(
      filterAndOrderOpenCodeModels(models, ["openrouter/google/gemini"], "gemini"),
    ).toEqual({ favorites: [models[2]!], models: [] });
  });

  test("supports models without a provider description", () => {
    const withoutDescription = {
      id: "local/model",
      name: "Local Model",
    };

    expect(
      filterAndOrderOpenCodeModels(
        [models[0]!, withoutDescription],
        [],
        "local",
      ),
    ).toEqual({ favorites: [], models: [withoutDescription] });
    expect(() =>
      filterAndOrderOpenCodeModels([withoutDescription], [], "missing"),
    ).not.toThrow();
  });
});

describe("OpenCodeModelSelect", () => {
  test("renders favorite rows before the remaining catalogue with selected state", () => {
    const { trigger } = renderPicker();
    openPicker(trigger);

    expect(screen.getByText("Favorites")).toBeTruthy();
    const items = screen.getAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Gemini"),
      expect.stringContaining("Claude Sonnet"),
      expect.stringContaining("GPT-5"),
    ]);
    expect(items[1]?.getAttribute("aria-checked")).toBe("true");
    expect(items[0]?.getAttribute("aria-checked")).toBe("false");
  });

  test("selects a result with a pointer and resets the query", async () => {
    const onValueChange = mock(() => {});
    const { trigger } = renderPicker({ onValueChange });
    const search = openPicker(trigger);
    fireEvent.change(search, { target: { value: "gpt" } });
    expect(screen.getByText("1 model")).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitemradio"));

    expect(onValueChange).toHaveBeenCalledWith("openrouter/openai/gpt-5");
    await waitFor(() => expect(screen.queryByRole("searchbox")).toBeNull());

    const reopenedSearch = openPicker(trigger);
    expect(reopenedSearch.value).toBe("");
  });

  test("keeps search focus while arrow keys choose an active result and Enter selects it", async () => {
    const onValueChange = mock(() => {});
    const { trigger } = renderPicker({ onValueChange });
    const search = openPicker(trigger);

    await Promise.resolve();
    expect(document.activeElement).toBe(search);
    const menuId = search.getAttribute("aria-controls");
    expect(menuId).toBeTruthy();
    expect(trigger.getAttribute("aria-controls")).toBe(menuId);
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");

    fireEvent.keyDown(search, { key: "ArrowDown" });
    const firstActiveId = search.getAttribute("aria-activedescendant");
    expect(firstActiveId).toBeTruthy();
    expect(document.getElementById(firstActiveId!)?.textContent).toContain(
      "Gemini",
    );
    expect(document.activeElement).toBe(search);

    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(
      document.getElementById(
        search.getAttribute("aria-activedescendant")!,
      )?.textContent,
    ).toContain("Claude Sonnet");

    fireEvent.keyDown(search, { key: "ArrowUp" });
    expect(
      document.getElementById(
        search.getAttribute("aria-activedescendant")!,
      )?.textContent,
    ).toContain("Gemini");

    fireEvent.keyDown(search, { key: "Enter" });
    expect(onValueChange).toHaveBeenCalledWith(
      "openrouter/google/gemini",
    );
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test("wraps ArrowUp to the final result", () => {
    const { trigger } = renderPicker();
    const search = openPicker(trigger);

    fireEvent.keyDown(search, { key: "ArrowUp" });

    expect(
      document.getElementById(
        search.getAttribute("aria-activedescendant")!,
      )?.textContent,
    ).toContain("GPT-5");
  });

  test("filters by description only and clears the active result when the query changes", () => {
    const providerOnly: OpenCodeModelSelectOption = {
      id: "vendor/model",
      name: "Friendly Name",
      description: "special-provider",
    };
    const { trigger } = renderPicker({
      options: [providerOnly, models[1]!],
      favorites: [],
      value: "",
    });
    const search = openPicker(trigger);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(search.getAttribute("aria-activedescendant")).toBeTruthy();

    fireEvent.change(search, { target: { value: "special-provider" } });

    expect(search.getAttribute("aria-activedescendant")).toBeNull();
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(1);
    expect(screen.getByRole("menuitemradio").textContent).toContain(
      "Friendly Name",
    );
  });

  test("Escape closes, clears the query, and returns focus to the trigger", async () => {
    const { trigger } = renderPicker();
    const search = openPicker(trigger);
    fireEvent.change(search, { target: { value: "gpt" } });

    fireEvent.keyDown(search, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("searchbox")).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
    expect(openPicker(trigger).value).toBe("");
  });

  test("does not open while disabled", () => {
    const { trigger } = renderPicker({ disabled: true });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("searchbox")).toBeNull();

    // Radix gates its trigger on its own `disabled` prop, so a dispatched
    // pointer event must not open what a real user could not click.
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);

    // Asserted as a boolean: a failure here would otherwise serialize the whole
    // open portal tree, which is megabytes of unreadable output.
    expect(screen.queryByRole("searchbox") !== null).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  test("shows an explicit empty catalogue state", () => {
    const { trigger } = renderPicker({
      options: [],
      favorites: [],
      value: "",
    });
    expect(trigger.textContent).toContain("No models cached");

    openPicker(trigger);

    expect(screen.getByText("0 models")).toBeTruthy();
    expect(screen.getByText("No matching models")).toBeTruthy();
    expect(screen.queryByRole("menuitemradio")).toBeNull();
  });

  test("lets a host override the empty-catalogue label", () => {
    // The review dialog keeps its own wording rather than the picker default.
    const { trigger } = renderPicker({
      options: [],
      favorites: [],
      value: "",
      emptyLabel: "Choose a model",
    });

    expect(trigger.textContent).toContain("Choose a model");
    expect(trigger.textContent).not.toContain("No models cached");
  });

  test("shows the selected model's provider in the trigger only when asked", () => {
    const { trigger } = renderPicker({ showDescriptionInTrigger: true });
    expect(trigger.textContent).toContain("Claude Sonnet");
    expect(trigger.textContent).toContain("anthropic");

    cleanup();

    const plain = renderPicker().trigger;
    expect(plain.textContent).toContain("Claude Sonnet");
    expect(plain.textContent).not.toContain("anthropic");
  });

  test("constrains both trigger labels so long names ellipsize", () => {
    // `truncate` cannot ellipsize a fit-content column child, so each label
    // span has to take the full trigger width or long names overflow the
    // control instead of being cut off.
    const { trigger } = renderPicker({ showDescriptionInTrigger: true });

    const labels = trigger.querySelectorAll("span.truncate");
    expect(labels).toHaveLength(2);
    for (const label of labels) {
      expect(label.className).toContain("w-full");
    }
  });

  test("passes an id and className through to the trigger", () => {
    const { trigger } = renderPicker({ className: "min-h-11" });

    expect(trigger.id).toBe("model-select");
    expect(trigger.className).toContain("min-h-11");
  });

  test("marks a selected favorite with a check rather than a star", () => {
    const { trigger } = renderPicker({
      favorites: ["anthropic/claude-sonnet", "openrouter/google/gemini"],
      value: "anthropic/claude-sonnet",
    });
    openPicker(trigger);

    const [selectedFavorite, unselectedFavorite] =
      screen.getAllByRole("menuitemradio");
    expect(selectedFavorite?.querySelector(".lucide-check")).toBeTruthy();
    expect(selectedFavorite?.querySelector(".lucide-star")).toBeNull();
    expect(unselectedFavorite?.querySelector(".lucide-star")).toBeTruthy();
    expect(unselectedFavorite?.querySelector(".lucide-check")).toBeNull();
  });

  test("shows a no-match state and the singular result count", () => {
    const { trigger } = renderPicker();
    const search = openPicker(trigger);

    fireEvent.change(search, { target: { value: "gpt" } });
    expect(screen.getByText("1 model")).toBeTruthy();
    expect(screen.queryByText("No matching models")).toBeNull();

    fireEvent.change(search, { target: { value: "missing" } });
    expect(screen.getByText("0 models")).toBeTruthy();
    expect(screen.getByText("No matching models")).toBeTruthy();
  });

  test("ignores favorites that are not in the catalogue", () => {
    // A favorite pinned against a provider that is no longer configured must
    // not create a phantom row, nor hide a real model that shares its id.
    const { trigger } = renderPicker({
      favorites: ["deleted/provider-model", "anthropic/claude-sonnet"],
    });
    openPicker(trigger);

    const rows = screen.getAllByRole("menuitemradio");
    // The surviving favorite first, then the rest by provider and then name.
    expect(rows.map((row) => row.textContent)).toEqual([
      "Claude Sonnetanthropic/claude-sonnet",
      "Geminiopenrouter/google/gemini",
      "GPT-5openrouter/openai/gpt-5",
    ]);
    expect(screen.getByText("3 models")).toBeTruthy();
    expect(screen.queryByText(/deleted\/provider-model/)).toBeNull();
  });

  test("gives every result a resolvable option id across both sections", () => {
    // The favorites section and the all-models section index into one shared
    // result list; a mismatch would break `aria-activedescendant` lookups.
    const { trigger } = renderPicker({
      favorites: ["openrouter/google/gemini", "anthropic/claude-sonnet"],
    });
    const search = openPicker(trigger);

    const ids = screen
      .getAllByRole("menuitemradio")
      .map((row) => row.getAttribute("id"));
    expect(ids).toEqual(ids.filter((id) => id && !id.endsWith("-option--1")));
    expect(new Set(ids).size).toBe(ids.length);

    // Walking the whole list must land on each row exactly once, in order.
    const visited: (string | null)[] = [];
    for (let index = 0; index < ids.length; index += 1) {
      fireEvent.keyDown(search, { key: "ArrowDown" });
      visited.push(search.getAttribute("aria-activedescendant"));
    }
    expect(visited).toEqual(ids);

    // And wrap back to the first.
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(search.getAttribute("aria-activedescendant")).toBe(ids[0]);
  });

  test("scrolls the active result into view as the keyboard moves through it", () => {
    const scrolled: unknown[] = [];
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element, arg) {
      scrolled.push({ id: this.getAttribute("id"), arg });
    } as typeof Element.prototype.scrollIntoView;

    try {
      const { trigger } = renderPicker();
      const search = openPicker(trigger);

      fireEvent.keyDown(search, { key: "ArrowDown" });
      const firstActive = search.getAttribute("aria-activedescendant");
      fireEvent.keyDown(search, { key: "ArrowDown" });
      const secondActive = search.getAttribute("aria-activedescendant");

      expect(scrolled).toEqual([
        { id: firstActive, arg: { block: "nearest" } },
        { id: secondActive, arg: { block: "nearest" } },
      ]);
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  test("survives an environment without scrollIntoView", () => {
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    // happy-dom and jsdom have both shipped without it at various points.
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;

    try {
      const { trigger } = renderPicker();
      const search = openPicker(trigger);
      expect(() =>
        fireEvent.keyDown(search, { key: "ArrowDown" }),
      ).not.toThrow();
      expect(search.getAttribute("aria-activedescendant")).toBeTruthy();
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  test("Enter without an active result does not select anything", () => {
    const onValueChange = mock(() => {});
    const { trigger } = renderPicker({ onValueChange });
    const search = openPicker(trigger);

    fireEvent.keyDown(search, { key: "Enter" });

    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.getByRole("searchbox")).toBeTruthy();
  });

  test("arrow keys are inert when the query matches nothing", () => {
    const { trigger } = renderPicker();
    const search = openPicker(trigger);
    fireEvent.change(search, { target: { value: "no-such-model" } });

    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "ArrowUp" });

    expect(search.getAttribute("aria-activedescendant")).toBeNull();
  });
});
