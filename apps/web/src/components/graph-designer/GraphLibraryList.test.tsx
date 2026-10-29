import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import type { GraphTemplateSummary } from "@orkestrator/protocol/graphs/library";
import type { GraphDesignerLibrary } from "@/stores/graphDesignerStore";
import { GraphLibraryList } from "./GraphLibraryList";
import {
  builtInDetail,
  fixtureSummary,
  listResult,
  userDetail,
} from "./graph-designer.test-fixtures";

afterEach(cleanup);

const pipeline = builtInDetail("build-pipeline").summary;
const looped = builtInDetail("looped-review").summary;
const mine = userDetail(graphTemplateExample("multi-review")).summary;

function project(trust: GraphTemplateSummary["trust"], path: string): GraphTemplateSummary {
  return fixtureSummary(
    { ...graphTemplateExample("multi-review"), id: path.slice(20, -11) },
    { scope: "project", projectId: "p", path },
    { trust, ...(trust === "trusted" ? { approvedAt: "2026-10-29T00:00:00Z" } : {}) },
  );
}

function library(
  templates: GraphTemplateSummary[],
  status: GraphDesignerLibrary["status"] = "ready",
) {
  return {
    status,
    error: null,
    result: listResult(templates, {
      projectId: "p",
      status: "ok",
      directory: ".orkestrator/graphs",
      files: 3,
      truncated: false,
      problems: [
        {
          path: ".orkestrator/graphs/broken.graph.json",
          code: "invalid-template",
          message: "nodes must be an array",
        },
      ],
    }),
  } satisfies GraphDesignerLibrary;
}

function renderList(
  templates: GraphTemplateSummary[],
  overrides: Partial<Parameters<typeof GraphLibraryList>[0]> = {},
) {
  const onOpen = mock((_summary: GraphTemplateSummary) => {});
  const onTrust = mock((_summary: GraphTemplateSummary, _action: "approve" | "revoke") => {});
  render(
    <GraphLibraryList
      library={library(templates)}
      selected={null}
      hasProject
      onOpen={onOpen}
      onRefresh={() => {}}
      onTrust={onTrust}
      trustBusy={null}
      {...overrides}
    />,
  );
  return { onOpen, onTrust };
}

describe("GraphLibraryList", () => {
  test("groups built-in, user and project templates", () => {
    renderList([pipeline, looped, mine, project("trusted", ".orkestrator/graphs/ok.graph.json")]);
    const builtIns = screen.getByRole("region", { name: "Built-in templates" });
    expect(within(builtIns).getByText(pipeline.name)).toBeDefined();
    expect(within(builtIns).getByText(looped.name)).toBeDefined();
    const yours = screen.getByRole("region", { name: "Your templates" });
    expect(within(yours).getByText(mine.name)).toBeDefined();
    const projectSection = screen.getByRole("region", { name: "Project templates" });
    expect(within(projectSection).getByText(".orkestrator/graphs/ok.graph.json")).toBeDefined();
    // Files the backend refused are listed by path and reason, never content.
    expect(within(projectSection).getByText(/nodes must be an array/)).toBeDefined();
  });

  test("shows each built-in's engine, and marks a retired one", () => {
    const { container } = render(
      <GraphLibraryList
        library={library([pipeline, looped])}
        selected={null}
        hasProject={false}
        onOpen={() => {}}
        onRefresh={() => {}}
        onTrust={() => {}}
        trustBusy={null}
      />,
    );
    const statuses = Array.from(container.querySelectorAll("[data-graph-engine-status]")).map(
      (badge) => [badge.getAttribute("data-graph-engine-status"), badge.textContent],
    );
    expect(statuses).toEqual([
      ["active", "Build Pipeline engine"],
      ["retired", "Retired engine"],
    ]);
    // Without a project there is no project section.
    expect(screen.queryByRole("region", { name: "Project templates" })).toBeNull();
  });

  test("shows trust state with approve and revoke for project templates", () => {
    const untrusted = project("untrusted", ".orkestrator/graphs/new.graph.json");
    const changed = project("changed", ".orkestrator/graphs/edited.graph.json");
    const trusted = project("trusted", ".orkestrator/graphs/ok.graph.json");
    const { onTrust } = renderList([untrusted, changed, trusted]);
    const badges = Array.from(document.querySelectorAll("[data-graph-trust]")).map((badge) =>
      badge.getAttribute("data-graph-trust"),
    );
    expect(badges).toEqual(["untrusted", "changed", "trusted"]);
    const approve = screen.getAllByRole("button", { name: "Approve" });
    expect(approve).toHaveLength(2);
    fireEvent.click(approve[0]!);
    expect(onTrust).toHaveBeenLastCalledWith(untrusted, "approve");
    fireEvent.click(screen.getByRole("button", { name: "Revoke trust" }));
    expect(onTrust).toHaveBeenLastCalledWith(trusted, "revoke");
  });

  test("opens a template and marks the one shown", () => {
    const { onOpen } = renderList([pipeline, mine], { selected: mine.ref });
    fireEvent.click(screen.getByText(pipeline.name));
    expect(onOpen).toHaveBeenCalledWith(pipeline);
    const current = screen.getByText(mine.name).closest("button")!;
    expect(current.getAttribute("aria-current")).toBe("true");
  });

  test("shows compile counts and a load error", () => {
    const failing = { ...mine, compile: { ...mine.compile, errors: 2, warnings: 1 } };
    render(
      <GraphLibraryList
        library={{ status: "error", error: "backend offline", result: listResult([failing]) }}
        selected={null}
        hasProject={false}
        onOpen={() => {}}
        onRefresh={() => {}}
        onTrust={() => {}}
        trustBusy={null}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("backend offline");
    expect(screen.getByText("2 err")).toBeDefined();
    expect(screen.getByText("1 warn")).toBeDefined();
  });
});
