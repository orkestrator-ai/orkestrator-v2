import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { emptyKeyInformation } from "@orkestrator/protocol/build-pipeline-key-information";
import { KeyInformationBody } from "./PipelineKeyInformation";
import { keyInformation } from "./key-information-test-fixture";
import { JUMP_SETTLE_FALLBACK_MS } from "./key-information-section-nav";
import { installControlledTimeout } from "../../../../../tests/helpers/controlled-timeout";

/**
 * The header panel's list of section headings: it sits outside the scrolling
 * column, a heading scrolls the column (smoothly) to its section, and the
 * heading of the section being read is the current one.
 */

const VIEWPORT = 400;
const SECTION_HEIGHT = 300;

const realMatchMedia = window.matchMedia;

function setReducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion: reduce"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

/** Lays the sections out one under another, as the browser would. */
function layOut(scroller: HTMLElement) {
  const sections = Array.from(scroller.querySelectorAll<HTMLElement>("section"));
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: VIEWPORT });
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    value: sections.length * SECTION_HEIGHT,
  });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: VIEWPORT }) as DOMRect;
  sections.forEach((section, index) => {
    section.getBoundingClientRect = () =>
      ({ top: index * SECTION_HEIGHT - scroller.scrollTop }) as DOMRect;
  });
  const scrollTo = mock((options: ScrollToOptions) => {
    scroller.scrollTop = options.top ?? 0;
  });
  scroller.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"];
  return { sections, scrollTo };
}

function renderBody() {
  render(<KeyInformationBody keyInformation={keyInformation} />);
  const nav = screen.getByRole("navigation", { name: "Key information sections" });
  const scroller = screen.getByTestId("pipeline-key-information-scroller");
  return { nav, scroller, ...layOut(scroller) };
}

function current(nav: HTMLElement): string | null | undefined {
  return nav.querySelector('[aria-current="location"]')?.textContent;
}

