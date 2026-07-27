import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  filterAndOrderOpenCodeModels,
  OpenCodeModelSelect,
} from "../../../apps/web/src/components/opencode/OpenCodeModelSelect";

const models = [
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

describe("OpenCodeModelSelect", () => {
  test("puts favorites first and filters by model id, name, or provider", () => {
    expect(
      filterAndOrderOpenCodeModels(
        models,
        ["openrouter/google/gemini"],
        "",
      ),
    ).toEqual({
      favorites: [models[2]],
      models: [models[1], models[0]],
    });

    expect(
      filterAndOrderOpenCodeModels(
        models,
        ["openrouter/google/gemini"],
        "openai",
      ),
    ).toEqual({
      favorites: [],
      models: [models[0]],
    });
  });

  test("renders search at the top with favorite rows before the remaining catalogue", () => {
    render(
      <>
        <label htmlFor="model-select">Model</label>
        <OpenCodeModelSelect
          id="model-select"
          value="anthropic/claude-sonnet"
          options={models}
          favoriteModelIds={["openrouter/google/gemini"]}
          onValueChange={() => {}}
        />
      </>,
    );

    fireEvent.pointerDown(screen.getByRole("combobox", { name: "Model" }), {
      button: 0,
      ctrlKey: false,
    });

    const search = screen.getByRole("searchbox", {
      name: "Search OpenCode models",
    });
    expect(search).toBeTruthy();
    expect(screen.getByText("Favorites")).toBeTruthy();
    expect(
      screen.getAllByRole("menuitemradio").map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining("Gemini"),
      expect.stringContaining("Claude Sonnet"),
      expect.stringContaining("GPT-5"),
    ]);

    fireEvent.change(search, { target: { value: "gpt" } });
    expect(
      screen.getAllByRole("menuitemradio").map((item) => item.textContent),
    ).toEqual([expect.stringContaining("GPT-5")]);
  });
});
