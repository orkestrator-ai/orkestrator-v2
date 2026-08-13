import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { AgentIcon, AgentRadioGroup } from "./AgentRadioGroup";
import type { LaunchAgent } from "@/lib/agent-launch";
import { useConfigStore } from "@/stores/configStore";

afterEach(() => {
  cleanup();
  useConfigStore.setState((state) => ({
    config: {
      ...state.config,
      global: {
        ...state.config.global,
        enabledAgentPlatforms: ["claude", "codex", "opencode"],
      },
    },
  }));
});

function renderGroup(
  overrides: Partial<Parameters<typeof AgentRadioGroup>[0]> = {},
) {
  const onChange = mock((_agent: LaunchAgent) => undefined);
  const props = {
    value: "claude" as LaunchAgent,
    onChange,
    label: "Build agent",
    ...overrides,
  };
  return { onChange, ...render(<AgentRadioGroup {...props} />) };
}

/** The group as a real caller drives it: the parent owns the selection. */
function renderControlled(initial: LaunchAgent = "claude") {
  const onChange = mock((_agent: LaunchAgent) => undefined);
  function Harness() {
    const [value, setValue] = useState<LaunchAgent>(initial);
    return (
      <AgentRadioGroup
        value={value}
        label="Build agent"
        onChange={(agent) => {
          setValue(agent);
          onChange(agent);
        }}
      />
    );
  }
  return { onChange, ...render(<Harness />) };
}

function radios() {
  return screen.getAllByRole("radio") as HTMLInputElement[];
}

/** The styled card that stands in for the visually hidden input. */
function cardFor(radio: HTMLInputElement) {
  return document.querySelector<HTMLLabelElement>(`label[for="${radio.id}"]`)!;
}

describe("AgentRadioGroup", () => {
  test("exposes the three agents as one named radio group", () => {
    renderGroup();

    const group = screen.getByRole("radiogroup", { name: "Build agent" });
    const options = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(options).toHaveLength(3);
    expect(options.map((radio) => cardFor(radio).textContent))
      .toEqual(["Claude", "Codex", "OpenCode"]);
  });

  test("exposes all five agents when every platform is enabled", () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          enabledAgentPlatforms: ["claude", "codex", "cursor", "grok", "opencode"],
        },
      },
    }));
    renderGroup();

    expect(radios().map((radio) => cardFor(radio).textContent)).toEqual([
      "Claude",
      "Codex",
      "Cursor Agent",
      "Grok Build",
      "OpenCode",
    ]);
  });

  test("reports the selected agent and only that agent as checked", () => {
    renderGroup({ value: "codex" });

    expect(radios().map((radio) => radio.checked)).toEqual([false, true, false]);
  });

  test("selects an agent when its card is clicked", () => {
    const { onChange } = renderGroup();

    fireEvent.click(screen.getByRole("radio", { name: /^OpenCode/ }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("opencode");
  });

  test("keeps only the selected radio in the tab order", () => {
    renderGroup({ value: "codex" });

    // A roving tabindex: Tab reaches the group once, arrows move within it.
    expect(radios().map((radio) => radio.tabIndex)).toEqual([-1, 0, -1]);
  });
});

