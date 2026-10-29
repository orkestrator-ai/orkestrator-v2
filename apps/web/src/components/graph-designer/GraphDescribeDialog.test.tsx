import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { GraphDescribeJobView } from "@orkestrator/protocol/graphs/describe";
import type { AgentModelCatalog } from "@/lib/agent-launch";
import { useConfigStore } from "@/stores/configStore";
import { GraphDescribeDialog, type GraphDescribeSubmission } from "./GraphDescribeDialog";

const catalog: AgentModelCatalog = {
  claude: [{ id: "opus", name: "Opus", reasoningEfforts: ["high", "xhigh"] }],
  codex: [{ id: "gpt-5.6", name: "GPT-5.6", reasoningEfforts: ["low", "high"] }],
  opencode: [],
};

function job(overrides: Partial<GraphDescribeJobView> = {}): GraphDescribeJobView {
  return {
    id: "job-1",
    environmentId: "env-1",
    projectId: "project-1",
    status: "running",
    progress: "drafting",
    repairs: 0,
    agent: "codex",
    model: "gpt-5.6",
    description: "Review, judge, fix, open a pull request.",
    modifying: false,
    createdAt: "2026-10-29T00:00:00.000Z",
    updatedAt: "2026-10-29T00:00:00.000Z",
    ...overrides,
  };
}

function renderDialog(overrides: Partial<Parameters<typeof GraphDescribeDialog>[0]> = {}) {
  const onSubmit = mock((_submission: GraphDescribeSubmission) => undefined);
  const onCancelJob = mock(() => undefined);
  const onOpenChange = mock((_open: boolean) => undefined);
  render(
    <GraphDescribeDialog
      open
      onOpenChange={onOpenChange}
      catalog={catalog}
      providers={["claude", "codex"]}
      currentName={null}
      job={null}
      busy={false}
      error={null}
      onSubmit={onSubmit}
      onCancelJob={onCancelJob}
      {...overrides}
    />,
  );
  return { onSubmit, onCancelJob, onOpenChange };
}

function describeButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /^Describe$/ }) as HTMLButtonElement;
}

beforeEach(() => {
  const config = useConfigStore.getState().config;
  useConfigStore.setState({
    config: { ...config, global: { ...config.global, favoriteModels: [] } },
  });
});
afterEach(cleanup);

describe("GraphDescribeDialog", () => {
  test("submits the description with the first enabled provider's model", () => {
    const { onSubmit } = renderDialog();
    expect(describeButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("What should the graph do?"), {
      target: { value: "  Three lens reviewers, a judge and a fixer.  " },
    });
    expect(describeButton().disabled).toBe(false);
    fireEvent.click(describeButton());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({
      description: "Three lens reviewers, a judge and a fixer.",
      selection: { agent: "claude", model: "opus" },
      modify: false,
    });
  });

  test("offers to modify the current draft only when there is one", () => {
    renderDialog();
    const box = screen.getByRole("checkbox", { name: "Modify the current draft" });
    expect(box.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/open or start a graph first/)).toBeDefined();
    cleanup();

    const { onSubmit } = renderDialog({ currentName: "Design bake-off" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Modify the current draft" }));
    fireEvent.change(screen.getByLabelText("What should the graph do?"), {
      target: { value: "Add a human approval before the build." },
    });
    fireEvent.click(describeButton());
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ modify: true });
    expect(screen.getByText("(Design bake-off)")).toBeDefined();
  });

  test("bounds the description", () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("What should the graph do?"), {
      target: { value: "x".repeat(8_001) },
    });
    expect(describeButton().disabled).toBe(true);
    expect(screen.getByText("At most 8000 characters.")).toBeDefined();
  });

  test("shows a running job's progress instead of the form, and cancels it", () => {
    const { onCancelJob, onOpenChange } = renderDialog({
      job: job({ progress: "correcting", repairs: 1 }),
    });
    expect(screen.queryByLabelText("What should the graph do?") === null).toBe(true);
    expect(screen.getByRole("status").textContent).toContain(
      "Correcting the draft the compiler refused…",
    );
    expect(screen.getByText(/Repair turns so far: 1/)).toBeDefined();
    expect(screen.getByText(/keeps working if you close this dialog or switch tabs/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));
    expect(onCancelJob).toHaveBeenCalledTimes(1);
    // The dialog's own corner button is also named Close; this is the footer's.
    const close = screen
      .getAllByRole("button", { name: "Close" })
      .find((button) => button.textContent === "Close")!;
    fireEvent.click(close);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("offers a failed request again, with its error", () => {
    const { onSubmit } = renderDialog({
      job: job({
        status: "failed",
        progress: undefined,
        error: "The designer agent session failed",
      }),
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "The last request failed: The designer agent session failed",
    );
    const text = screen.getByLabelText("What should the graph do?") as HTMLTextAreaElement;
    expect(text.value).toBe("Review, judge, fix, open a pull request.");
    fireEvent.click(describeButton());
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({
      selection: { agent: "codex", model: "gpt-5.6" },
    });
  });

  test("shows the backend's refusal and the busy state", () => {
    renderDialog({ error: "Start the environment first", busy: true });
    expect(screen.getByRole("alert").textContent).toBe("Start the environment first");
    expect(screen.getByRole("button", { name: /Starting/ }).hasAttribute("disabled")).toBe(true);
  });
});
