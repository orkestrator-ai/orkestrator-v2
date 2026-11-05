import { describe, expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
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
  test("leads with what needs a look, then shows the whole brief", () => {
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

    // Every section of the key information tab follows it.
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

  test("says when nothing was flagged, and when nothing was recorded", () => {
    render(<PipelineNotesView pipeline={build({ phase: "building" })} />);

    expect(screen.getByText("Nothing was flagged for a person to look at.")).toBeTruthy();
    expect(screen.getByText("Nothing has been recorded yet")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Needs a look" }) === null).toBe(true);
  });
});
