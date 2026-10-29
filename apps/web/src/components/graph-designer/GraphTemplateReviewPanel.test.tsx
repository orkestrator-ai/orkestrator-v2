import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { compile } from "@orkestrator/protocol/graphs/compile";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import {
  graphTemplateCapabilitySummary,
  type GraphProjectTemplateReview,
  type GraphProjectTemplateReviewItem,
} from "@orkestrator/protocol/graphs/sharing";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { GraphTemplateReviewPanel } from "./GraphTemplateReviewPanel";
import { fixtureSummary } from "./graph-designer.test-fixtures";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

const template = { ...graphTemplateExample("build-pipeline-loop"), id: "from-repo" };
const PATH = ".orkestrator/graphs/review.graph.json";
const OTHER = ".orkestrator/graphs/other.graph.json";

function item(
  path: string,
  patch: Partial<GraphProjectTemplateReviewItem> = {},
): GraphProjectTemplateReviewItem {
  const ref = { scope: "project" as const, projectId: "p", path };
  const summary = fixtureSummary(template, ref);
  return {
    ref,
    path,
    templateId: template.id,
    name: `Template at ${path.slice(20)}`,
    trust: "untrusted",
    digest: `${"a".repeat(63)}${path.length % 10}`,
    compile: summary.compile,
    capabilities: graphTemplateCapabilitySummary(template, compile(template)),
    diff: null,
    diffUnavailable: "never-approved",
    ...patch,
  };
}

const changed = item(PATH, {
  trust: "changed",
  approvedDigest: "b".repeat(64),
  approvedAt: "2026-10-29T00:00:00.000Z",
  diffUnavailable: undefined,
  diff: {
    fromDigest: "b".repeat(64),
    additions: 1,
    deletions: 1,
    truncated: false,
    hunks: [
      {
        header: "@@ -3,1 +3,1 @@",
        oldStart: 3,
        oldLines: 1,
        newStart: 3,
        newLines: 1,
        lines: [
          { type: "remove", text: '  "description": "Old",\n', oldLine: 3, newLine: null },
          {
            type: "add",
            text: '  "description": "Now with network",\n',
            oldLine: null,
            newLine: 3,
          },
        ],
      },
    ],
  },
});

let reviews: GraphProjectTemplateReview[] = [];
let decideError: Error | null = null;

function review(items: GraphProjectTemplateReviewItem[]): GraphProjectTemplateReview {
  return {
    projectId: "p",
    source: {
      projectId: "p",
      status: "ok",
      directory: ".orkestrator/graphs",
      files: items.length,
      truncated: false,
      problems: [],
    },
    items,
  };
}

beforeEach(() => {
  decideError = null;
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case "graph_project_template_review":
        return reviews.length > 1 ? reviews.shift() : reviews[0];
      case "graph_project_template_review_decide":
        if (decideError) throw decideError;
        return { ...args, trust: args.decision === "approve" ? "trusted" : "untrusted" };
      default:
        throw new Error(`unexpected command ${command}`);
    }
  });
  window.orkestrator = { invoke: invokeMock, listen: () => () => undefined } as never;
});

afterEach(cleanup);

function calls(command: string) {
  return invokeMock.mock.calls.filter(([name]) => name === command);
}

describe("GraphTemplateReviewPanel", () => {
  test("lists templates needing review with capabilities, a diff and rejected ones last", async () => {
    reviews = [review([changed, item(OTHER, { rejectedAt: "2026-10-29T01:00:00.000Z" })])];
    const { container } = render(<GraphTemplateReviewPanel projectId="p" />);
    const article = await screen.findByRole("article", { name: `Review ${changed.name}` });
    expect(article.textContent).toContain("Changed since it was approved");
    expect(within(article).getByLabelText("What this template may do")).toBeDefined();
    expect(article.querySelector('[data-diff-line="add"]')?.textContent).toContain(
      "Now with network",
    );
    expect(article.querySelector('[data-diff-line="remove"]')?.textContent).toContain("Old");
    // System actions with side effects are called out.
    expect(article.querySelector("[data-graph-capability-action]")).not.toBeNull();
    const rejected = screen.getByRole("region", { name: "Rejected" });
    expect(within(rejected).getByText(/rejected 2026-10-29T01:00/)).toBeDefined();
    expect(within(rejected).getByText(/Never approved/)).toBeDefined();
    expect(container.querySelector("[data-graph-review-empty]") === null).toBe(true);
  });

  test("approve sends the reviewed digest, then re-reads the snapshot", async () => {
    reviews = [review([changed]), review([])];
    const decided = mock();
    render(<GraphTemplateReviewPanel projectId="p" onDecided={decided} />);
    const approve = await screen.findByRole("button", { name: `Approve ${changed.name}` });
    await act(async () => {
      fireEvent.click(approve);
    });
    expect(calls("graph_project_template_review_decide")[0]?.[1]).toEqual({
      projectId: "p",
      path: PATH,
      digest: changed.digest,
      decision: "approve",
    });
    await waitFor(() =>
      expect(screen.getByText("Every project template is approved.")).toBeDefined(),
    );
    expect(decided).toHaveBeenCalledWith("approve", changed);
  });

  test("reject sends the reviewed digest", async () => {
    reviews = [review([changed])];
    render(<GraphTemplateReviewPanel projectId="p" />);
    const button = await screen.findByRole("button", { name: `Reject ${changed.name}` });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(calls("graph_project_template_review_decide")[0]?.[1]).toMatchObject({
      decision: "reject",
      digest: changed.digest,
    });
  });

  test("a refused decision is shown and the list re-read", async () => {
    reviews = [review([changed])];
    decideError = new Error("The project template changed since you reviewed it; review it again");
    render(<GraphTemplateReviewPanel projectId="p" />);
    const button = await screen.findByRole("button", { name: `Approve ${changed.name}` });
    await act(async () => {
      fireEvent.click(button);
    });
    expect((await screen.findByRole("alert")).textContent).toContain("changed since you reviewed");
    expect(calls("graph_project_template_review").length).toBeGreaterThanOrEqual(2);
  });

  test("says when the project has no checkout", async () => {
    reviews = [
      {
        ...review([]),
        source: { ...review([]).source, status: "no-checkout" },
      },
    ];
    render(<GraphTemplateReviewPanel projectId="p" />);
    expect(await screen.findByText(/no local checkout/)).toBeDefined();
  });
});
