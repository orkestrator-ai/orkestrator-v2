import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { graphTemplateExportText } from "@orkestrator/protocol/graphs/library";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useGraphDesignerStore } from "@/stores/graphDesignerStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { Environment } from "@/types";
import type { GraphDesignerTabData } from "@/types/paneLayout";
import { GraphDesignerTab } from "./GraphDesignerTab";
import {
  builtInDetail,
  compileResponse,
  listResult,
  userDetail,
} from "./graph-designer.test-fixtures";
import { installReactFlowDomStubs } from "./react-flow.test-support";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

let restoreDom: () => void;
beforeAll(() => {
  restoreDom = installReactFlowDomStubs();
});
afterAll(() => restoreDom());

const ENVIRONMENT_ID = "env-graphs";
const TAB_ID = "graphs-tab";
const pipeline = builtInDetail("build-pipeline");

// A user template that passes the guard but does not compile: Prepare's
// input now wants a decision where Build delivers a workspace.
const brokenTemplate = {
  ...structuredClone(pipeline.template),
  id: "too-many-rounds",
  name: "Too many rounds",
};
delete brokenTemplate.engine;
brokenTemplate.nodes.find((node) => node.id === "prepare")!.inputs![0]!.type = "decision@1";
const broken = userDetail(brokenTemplate);

let userTemplates: ReturnType<typeof userDetail>[] = [];

function installBackend() {
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    const all = [pipeline, ...userTemplates];
    const find = (ref: { scope: string; id?: string }) =>
      all.find((detail) => detail.summary.ref.scope === ref.scope && detail.summary.id === ref.id);
    switch (command) {
      case "graph_templates_list":
        return listResult(all.map((detail) => detail.summary));
      case "graph_template_get":
        return find(args.ref as { scope: string; id: string });
      case "graph_template_compile":
        return compileResponse(find(args.ref as { scope: string; id: string })!.template);
      case "graph_template_import": {
        const text = args.text as string;
        if (!text.includes('"format"')) {
          return {
            ok: false,
            errors: [{ path: "$", code: "invalid_json", message: "Unexpected end of JSON input" }],
            omittedErrors: 0,
          };
        }
        userTemplates = [broken];
        return { ok: true, detail: broken };
      }
      case "graph_template_export":
        return {
          fileName: "x.graph.json",
          text: graphTemplateExportText(pipeline.template),
          digest: "d",
        };
      case "graph_describe_status":
        return null;
      default:
        throw new Error(`unexpected command ${command}`);
    }
  });
  window.orkestrator = { invoke: invokeMock, listen: () => () => undefined } as never;
}

function seedStores(data: GraphDesignerTabData) {
  useGraphDesignerStore.setState({ libraries: new Map(), tabs: new Map() });
  useEnvironmentStore.setState({
    environments: [{ id: ENVIRONMENT_ID, projectId: "project-1" } as Environment],
  });
  usePaneLayoutStore.setState({
    environments: new Map([
      [
        ENVIRONMENT_ID,
        {
          root: {
            kind: "leaf",
            id: "pane-1",
            tabs: [{ id: TAB_ID, type: "graph-designer", graphDesignerData: data }],
            activeTabId: TAB_ID,
          },
          activePaneId: "pane-1",
          containerId: null,
        },
      ],
    ]),
  });
}

function persisted(): GraphDesignerTabData | undefined {
  const root = usePaneLayoutStore.getState().environments.get(ENVIRONMENT_ID)!.root;
  return root.kind === "leaf" ? root.tabs[0]!.graphDesignerData : undefined;
}

function renderTab(data: GraphDesignerTabData = {}) {
  seedStores(data);
  return render(
    <div style={{ width: 1600, height: 1000, position: "relative" }}>
      <GraphDesignerTab tabId={TAB_ID} environmentId={ENVIRONMENT_ID} data={data} isActive />
    </div>,
  );
}

beforeEach(() => {
  userTemplates = [];
  installBackend();
});

