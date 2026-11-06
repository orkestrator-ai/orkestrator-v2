import { describe, expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { emptyKeyInformation } from "@orkestrator/protocol/build-pipeline-key-information";
import { keyInformation } from "./key-information-test-fixture";
import { build, session } from "./pipeline-test-fixture";
import { PipelineNotesView } from "./PipelineNotesView";

const taskSnapshot = {
  title: "Ticket",
  description: "",
  acceptanceCriteria: "",
  comments: [],
  images: [],
  acceptanceCriteriaItems: [{ id: "ac-1", text: "Works on a real phone" }],
};

describe("PipelineNotesView", () => {
  test("shows what needs a look under the summary, then the rest of the brief", () => {
    render(
      <PipelineNotesView
        pipeline={build({
          phase: "complete",
          taskSnapshot,
          keyInformation,
          sessions: [
            session("verify", "verify-1", 0, {
              acceptanceCriteriaResults: [
                { id: "ac-1", status: "not-checked", evidence: "Needs a device." },
              ],
            }),
          ],
        })}
      />,
    );

    const flagged = within(screen.getByRole("region", { name: "Needs a look" }));
    expect(flagged.getByText("Works on a real phone")).toBeTruthy();
    expect(flagged.getByText("Needs a device.")).toBeTruthy();
    expect(flagged.getByText("Rich text formatting")).toBeTruthy();
    expect(flagged.getByText("mise run test:browser")).toBeTruthy();

    expect(
      screen
        .getAllByRole("region")
        .slice(0, 3)
        .map((region) => region.getAttribute("aria-label")),
    ).toEqual(["Summary", "Needs a look", "Objective"]);

    // Outlined in orange, with no shading behind it.
    const outline = screen.getByRole("region", { name: "Needs a look" }).classList;
    expect(outline.contains("border-amber-500/30")).toBe(true);
    expect(Array.from(outline).some((name) => name.startsWith("bg-"))).toBe(false);

    // Every section of the key information tab is still there.
    for (const title of [
      "Objective",
      "Context",
      "Solution",
      "What was done",
      "Decisions",
      "Not done or needs further work",
      "Tests",
      "Review issues",
      "Verification",
      "Update history",
    ]) {
      const headings = screen
        .getAllByRole("heading", { name: new RegExp(`^${title}`) })
        .filter((heading) => !heading.closest('[aria-label="Needs a look"]'));
      expect(headings).toHaveLength(1);
    }
  });

  test("shows what needs a look ahead of a brief with no summary", () => {
    const withoutSummary = { ...keyInformation };
    delete withoutSummary.summary;
    render(
      <PipelineNotesView pipeline={build({ phase: "complete", keyInformation: withoutSummary })} />,
    );

    expect(screen.getAllByRole("region")[0]!.getAttribute("aria-label")).toBe("Needs a look");
  });

  test("shows what needs a look when no brief was recorded", () => {
    render(
      <PipelineNotesView
        pipeline={build({
          phase: "complete",
          taskSnapshot,
          sessions: [
            session("verify", "verify-1", 0, {
              acceptanceCriteriaResults: [{ id: "ac-1", status: "not-checked", evidence: "" }],
            }),
          ],
        })}
      />,
    );

    const flagged = within(screen.getByRole("region", { name: "Needs a look" }));
    expect(flagged.getByText("Works on a real phone")).toBeTruthy();
    expect(screen.getByText("Nothing has been recorded yet")).toBeTruthy();
  });

  test("shows the nothing-flagged note between the summary and the rest of a recorded brief", () => {
    render(
      <PipelineNotesView
        pipeline={build({
          phase: "building",
          keyInformation: {
            ...emptyKeyInformation("2026-11-05T00:00:00.000Z"),
            summary: "The recorded summary.",
            statement: "The recorded objective.",
            framing: "objective",
          },
        })}
      />,
    );

    const summary = screen.getByRole("region", { name: "Summary" });
    const note = screen.getByText("Nothing was flagged for a person to look at.");
    const objective = screen.getByRole("region", { name: "Objective" });
    expect(summary.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(note.compareDocumentPosition(objective) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Needs a look" }) === null).toBe(true);
    expect(screen.queryByText("Nothing has been recorded yet") === null).toBe(true);
  });

  test("says when nothing was flagged, and when nothing was recorded", () => {
    render(<PipelineNotesView pipeline={build({ phase: "building" })} />);

    expect(screen.getByText("Nothing was flagged for a person to look at.")).toBeTruthy();
    expect(screen.getByText("Nothing has been recorded yet")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Needs a look" }) === null).toBe(true);
  });
});
