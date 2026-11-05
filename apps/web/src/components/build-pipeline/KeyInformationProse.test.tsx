import { createRef } from "react";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";
import { emptyKeyInformation } from "@orkestrator/protocol/build-pipeline-key-information";
import { KeyInformationProse } from "./KeyInformationProse";
import { KeyInformationBody } from "./PipelineKeyInformation";
import { KeyInformationDocument } from "./PipelineKeyInformationTab";

const STRUCTURED = [
  "The brief is now easier to read.",
  "",
  "It changes three things:",
  "- paragraphs are kept apart",
  "- bullet lines become a list",
  "- long older text is split by sentence",
  "",
  "1. first step",
  "2. second step",
].join("\n");

afterEach(cleanup);

describe("KeyInformationProse", () => {
  test("renders paragraphs, a bulleted list and a numbered list", () => {
    const { container } = render(<KeyInformationProse text={STRUCTURED} />);
    const paragraphs = container.querySelectorAll("p");
    expect(Array.from(paragraphs, (p) => p.textContent)).toEqual([
      "The brief is now easier to read.",
      "It changes three things:",
    ]);
    const bullets = container.querySelector("ul")!;
    expect(bullets.classList.contains("list-disc")).toBe(true);
    expect(
      within(bullets)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "paragraphs are kept apart",
      "bullet lines become a list",
      "long older text is split by sentence",
    ]);
    const numbered = container.querySelector("ol")!;
    expect(numbered.classList.contains("list-decimal")).toBe(true);
    expect(within(numbered).getAllByRole("listitem")).toHaveLength(2);
  });

  test("draws every run of text through renderText", () => {
    render(
      <KeyInformationProse
        text={"one\n\n- two"}
        renderText={(value) => <span data-testid="run">{value.toUpperCase()}</span>}
      />,
    );
    expect(screen.getAllByTestId("run").map((run) => run.textContent)).toEqual(["ONE", "TWO"]);
  });
});

describe("Key information summary layout", () => {
  const info = { ...emptyKeyInformation("2026-11-05T09:00:00.000Z"), summary: STRUCTURED };

  test("the header panel shows the summary as paragraphs and bullets", () => {
    render(<KeyInformationBody keyInformation={info} />);
    const summary = screen.getByRole("region", { name: "Summary" });
    expect(summary.querySelectorAll("p")).toHaveLength(2);
    expect(within(summary).getAllByRole("list")).toHaveLength(2);
    expect(within(summary).getByText("bullet lines become a list").tagName).toBe("LI");
  });

  test("the panel still highlights code inside a bullet", () => {
    render(
      <KeyInformationBody
        keyInformation={{ ...info, summary: "Changed:\n- `bun fmt` now runs" }}
      />,
    );
    const summary = screen.getByRole("region", { name: "Summary" });
    expect(within(summary).getByText("bun fmt").tagName).toBe("CODE");
    expect(within(summary).getByText("bun fmt").closest("li")).not.toBeNull();
  });

  test("the key information tab shows the summary as paragraphs and bullets", () => {
    render(<KeyInformationDocument keyInformation={info} scrollRef={createRef()} />);
    const summary = screen.getByRole("region", { name: "Summary" });
    expect(summary.querySelectorAll("p")).toHaveLength(2);
    expect(within(summary).getByText("long older text is split by sentence").tagName).toBe("LI");
  });
});
