import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { GithubIcon } from "./GithubIcon";

afterEach(cleanup);

describe("GithubIcon", () => {
  test("is decorative by default, like a lucide icon", () => {
    const { container } = render(<GithubIcon className="h-4 w-4" />);
    const svg = container.querySelector("svg");

    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("class")).toBe("lucide lucide-github h-4 w-4");
    expect(svg?.getAttribute("width")).toBe("24");
  });

  test("exposes an accessible name when the caller provides one", () => {
    render(<GithubIcon role="img" aria-label="GitHub" size={16} strokeWidth={1.5} />);
    const svg = screen.getByRole("img", { name: "GitHub" });

    expect(svg.getAttribute("aria-hidden")).toBeNull();
    expect(svg.getAttribute("width")).toBe("16");
    expect(svg.getAttribute("stroke-width")).toBeNull();
  });
});
