import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useKanbanStore } from "@/stores/kanbanStore";
import { build, session } from "./pipeline-test-fixture";
import { pipelineCriteriaStatusWord } from "@orkestrator/protocol/build-pipeline-criteria";
import { PipelineTicketView, ticketChangedSinceStart, ticketImageUrl } from "./PipelineTicketView";

const snapshot = {
  title: "Original ticket",
  description: "Stored description",
  acceptanceCriteria: "Stored criteria",
  comments: [{ text: "Stored comment" }],
  images: [
    {
      filename: "reference.bmp",
      data: "Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AA==",
    },
    {
      filename: "reference.svg",
      data: btoa('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'),
    },
  ],
};

afterEach(() => {
  cleanup();
  useKanbanStore.setState({ tasks: [] });
});

describe("pipeline ticket references", () => {
  test.each(["bmp", "svg", "png", "jpg", "webp"])(
    "preserves the stored %s image with an explicit MIME type",
    (extension) => {
      const url = ticketImageUrl({ filename: `reference.${extension}`, data: " YQ==\n" });
      expect(url).toBe(
        `data:image/${extension === "svg" ? "svg+xml" : extension === "jpg" ? "jpeg" : extension};base64,YQ==`,
      );
    },
  );

  test("extensionless clipboard images use the WebP fallback", () => {
    expect(ticketImageUrl({ filename: "clipboard", data: " YQ==\n" })).toBe(
      "data:image/webp;base64,YQ==",
    );
  });

  test("rejects non-base64 content and unknown extensions", () => {
    expect(ticketImageUrl({ filename: "bad.svg", data: "<svg onload=alert(1)>" })).toBeNull();
    expect(ticketImageUrl({ filename: "bad.html", data: "YQ==" })).toBeNull();
  });

  test("shows both BMP and SVG snapshot references and opens their previews", () => {
    render(<PipelineTicketView pipeline={build({ taskSnapshot: snapshot })} />);
    const images = screen.getByRole("region", { name: "Reference images (2)" });
    expect(
      within(images)
        .getAllByRole("img")
        .map((image) => image.getAttribute("alt")),
    ).toEqual(["reference.bmp", "reference.svg"]);
    fireEvent.click(within(images).getByRole("button", { name: "Show image reference.svg" }));
    const preview = screen.getByRole("dialog");
    expect(within(preview).getByRole("img").getAttribute("src")).toBe(
      ticketImageUrl(snapshot.images[1]!),
    );
    fireEvent.click(within(preview).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog") === null).toBe(true);
    fireEvent.click(within(images).getByRole("button", { name: "Show image reference.bmp" }));
    expect(within(screen.getByRole("dialog")).getByRole("img").getAttribute("src")).toBe(
      ticketImageUrl(snapshot.images[0]!),
    );
  });

  test("shows edits to the live ticket while retaining the started-with snapshot", () => {
    useKanbanStore.setState({
      tasks: [
        {
          id: "task-1",
          title: "Edited ticket",
          description: "Live description",
          acceptanceCriteria: "Live criteria",
        },
      ] as never,
    });
    render(<PipelineTicketView pipeline={build({ taskSnapshot: snapshot })} />);
    expect(screen.getByTestId("pipeline-ticket-changed").textContent).toContain("has been edited");
    expect(screen.getByRole("heading", { name: "Original ticket" }).textContent).toBe(
      "Original ticket",
    );
    expect(screen.queryByText("Live description") === null).toBe(true);
    expect(ticketChangedSinceStart(snapshot, undefined)).toBe(false);
    expect(ticketChangedSinceStart(snapshot, { ...snapshot, title: " Original ticket " })).toBe(
      false,
    );
  });

  test("shows the newest live Verify result per criterion, never a superseded one", () => {
    const structured = {
      ...snapshot,
      description: "Summary text\n\n## Problem\n\nIt is a blob.",
      acceptanceCriteria: "- One\n- Two\n- Three",
      acceptanceCriteriaItems: [
        { id: "ac-4", text: "One" },
        { id: "ac-5", text: "Two" },
        { id: "ac-6", text: "Three" },
      ],
    };
    const pipeline = build({
      taskSnapshot: structured,
      sessions: [
        session("verify", "verify-old", 10, {
          acceptanceCriteriaResults: [{ id: "ac-4", status: "failed", evidence: "old" }],
        }),
        session("verify", "verify-new", 20, {
          iteration: 1,
          acceptanceCriteriaResults: [
            { id: "ac-4", status: "passed", evidence: "bun test one" },
            { id: "ac-5", status: "not-checked", evidence: "needs a phone" },
          ],
        }),
        session("verify", "verify-superseded", 30, {
          iteration: 2,
          supersededBy: "rewind-1",
          acceptanceCriteriaResults: [{ id: "ac-4", status: "failed", evidence: "superseded" }],
        }),
      ],
    });
    render(<PipelineTicketView pipeline={pipeline} />);
    expect(screen.getByRole("region", { name: "Problem" }).textContent).toContain("It is a blob.");
    expect(
      screen
        .getAllByTestId("ticket-criterion")
        .map((item) => [item.getAttribute("data-criterion-id"), item.getAttribute("data-status")]),
    ).toEqual([
      ["ac-4", "passed"],
      ["ac-5", "not-checked"],
      ["ac-6", "unchecked"],
    ]);
    expect(screen.getByText("needs a phone", { exact: false })).toBeTruthy();
    expect(screen.getByTestId("pipeline-ticket-verify-round").textContent).toContain("round 2");
    expect(pipelineCriteriaStatusWord(pipeline)).toEqual({ text: "1/3 criteria", tone: "warning" });
    expect(pipelineCriteriaStatusWord(build({ taskSnapshot: structured }))).toBeUndefined();
  });

  test("an old snapshot with no stored criteria ids still lines up with its results", () => {
    const pipeline = build({
      taskSnapshot: { ...snapshot, acceptanceCriteria: "- One\n- Two" },
      sessions: [
        session("verify", "verify", 10, {
          acceptanceCriteriaResults: [
            { id: "ac-1", status: "passed", evidence: "e" },
            { id: "ac-2", status: "failed", evidence: "f" },
          ],
        }),
      ],
    });
    render(<PipelineTicketView pipeline={pipeline} />);
    expect(
      screen.getAllByTestId("ticket-criterion").map((item) => item.getAttribute("data-status")),
    ).toEqual(["passed", "failed"]);
    expect(pipelineCriteriaStatusWord(pipeline)?.tone).toBe("destructive");
  });

  test.each([true, false])(
    "all 120 legacy criteria and full long text remain visible (stored ids: %s)",
    (storedIds) => {
      const long = "Long criterion " + "x".repeat(10_001) + " END";
      const texts = Array.from({ length: 120 }, (_, i) =>
        i === 0 ? long : `Requirement ${i + 1}`,
      );
      const pipeline = build({
        taskSnapshot: {
          ...snapshot,
          acceptanceCriteria: texts.map((text) => `- ${text}`).join("\n"),
          ...(storedIds
            ? {
                acceptanceCriteriaItems: texts
                  .slice(0, 100)
                  .map((text, i) => ({ id: `ac-${i + 40}`, text: text.slice(0, 10_000) })),
              }
            : {}),
        },
        sessions: [
          session("verify", "verify", 10, {
            acceptanceCriteriaResults: texts.slice(0, 100).map((_, i) => ({
              id: `ac-${i + (storedIds ? 40 : 1)}`,
              status: "passed",
              evidence: "Checked",
            })),
          }),
        ],
      });
      render(<PipelineTicketView pipeline={pipeline} />);
      const criteria = screen.getAllByTestId("ticket-criterion");
      expect(criteria).toHaveLength(120);
      expect(criteria[0]?.textContent).toContain(long);
      expect(
        criteria.slice(0, 100).every((item) => item.getAttribute("data-status") === "passed"),
      ).toBe(true);
      expect(
        criteria.slice(100).every((item) => item.getAttribute("data-status") === "unchecked"),
      ).toBe(true);
      expect(new Set(criteria.map((item) => item.getAttribute("data-criterion-id"))).size).toBe(
        120,
      );
    },
  );

  test("an older record without snapshot content explains the missing ticket", () => {
    render(
      <PipelineTicketView
        pipeline={build({ taskSnapshot: { ...snapshot, title: "", description: "" } })}
      />,
    );
    expect(screen.getByTestId("pipeline-ticket-placeholder").textContent).toContain(
      "did not store the ticket",
    );
  });
});
