import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AgentModelCatalog } from "@/lib/agent-launch";
import { MultiReviewLaunchDialog, type MultiReviewLaunchSelection } from "./MultiReviewLaunchDialog";

const catalog: AgentModelCatalog = {
  claude: [{ id: "opus", name: "Opus", reasoningEfforts: ["high"] }],
  codex: [{ id: "gpt-5.6", name: "GPT-5.6", reasoningEfforts: ["medium", "high"] }],
  opencode: [{ id: "provider/model", name: "OpenCode", reasoningEfforts: [] }],
};

afterEach(cleanup);

describe("MultiReviewLaunchDialog", () => {
  test("adds and removes reviewer model rows while retaining at least one", () => {
    const onConfirm = mock((_selection: MultiReviewLaunchSelection) => undefined);
    render(<MultiReviewLaunchDialog
      open
      onOpenChange={() => undefined}
      defaultAgent="claude"
      catalog={catalog}
      onConfirm={onConfirm}
    />);

    expect(screen.getByLabelText("Reviewer 1 model")).toBeTruthy();
    expect(screen.getByLabelText("Reviewer 2 model")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    expect(screen.getByLabelText("Reviewer 3 model")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove reviewer 2" }));
    expect(screen.queryByLabelText("Reviewer 3 model") === null).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Start 2-model review" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0]?.[0]).toMatchObject({
      reviewers: [
        { agent: "claude", model: "opus" },
        { agent: "claude", model: "opus" },
      ],
      fixModel: { agent: "claude", model: "opus" },
    });
  });
});
