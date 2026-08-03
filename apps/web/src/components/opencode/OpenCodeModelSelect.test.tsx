import { afterAll, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  filterAndOrderOpenCodeModels,
  OpenCodeModelSelect,
  type OpenCodeModelSelectOption,
} from "./OpenCodeModelSelect";

const options: OpenCodeModelSelectOption[] = [
  { id: "openrouter/zeptomal", name: "ZeptoMal", description: "openrouter" },
  { id: "anthropic/claude-sonnet", name: "Claude Sonnet", description: "anthropic" },
  { id: "openrouter/gpt-5", name: "GPT-5", description: "openrouter" },
  { id: "google/gemini", name: "Gemini", description: "google" },
];

describe("filterAndOrderOpenCodeModels", () => {
  test("renders favorites first, preserving their configured order", () => {
    const { favorites, models } = filterAndOrderOpenCodeModels(
      options,
      ["google/gemini", "openrouter/gpt-5"],
      "",
    );

    expect(favorites.map((option) => option.id)).toEqual([
      "google/gemini",
      "openrouter/gpt-5",
    ]);
    // Non-favorites are sorted by provider then name and never duplicated.
    expect(models.map((option) => option.id)).toEqual([
      "anthropic/claude-sonnet",
      "openrouter/zeptomal",
    ]);
  });

  test("drops favorite ids that are not in the catalogue", () => {
    const { favorites, models } = filterAndOrderOpenCodeModels(
      options,
      ["missing/model", "anthropic/claude-sonnet"],
      "",
    );

    expect(favorites.map((option) => option.id)).toEqual(["anthropic/claude-sonnet"]);
    expect(models.some((option) => option.id === "anthropic/claude-sonnet")).toBe(false);
  });

  test("searches across name, id, and provider description", () => {
    expect(filterAndOrderOpenCodeModels(options, [], "sonnet").models).toEqual([
      options[1]!,
    ]);
    expect(filterAndOrderOpenCodeModels(options, [], "openrouter").models).toEqual([
      options[2]!,
      options[0]!,
    ]);
    expect(filterAndOrderOpenCodeModels(options, [], "zepto").models).toEqual([
      options[0]!,
    ]);
  });

  test("keeps a matching favorite in the favorites section while filtering the rest", () => {
    const { favorites, models } = filterAndOrderOpenCodeModels(
      options,
      ["google/gemini"],
      "gemini",
    );

    expect(favorites.map((option) => option.id)).toEqual(["google/gemini"]);
    expect(models).toEqual([]);
  });

  test("is case-insensitive and tolerant of surrounding whitespace", () => {
    const { models } = filterAndOrderOpenCodeModels(options, [], "  GPT-5  ");
    expect(models.map((option) => option.id)).toEqual(["openrouter/gpt-5"]);
  });
});

describe("OpenCodeModelSelect", () => {
  afterAll(cleanup);

  test("renders a search field over the favourites-first results when opened", () => {
    render(
      <OpenCodeModelSelect
        value=""
        options={options}
        favoriteModelIds={["google/gemini"]}
        onValueChange={mock(() => undefined)}
      />,
    );

    const trigger = screen.getByRole("combobox");
    act(() => {
      fireEvent.pointerDown(trigger);
      fireEvent.click(trigger);
    });

    const search = screen.getByPlaceholderText("Search models or providers…");
    expect(search).toBeTruthy();
    expect(screen.getByText("Favorites")).toBeTruthy();
    expect(screen.getByText("google/gemini")).toBeTruthy();
  });

  test("shows the empty label when there are no options at all", () => {
    render(
      <OpenCodeModelSelect
        value=""
        options={[]}
        emptyLabel="Choose a model"
        onValueChange={mock(() => undefined)}
      />,
    );

    expect(screen.getByRole("combobox").textContent).toContain("Choose a model");
  });

  test("defaults the empty label when no options are present", () => {
    render(<OpenCodeModelSelect value="" options={[]} onValueChange={mock(() => undefined)} />);

    expect(screen.getByRole("combobox").textContent).toContain("No models cached");
  });

  test("shows a placeholder when options exist but nothing is selected", () => {
    render(<OpenCodeModelSelect value="" options={options} onValueChange={mock(() => undefined)} />);

    expect(screen.getByRole("combobox").textContent).toContain("Select model");
  });

  test("renders the selected model's description in the trigger when enabled", () => {
    render(
      <OpenCodeModelSelect
        value="anthropic/claude-sonnet"
        options={options}
        showDescriptionInTrigger
        onValueChange={mock(() => undefined)}
      />,
    );

    const trigger = screen.getByRole("combobox");
    expect(trigger.textContent).toContain("Claude Sonnet");
    expect(trigger.textContent).toContain("anthropic");
  });

  test("keeps the description out of the trigger by default", () => {
    render(
      <OpenCodeModelSelect
        value="anthropic/claude-sonnet"
        options={options}
        onValueChange={mock(() => undefined)}
      />,
    );

    const trigger = screen.getByRole("combobox");
    expect(trigger.textContent).toContain("Claude Sonnet");
    expect(trigger.textContent).not.toContain("anthropic");
  });

  test("reports no matching models for an unmatched search", () => {
    render(<OpenCodeModelSelect value="" options={options} onValueChange={mock(() => undefined)} />);

    const trigger = screen.getByRole("combobox");
    act(() => {
      fireEvent.pointerDown(trigger);
      fireEvent.click(trigger);
    });

    fireEvent.change(screen.getByPlaceholderText("Search models or providers…"), {
      target: { value: "does-not-exist" },
    });

    expect(screen.getByText("No matching models")).toBeTruthy();
  });

  test("selects the highlighted model with the keyboard", () => {
    const onValueChange = mock((_value: string) => undefined);
    render(<OpenCodeModelSelect value="" options={options} onValueChange={onValueChange} />);

    const trigger = screen.getByRole("combobox");
    act(() => {
      fireEvent.pointerDown(trigger);
      fireEvent.click(trigger);
    });

    const search = screen.getByPlaceholderText("Search models or providers…");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });

    // Models sort by provider description then name, so the first result is the
    // "anthropic" entry.
    expect(onValueChange).toHaveBeenCalledWith("anthropic/claude-sonnet");
  });

  test("selects a model on click", () => {
    const onValueChange = mock((_value: string) => undefined);
    render(<OpenCodeModelSelect value="" options={options} onValueChange={onValueChange} />);

    const trigger = screen.getByRole("combobox");
    act(() => {
      fireEvent.pointerDown(trigger);
      fireEvent.click(trigger);
    });

    fireEvent.click(screen.getByText("GPT-5"));

    expect(onValueChange).toHaveBeenCalledWith("openrouter/gpt-5");
  });
});