describe("AgentRadioGroup keyboard navigation", () => {
  test("moves forward with ArrowRight and ArrowDown", () => {
    const { onChange } = renderControlled();

    // fireEvent returns false when the handler called preventDefault, which is
    // what stops the arrow key from also scrolling the surrounding dialog.
    expect(fireEvent.keyDown(radios()[0]!, { key: "ArrowRight" })).toBe(false);
    expect(document.activeElement).toBe(radios()[1]!);

    expect(fireEvent.keyDown(radios()[1]!, { key: "ArrowDown" })).toBe(false);
    expect(document.activeElement).toBe(radios()[2]!);

    expect(onChange.mock.calls).toEqual([["codex"], ["opencode"]]);
    expect(radios().map((radio) => radio.checked)).toEqual([false, false, true]);
  });

  test("moves backward with ArrowLeft and ArrowUp", () => {
    const { onChange } = renderControlled("opencode");

    expect(fireEvent.keyDown(radios()[2]!, { key: "ArrowLeft" })).toBe(false);
    expect(document.activeElement).toBe(radios()[1]!);

    expect(fireEvent.keyDown(radios()[1]!, { key: "ArrowUp" })).toBe(false);
    expect(document.activeElement).toBe(radios()[0]!);

    expect(onChange.mock.calls).toEqual([["codex"], ["claude"]]);
    expect(radios().map((radio) => radio.checked)).toEqual([true, false, false]);
  });

  test("wraps around both ends", () => {
    const { onChange } = renderControlled();

    // First -> previous wraps to last.
    fireEvent.keyDown(radios()[0]!, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("opencode");
    expect(document.activeElement).toBe(radios()[2]!);

    // Last -> next wraps back to first.
    fireEvent.keyDown(radios()[2]!, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("claude");
    expect(document.activeElement).toBe(radios()[0]!);
  });

  test("jumps to the ends with Home and End", () => {
    const { onChange } = renderControlled("codex");

    expect(fireEvent.keyDown(radios()[1]!, { key: "End" })).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith("opencode");
    expect(document.activeElement).toBe(radios()[2]!);

    expect(fireEvent.keyDown(radios()[2]!, { key: "Home" })).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith("claude");
    expect(document.activeElement).toBe(radios()[0]!);
  });

  test("ignores every other key", () => {
    const { onChange } = renderControlled();

    for (const key of ["a", "Enter", "Tab", "PageDown"]) {
      expect(fireEvent.keyDown(radios()[0]!, { key })).toBe(true);
    }

    expect(onChange).not.toHaveBeenCalled();
    expect(radios().map((radio) => radio.checked)).toEqual([true, false, false]);
  });

  test("navigates from the first option when the value is not in the list", () => {
    const { onChange } = renderGroup({ value: "gemini" as LaunchAgent });

    // Nothing is selected, but the group must stay operable.
    expect(radios().map((radio) => radio.checked)).toEqual([false, false, false]);
    fireEvent.keyDown(radios()[0]!, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("claude");
    fireEvent.keyDown(radios()[0]!, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("opencode");
    // Math.max(indexOf, 0) anchors an unknown value at the first option.
    fireEvent.keyDown(radios()[0]!, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("codex");
  });
});

describe("AgentRadioGroup isolation", () => {
  test("never shares a radio name or an input id between two groups", () => {
    render(
      <div>
        <AgentRadioGroup value="claude" onChange={() => undefined} label="Build agent" />
        <AgentRadioGroup value="codex" onChange={() => undefined} label="Review agent" />
      </div>,
    );

    const build = within(screen.getByRole("radiogroup", { name: "Build agent" }))
      .getAllByRole("radio") as HTMLInputElement[];
    const review = within(screen.getByRole("radiogroup", { name: "Review agent" }))
      .getAllByRole("radio") as HTMLInputElement[];

    // Native radios sharing a name are one browser-level group, so the second
    // group would silently clear the first one's selection.
    const buildNames = [...new Set(build.map((radio) => radio.name))];
    const reviewNames = [...new Set(review.map((radio) => radio.name))];
    expect(buildNames).toHaveLength(1);
    expect(reviewNames).toHaveLength(1);
    expect(buildNames[0]!).not.toBe(reviewNames[0]!);

    // Ids are what each card's `htmlFor` points at; a collision would send
    // clicks and focus into the wrong group.
    expect(new Set([...build, ...review].map((radio) => radio.id)).size).toBe(6);

    expect(build.map((radio) => radio.checked)).toEqual([true, false, false]);
    expect(review.map((radio) => radio.checked)).toEqual([false, true, false]);
  });

  test("selecting in one group does not call the other group's handler", () => {
    const onBuildChange = mock((_agent: LaunchAgent) => undefined);
    const onReviewChange = mock((_agent: LaunchAgent) => undefined);
    render(
      <div>
        <AgentRadioGroup value="claude" onChange={onBuildChange} label="Build agent" />
        <AgentRadioGroup value="claude" onChange={onReviewChange} label="Review agent" />
      </div>,
    );

    fireEvent.click(
      within(screen.getByRole("radiogroup", { name: "Review agent" }))
        .getByRole("radio", { name: /^Codex/ }),
    );

    expect(onReviewChange).toHaveBeenCalledWith("codex");
    expect(onBuildChange).not.toHaveBeenCalled();
  });
});

describe("AgentRadioGroup descriptions", () => {
  test("renders a caption per agent and reserves room for it", () => {
    renderGroup({
      descriptions: {
        claude: "Balanced everyday coding",
        codex: "Deep reasoning passes",
        opencode: "Bring your own provider",
      },
    });

    expect(screen.getByText("Balanced everyday coding")).toBeTruthy();
    expect(screen.getByText("Deep reasoning passes")).toBeTruthy();
    expect(screen.getByText("Bring your own provider")).toBeTruthy();
    for (const radio of radios()) {
      expect(cardFor(radio).className.split(/\s+/)).toContain("min-h-20");
    }
  });

  test("stays single-line when no captions are supplied", () => {
    renderGroup();

    for (const radio of radios()) {
      const card = cardFor(radio);
      expect(card.className.split(/\s+/)).not.toContain("min-h-20");
      // Just the agent name: nothing is padding out an absent caption.
      expect(card.querySelectorAll("span")).toHaveLength(1);
    }
    expect(screen.queryByText("Balanced everyday coding")).toBeNull();
  });

  test("reserves room only for the described agents", () => {
    renderGroup({ descriptions: { codex: "Deep reasoning passes" } });

    const [claude, codex, opencode] = radios() as [
      HTMLInputElement,
      HTMLInputElement,
      HTMLInputElement,
    ];
    expect(cardFor(codex).className.split(/\s+/)).toContain("min-h-20");
    expect(cardFor(claude).className.split(/\s+/)).not.toContain("min-h-20");
    expect(cardFor(opencode).className.split(/\s+/)).not.toContain("min-h-20");
  });
});

describe("AgentIcon", () => {
  test("draws a distinct glyph for every agent", () => {
    const glyphs = (["claude", "codex", "cursor", "grok", "opencode"] as const).map((agent) => {
      const { container, unmount } = render(<AgentIcon agent={agent} />);
      const svg = container.querySelector("svg");
      expect(svg).not.toBeNull();
      const html = svg!.outerHTML;
      unmount();
      return html;
    });

    expect(new Set(glyphs).size).toBe(5);
  });

  test("passes its class through to the glyph", () => {
    const { container } = render(<AgentIcon agent="codex" className="size-4" />);

    expect(container.querySelector("svg")!.getAttribute("class")).toContain("size-4");
  });

  test("falls back to the OpenCode glyph for an unknown agent", () => {
    const opencode = render(<AgentIcon agent="opencode" />);
    const expected = opencode.container.querySelector("svg")!.outerHTML;
    opencode.unmount();

    const { container } = render(<AgentIcon agent={"gemini" as LaunchAgent} />);

    expect(container.querySelector("svg")!.outerHTML).toBe(expected);
  });
});
