import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import {
  ClaudeIcon,
  CodexIcon,
  CursorAgentIcon,
  DockerIcon,
  GrokBuildIcon,
  OpenCodeIcon,
} from "./AgentIcons";

afterEach(cleanup);

describe("OpenCodeIcon", () => {
  test("renders multiple independent instances without shared SVG definition IDs", () => {
    const { container } = render(
      <>
        <OpenCodeIcon />
        <OpenCodeIcon />
      </>,
    );

    const icons = container.querySelectorAll("svg");
    expect(icons).toHaveLength(2);
    expect(container.querySelectorAll("[id]")).toHaveLength(0);
    expect(icons[0]?.querySelectorAll("path")).toHaveLength(2);
    expect(icons[1]?.querySelectorAll("path")).toHaveLength(2);
  });
});

describe("agent icons", () => {
  test("renders every public icon and merges caller class names", () => {
    const { container } = render(
      <>
        <ClaudeIcon className="claude-custom" />
        <CodexIcon className="codex-custom" />
        <OpenCodeIcon className="opencode-custom" />
        <CursorAgentIcon className="cursor-custom" />
        <GrokBuildIcon className="grok-custom" />
        <DockerIcon className="docker-custom" />
      </>,
    );

    const icons = [...container.querySelectorAll("svg")];
    expect(icons).toHaveLength(6);
    expect(icons.map((icon) => icon.classList.contains("h-4"))).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(icons.map((icon) => icon.getAttribute("class")?.split(" ").at(-1))).toEqual([
      "claude-custom",
      "codex-custom",
      "opencode-custom",
      "cursor-custom",
      "grok-custom",
      "docker-custom",
    ]);
    expect(icons.every((icon) => icon.querySelector("path"))).toBe(true);
  });

  test("uses the native Cursor and Grok logo coordinate systems", () => {
    const { container } = render(
      <>
        <CursorAgentIcon />
        <GrokBuildIcon />
      </>,
    );

    const icons = [...container.querySelectorAll("svg")];
    expect(icons.map((icon) => icon.getAttribute("viewBox"))).toEqual(["0 0 49 56", "0 0 33 32"]);
    expect(icons.every((icon) => icon.querySelector("path")?.getAttribute("d")?.length)).toBe(true);
  });
});
