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

  test.each(["", "\n", "\r\n"])("renders single-item lists with trailing %j", (suffix) => {
    const { container } = render(<KeyInformationProse text={`- One change${suffix}`} />);
    expect(container.querySelectorAll("ul > li")).toHaveLength(1);
    expect(container.querySelector("li")?.textContent).toBe("One change");
    cleanup();
    const numbered = render(<KeyInformationProse text={`1. One step${suffix}`} />);
    expect(numbered.container.querySelectorAll("ol > li")).toHaveLength(1);
    expect(numbered.container.querySelector("li")?.getAttribute("value")).toBe("1");
  });

  test("renders source numbers across offsets, gaps, blank lines and prose", () => {
    const { container } = render(
      <KeyInformationProse text={"3. Resume\n5. Finish\n\n6. Deploy\nExplanation.\n8) Verify"} />,
    );
    expect(container.querySelectorAll("ol")).toHaveLength(3);
    expect(
      Array.from(container.querySelectorAll("ol > li"), (li) => li.getAttribute("value")),
    ).toEqual(["3", "5", "6", "8"]);
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

  test("the key information tab renders inline Markdown in prose and lists", () => {
    render(
      <KeyInformationDocument
        keyInformation={{
          ...info,
          solution: "- **backup-ts** Compose service on `:1055`\n- **Docs**: see the guide",
          workDone: ["Verified **pinned** restic honours `HTTP_PROXY`"],
          notDone: ["Run the _live_ suite"],
        }}
        scrollRef={createRef()}
      />,
    );
    const solution = screen.getByRole("region", { name: "Solution" });
    expect(solution.textContent).not.toContain("**");
    expect(solution.textContent).not.toContain("`");
    expect(within(solution).getByText("backup-ts").tagName).toBe("STRONG");
    expect(within(solution).getByText(":1055").tagName).toBe("CODE");
    expect(within(solution).getByText("backup-ts").closest("li")).not.toBeNull();
    const workDone = screen.getByRole("region", { name: "What was done" });
    expect(within(workDone).getByText("pinned").tagName).toBe("STRONG");
    expect(within(workDone).getByText("HTTP_PROXY").tagName).toBe("CODE");
    const notDone = screen.getByRole("region", { name: "Not done or needs further work" });
    expect(within(notDone).getByText("live").tagName).toBe("EM");
  });

  test("renders Markdown throughout decisions, tests, issues and verification", () => {
    const { container } = render(
      <KeyInformationDocument
        keyInformation={{
          ...info,
          decisions: [
            {
              decision: "**Decision title**",
              options: [
                { option: "**Option title**", pros: ["_Pro text_"], cons: ["~~Con text~~"] },
              ],
              chosen: "**Fallback choice**",
              rationale: "Use `scanner`",
            },
          ],
          tests: [
            { name: "focused suite", result: "passed", details: "**Test details** and `command`" },
          ],
          issues: [
            {
              round: 0,
              issue: "**Issue title**",
              resolution: "_Resolution text_",
              status: "resolved",
            },
          ],
          verifications: [
            {
              round: 0,
              passed: true,
              summary: "**Verified summary**",
              checks: [
                {
                  check: "_Check text_",
                  passed: true,
                  details: "Use `verification-code`",
                },
              ],
            },
          ],
        }}
        scrollRef={createRef()}
      />,
    );
    for (const [label, tag, count] of [
      ["Decision title", "STRONG", 1],
      ["Option title", "STRONG", 1],
      ["Pro text", "EM", 1],
      ["Con text", "DEL", 1],
      ["Fallback choice", "STRONG", 1],
      ["scanner", "CODE", 1],
      ["Test details", "STRONG", 2],
      ["command", "CODE", 2],
      ["Issue title", "STRONG", 1],
      ["Resolution text", "EM", 1],
      ["Verified summary", "STRONG", 1],
      ["Check text", "EM", 1],
      ["verification-code", "CODE", 1],
    ] as const) {
      const matches = within(container).getAllByText(label);
      expect(matches).toHaveLength(count);
      for (const match of matches) expect(match.tagName).toBe(tag);
    }
    expect(container.textContent).not.toMatch(/\*\*|~~|`/);
  });

  test("the key information tab shows the summary as paragraphs and bullets", () => {
    render(<KeyInformationDocument keyInformation={info} scrollRef={createRef()} />);
    const summary = screen.getByRole("region", { name: "Summary" });
    expect(summary.querySelectorAll("p")).toHaveLength(2);
    expect(within(summary).getByText("long older text is split by sentence").tagName).toBe("LI");
  });
});
