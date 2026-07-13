import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { OpenCodeIcon } from "./AgentIcons";

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
