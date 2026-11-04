import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CommandNodeHomeIcon, MachineHomeIcon, ProjectIconImage } from "./MachineDot";

const ICON = "data:image/png;base64,iVBORw0KGgo=";

afterEach(cleanup);

function classesOf(element: Element): string[] {
  return (element.getAttribute("class") ?? "").split(/\s+/);
}

describe("CommandNodeHomeIcon", () => {
  test("a project icon fills the outline and is clipped to its rounded corners", () => {
    render(<CommandNodeHomeIcon colorToken="green" projectIcon={ICON} />);
    const outline = screen.getByTestId("command-node-home-icon");
    const outlineClasses = classesOf(outline);
    expect(outlineClasses).toEqual(
      expect.arrayContaining(["size-8", "overflow-hidden", "rounded-lg", "border"]),
    );
    expect(outlineClasses).toEqual(
      expect.arrayContaining(["border-emerald-500", "dark:border-emerald-400"]),
    );
    expect(outlineClasses.some((name) => /^(p|px|py|pt|pr|pb|pl)-/.test(name))).toBe(false);

    const image = within(outline).getByTestId("project-icon");
    expect(image.getAttribute("src")).toBe(ICON);
    const imageClasses = classesOf(image);
    expect(imageClasses).toEqual(
      expect.arrayContaining(["size-full", "rounded-none", "object-cover"]),
    );
    // The shared default size and radius, and the old inset size, must not survive the merge.
    for (const stale of ["h-3.5", "w-3.5", "h-5", "w-5", "rounded-[3px]", "rounded-[4px]"]) {
      expect(imageClasses).not.toContain(stale);
    }
    expect(outline.querySelector("svg")).toBeNull();
  });

  for (const [name, projectIcon] of [
    ["no icon", undefined],
    ["a null icon", null],
    ["an icon that is not a bounded raster", "data:image/svg+xml;base64,PHN2Zz4="],
  ] as const) {
    test(`${name} keeps the centred house`, () => {
      render(<CommandNodeHomeIcon colorToken="green" projectIcon={projectIcon} />);
      const outline = screen.getByTestId("command-node-home-icon");
      expect(classesOf(outline)).toEqual(
        expect.arrayContaining(["size-8", "items-center", "justify-center"]),
      );
      expect(within(outline).queryByTestId("project-icon")).toBeNull();
      const house = outline.querySelector("svg");
      expect(house).not.toBeNull();
      expect(classesOf(house!)).toEqual(expect.arrayContaining(["h-4", "w-4", "text-emerald-500"]));
    });
  }
});

describe("other project icon uses keep their sizing", () => {
  test("ProjectIconImage defaults to the small rounded image", () => {
    render(<ProjectIconImage src={ICON} />);
    expect(classesOf(screen.getByTestId("project-icon"))).toEqual(
      expect.arrayContaining(["h-3.5", "w-3.5", "rounded-[3px]", "object-cover"]),
    );
  });

  test("MachineHomeIcon shows the small image, unclipped, with its machine dot", () => {
    render(
      <TooltipProvider>
        <MachineHomeIcon colorToken="green" machineName="mini" projectIcon={ICON} />
      </TooltipProvider>,
    );
    const wrapper = screen.getByTestId("machine-project-icon");
    expect(classesOf(wrapper)).not.toContain("overflow-hidden");
    expect(classesOf(within(wrapper).getByTestId("project-icon"))).toEqual(
      expect.arrayContaining(["h-3.5", "w-3.5", "rounded-[3px]"]),
    );
  });
});