afterEach(() => {
  cleanup();
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("GraphDesignerTab", () => {
  test("lists the library for the environment's project and opens a built-in", async () => {
    const { container } = renderTab();
    await screen.findByText(pipeline.summary.name);
    expect(invokeMock.mock.calls).toContainEqual([
      "graph_templates_list",
      { projectId: "project-1" },
    ]);
    expect(
      screen.getByText("Choose a template from the library, or import one as JSON."),
    ).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByText(pipeline.summary.name));
    });
    // The choice is kept in the pane layout, so a reload reopens it.
    expect(persisted()).toEqual({ selected: pipeline.summary.ref });
    await waitFor(() =>
      expect(container.querySelector('[data-graph-node-id="build"]')).not.toBeNull(),
    );
    expect(container.querySelector("[data-graph-compile-clean]")).not.toBeNull();
    expect(container.querySelector("[data-graph-designer-title]")!.textContent).toBe(
      pipeline.summary.name,
    );
    // A built-in is read-only: no JSON editing, but it can be duplicated.
    expect(screen.queryByRole("button", { name: "Edit as JSON" })).toBeNull();
    expect(screen.getByRole("button", { name: /Duplicate/ })).toBeDefined();
  });

  test("rehydrates the template named by the pane layout", async () => {
    const { container } = renderTab({ selected: pipeline.summary.ref });
    await waitFor(() =>
      expect(container.querySelector('[data-graph-node-id="review"]')).not.toBeNull(),
    );
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "graph_template_get"),
    ).toHaveLength(1);
  });

  test("imports JSON: shows refused input's errors, then pins the imported template's diagnostics", async () => {
    const { container } = renderTab();
    await screen.findByText(pipeline.summary.name);
    fireEvent.click(screen.getByRole("button", { name: /Import JSON/ }));
    const dialog = await screen.findByRole("dialog");
    const textarea = within(dialog).getByLabelText("Template JSON");
    fireEvent.change(textarea, { target: { value: "{" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Import" }));
    });
    expect(within(dialog).getByRole("alert").textContent).toContain("Unexpected end of JSON input");

    fireEvent.change(textarea, { target: { value: graphTemplateExportText(brokenTemplate) } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Import" }));
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(persisted()).toEqual({ selected: broken.summary.ref });

    // The imported template opens with its diagnostics pinned to the edge.
    const row = await waitFor(() => {
      const found = container.querySelector('[data-graph-diagnostic="edge-type-mismatch"] button');
      expect(found).not.toBeNull();
      return found!;
    });
    await waitFor(() =>
      expect(container.querySelector(".react-flow__edge.graph-edge-error")).not.toBeNull(),
    );
    await act(async () => {
      fireEvent.click(row);
    });
    const inspector = container.querySelector("[data-graph-inspector]")!;
    expect(inspector.textContent).toContain("Edge build-prepare");
    // A user template can be edited as JSON.
    expect(screen.getByRole("button", { name: "Edit as JSON" })).toBeDefined();
  });

  test("edits a user template as JSON with live browser compile", async () => {
    userTemplates = [broken];
    const { container } = renderTab({ selected: broken.summary.ref });
    await waitFor(() =>
      expect(
        container.querySelector('[data-graph-diagnostic="edge-type-mismatch"]'),
      ).not.toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit as JSON" }));
    const editor = container.querySelector(
      "[data-graph-json-editor] textarea",
    ) as HTMLTextAreaElement;
    expect(editor.value).toBe(graphTemplateExportText(broken.template));
    const fixed = structuredClone(broken.template);
    fixed.nodes.find((node) => node.id === "prepare")!.inputs![0]!.type = "workspace@1";
    fireEvent.change(editor, { target: { value: JSON.stringify(fixed) } });
    await waitFor(() =>
      expect(
        container.querySelector('[data-graph-compile-source="browser"] [data-graph-compile-clean]'),
      ).not.toBeNull(),
    );
  });
});