describe("Key information panel section list", () => {
  beforeEach(() => {
    cleanup();
    setReducedMotion(false);
  });
  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  test("lists the recorded sections in reading order outside the scrolling column", () => {
    const { nav, scroller } = renderBody();

    expect(
      within(nav)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual([
      "Summary",
      "Objective",
      "Context",
      "Solution",
      "What was done",
      "Decisions",
      "Not done",
      "Tests",
      "Review issues",
      "Verification",
    ]);
    expect(scroller.contains(nav)).toBe(false);
    expect(current(nav)).toBe("Summary");
  });

  test.each(["problem", "objective"] as const)(
    "keeps the legacy %s first when summary is absent",
    (framing) => {
      const legacy = { ...keyInformation, framing };
      delete legacy.summary;
      render(<KeyInformationBody keyInformation={legacy} />);
      const title = framing === "objective" ? "Objective" : "Problem";
      const nav = screen.getByRole("navigation", { name: "Key information sections" });
      const scroller = screen.getByTestId("pipeline-key-information-scroller");
      const statement = within(scroller).getByRole("region", { name: title });
      expect(within(scroller).getAllByRole("region")[0]).toBe(statement);
      expect(within(statement).getByText(legacy.statement!)).toBeTruthy();
      expect(within(scroller).queryByRole("region", { name: "Summary" }) === null).toBe(true);
      expect(within(nav).getAllByRole("button")[0]!.textContent).toBe(title);
      expect(within(nav).queryByRole("button", { name: "Summary" }) === null).toBe(true);
      expect(current(nav)).toBe(title);
    },
  );

  test("renders a summary-only brief with just its Summary section and navigation entry", () => {
    const summary = "The pipeline now explains its progress in plain language.";
    render(
      <KeyInformationBody
        keyInformation={{ ...emptyKeyInformation(keyInformation.updatedAt), summary }}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Key information sections" });
    const scroller = screen.getByTestId("pipeline-key-information-scroller");
    const regions = within(scroller).getAllByRole("region");
    expect(regions).toHaveLength(1);
    expect(regions[0]).toBe(within(scroller).getByRole("region", { name: "Summary" }));
    expect(within(regions[0]!).getByText(summary)).toBeTruthy();
    expect(screen.queryByText(/Nothing has been recorded yet/) === null).toBe(true);
    expect(
      within(nav)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Summary"]);
    expect(current(nav)).toBe("Summary");
  });

  test("a heading scrolls the column smoothly to its section and becomes current", () => {
    const { nav, scrollTo } = renderBody();

    fireEvent.click(within(nav).getByRole("button", { name: "Decisions" }));

    expect(scrollTo).toHaveBeenCalledTimes(1);
    // The sixth section, less the gap left above its heading.
    expect(scrollTo.mock.calls[0]![0]).toEqual({
      top: 5 * SECTION_HEIGHT - 12,
      behavior: "smooth",
    });
    expect(current(nav)).toBe("Decisions");
  });

  test("jumps without animating when the user prefers reduced motion", () => {
    setReducedMotion(true);
    const { nav, scrollTo } = renderBody();

    fireEvent.click(within(nav).getByRole("button", { name: "Tests" }));

    expect(scrollTo.mock.calls[0]![0]).toMatchObject({ behavior: "auto" });
  });

  test("never scrolls past the end of the column", () => {
    const { nav, scrollTo } = renderBody();

    fireEvent.click(within(nav).getByRole("button", { name: "Verification" }));

    expect(scrollTo.mock.calls[0]![0]).toMatchObject({ top: 10 * SECTION_HEIGHT - VIEWPORT });
    expect(current(nav)).toBe("Verification");
  });

  test("scrolling the column moves the current heading to the section being read", async () => {
    const { nav, scroller } = renderBody();

    await act(async () => {
      scroller.scrollTop = 3 * SECTION_HEIGHT + 10;
      fireEvent.scroll(scroller);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(current(nav)).toBe("Solution");

    await act(async () => {
      scroller.scrollTop = 10 * SECTION_HEIGHT - VIEWPORT;
      fireEvent.scroll(scroller);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    // At the end the last section is current even though its heading never
    // reached the top.
    expect(current(nav)).toBe("Verification");
  });

  test("keeps a jump's destination current while the scroll animates", async () => {
    const { nav, scroller } = renderBody();

    fireEvent.click(within(nav).getByRole("button", { name: "Tests" }));
    await act(async () => {
      // A frame part-way through the animation, over the Decisions section.
      scroller.scrollTop = 5 * SECTION_HEIGHT;
      fireEvent.scroll(scroller);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(current(nav)).toBe("Tests");

    await act(async () => {
      fireEvent(scroller, new Event("scrollend"));
      scroller.scrollTop = 5 * SECTION_HEIGHT + 10;
      fireEvent.scroll(scroller);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(current(nav)).toBe("Decisions");
  });

  test("releases the jump lock after one second without scrollend", async () => {
    const fallback = installControlledTimeout(JUMP_SETTLE_FALLBACK_MS, {
      label: "jump settle fallback",
    });
    try {
      const { nav, scroller } = renderBody();
      fireEvent.click(within(nav).getByRole("button", { name: "Tests" }));
      await act(async () => {
        scroller.scrollTop = 5 * SECTION_HEIGHT;
        fireEvent.scroll(scroller);
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(current(nav)).toBe("Tests");
      await act(async () => {
        // The second passes with no scrollend.
        expect(fallback.advance()).toBe(1);
        fireEvent.scroll(scroller);
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(current(nav)).toBe("Decisions");
    } finally {
      fallback.restore();
    }
  });

  test("shows no section list before anything is recorded", () => {
    render(<KeyInformationBody keyInformation={undefined} />);

    expect(screen.getByText(/Nothing has been recorded yet/)).toBeTruthy();
    expect(screen.queryByRole("navigation") === null).toBe(true);
  });
});
