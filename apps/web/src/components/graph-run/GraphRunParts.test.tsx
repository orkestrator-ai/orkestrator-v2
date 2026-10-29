import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useEffect } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { graphRunSummary } from "@orkestrator/protocol/graphs/run-view";
import {
  TerminalProvider,
  useTerminalContext,
  type CreatableTabType,
  type CreateTabOptions,
} from "@/contexts/TerminalContext";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { useGraphRunStore } from "@/stores/graphRunStore";
import { graphArtifactRendering, graphArtifactTypeDefinition } from "./GraphArtifactView";
import { GraphQuestionAnswerForm } from "./GraphQuestionAnswerForm";
import { GraphRunsList } from "./GraphRunsList";
import { examplePlan, runOf } from "./graph-run.test-fixtures";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

afterEach(() => {
  cleanup();
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("artifact rendering by type", () => {
  const plan = examplePlan("multi-review");

  test("a type's markdown template renders over the value", () => {
    const workspace = graphArtifactTypeDefinition(plan, "workspace@1");
    expect(workspace?.ref).toBe("workspace@1");
    const rendered = graphArtifactRendering(workspace, {
      branch: "feature",
      headRef: "abc",
      baseRef: null,
    });
    expect(rendered).toEqual({ kind: "markdown", text: "Branch `feature` at `abc`" });
  });

  test("summary fields render when there is no markdown template", () => {
    const definition = {
      ...graphArtifactTypeDefinition(plan, "workspace@1")!,
      render: { summary: ["branch", "missing"] },
    };
    expect(graphArtifactRendering(definition, { branch: "feature" })).toEqual({
      kind: "summary",
      rows: [
        { field: "branch", text: "feature" },
        { field: "missing", text: "—" },
      ],
    });
  });

  test("anything else renders as JSON; a review report uses the review view", () => {
    expect(graphArtifactRendering(null, { a: 1 })).toEqual({
      kind: "json",
      text: '{\n  "a": 1\n}',
    });
    const report = graphArtifactTypeDefinition(plan, "review-report@1");
    expect(report?.formatter).toBe("structured-review-report");
    expect(graphArtifactRendering(report, report?.example).kind).toBe("review-report");
    // A value that is not a valid report falls back rather than failing the view.
    expect(graphArtifactRendering(report, { nope: true }).kind).not.toBe("review-report");
  });
});

describe("GraphQuestionAnswerForm", () => {
  const question = { id: "q-1", text: "Ship it?", choices: ["Yes", "No"] };

  test("declines without a choice, and keeps the draft when the backend refuses", async () => {
    const onSubmit = mock(async () => {
      throw new Error("The question was already answered");
    });
    render(<GraphQuestionAnswerForm question={question} asker="Fix" onSubmit={onSubmit} />);
    expect(screen.getByRole("heading", { name: "Fix asks" })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Not today" } });
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("already answered");
    expect(onSubmit).toHaveBeenCalledWith({ kind: "declined", text: "Not today" });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Not today");
  });

  test("an empty answer is caught before sending; an answered question shows its answer", () => {
    const onSubmit = mock(async () => {});
    const { rerender } = render(
      <GraphQuestionAnswerForm question={question} asker="Fix" onSubmit={onSubmit} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    expect(screen.getByRole("alert").textContent).toContain("Choose an option");
    expect(onSubmit).not.toHaveBeenCalled();
    rerender(
      <GraphQuestionAnswerForm
        question={{
          ...question,
          answer: { kind: "answered", choice: "Yes", at: "2026-10-29T10:00:00.000Z", by: "user" },
        }}
        asker="Fix"
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByRole("heading", { name: "Fix asked" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send answer" })).toBeNull();
    expect(screen.getByText("Yes")).toBeTruthy();
  });
});

describe("GraphRunsList", () => {
  let createTab: ReturnType<typeof mock>;
  function Register() {
    const { setCreateTab } = useTerminalContext();
    useEffect(() => {
      setCreateTab((type: CreatableTabType, options?: CreateTabOptions) => {
        createTab(type, options);
        return true;
      });
    }, [setCreateTab]);
    return null;
  }

  beforeEach(() => {
    createTab = mock(() => true);
    useGraphRunStore.setState({
      runs: new Map(),
      lists: new Map(),
      transcripts: new Map(),
      artifacts: new Map(),
    });
  });

  test("lists the environment's runs and opens one in its own tab", async () => {
    const run = runOf("multi-review", { mock: true, status: "waiting" });
    invokeMock.mockImplementation(async (command: string) =>
      command === "graph_runs_list" ? [graphRunSummary(run)] : undefined,
    );
    window.orkestrator = { invoke: invokeMock, listen: () => () => undefined } as never;
    render(
      <TerminalProvider>
        <Register />
        <GraphRunsList environmentId="env-1" />
      </TerminalProvider>,
    );
    const row = await waitFor(() => {
      const found = document.querySelector('[data-graph-run-row="run-1"]');
      if (!found) throw new Error("no row");
      return found as HTMLElement;
    });
    expect(row.textContent).toContain("Multi Review");
    expect(row.textContent).toContain("mock");
    expect(row.textContent).toContain("waiting for you");
    fireEvent.click(row);
    expect(createTab).toHaveBeenCalledWith("graph-run", {
      graphRun: { runId: "run-1", title: "Multi Review" },
    });
  });

  test("says when there are no runs", async () => {
    invokeMock.mockImplementation(async () => []);
    window.orkestrator = { invoke: invokeMock, listen: () => () => undefined } as never;
    render(<GraphRunsList environmentId="env-2" />);
    await waitFor(() =>
      expect(screen.getByTestId("graph-runs-empty").textContent).toContain("No graph runs"),
    );
  });
});
