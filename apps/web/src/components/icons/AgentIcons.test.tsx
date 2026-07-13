import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { ClaudeIcon, CodexIcon, DockerIcon, OpenCodeIcon } from "./AgentIcons";

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
        <DockerIcon className="docker-custom" />
      </>,
    );

    const icons = [...container.querySelectorAll("svg")];
    expect(icons).toHaveLength(4);
    expect(icons.map((icon) => icon.classList.contains("h-4"))).toEqual([true, true, true, true]);
    expect(icons.map((icon) => icon.getAttribute("class")?.split(" ").at(-1))).toEqual([
      "claude-custom",
      "codex-custom",
      "opencode-custom",
      "docker-custom",
    ]);
    expect(icons.every((icon) => icon.querySelector("path"))).toBe(true);
  });
});
