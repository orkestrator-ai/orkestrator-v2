import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import type { GraphTemplateDetail } from "@orkestrator/protocol/graphs/library";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { onGraphRunViewRequested, type GraphRunViewRequest } from "@/lib/graph-run-navigation";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useGraphDesignerStore } from "@/stores/graphDesignerStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { Environment } from "@/types";
import type { GraphDesignerTabData } from "@/types/paneLayout";
import { GRAPH_DESIGNER_MOCK_STEP_MS, GraphDesignerTab } from "./GraphDesignerTab";
import {
  builtInDetail,
  compileResponse,
  listResult,
  userDetail,
} from "./graph-designer.test-fixtures";
import { installReactFlowDomStubs } from "./react-flow.test-support";

/**
 * The designer's "Mock run" (item 213): it launches the stored template
 * (saving an unsaved draft first) through `graph_run_mock` and asks the run
 * view to open the run; a built-in must be duplicated first.
 */

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

let restoreDom: () => void;
beforeAll(() => {
  restoreDom = installReactFlowDomStubs();
});
afterAll(() => restoreDom());

const ENVIRONMENT_ID = "env-graphs";
const TAB_ID = "graphs-tab";
const pipeline = builtInDetail("build-pipeline");

function loop(): GraphTemplateV1 {
  return { ...graphTemplateExample("build-pipeline-loop"), id: "my-loop" };
}

let userTemplates: GraphTemplateDetail[] = [];
let requests: GraphRunViewRequest[] = [];
let stopListening: () => void = () => undefined;

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
      case "graph_template_save": {
        const saved = userDetail(args.template as GraphTemplateV1, 2);
        userTemplates = [saved];
        return saved;
      }
      case "graph_run_mock":
        return {
          run: {
            id: "11111111-2222-3333-4444-555555555555",
            projectId: args.projectId,
            status: "running",
            mock: true,
            template: { id: "my-loop", revision: 2, digest: "a".repeat(64), scope: "user" },
            createdAt: "2026-10-29T00:00:00.000Z",
          },
          pins: null,
          exampleInputs: ["ticket", "target"],
          placeholderRoles: ["builder"],
        };
      default:
        throw new Error(`unexpected command ${command}`);
    }
  });
  window.orkestrator = { invoke: invokeMock, listen: () => () => undefined } as never;
}

function renderTab(data: GraphDesignerTabData = {}) {
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
  return render(
    <div style={{ width: 1600, height: 1000, position: "relative" }}>
      <GraphDesignerTab tabId={TAB_ID} environmentId={ENVIRONMENT_ID} data={data} isActive />
    </div>,
  );
}

function commands(): string[] {
  return invokeMock.mock.calls.map(([command]) => command as string);
}

function mockButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /Mock run/ }) as HTMLButtonElement;
}

beforeEach(() => {
  userTemplates = [];
  requests = [];
  stopListening = onGraphRunViewRequested((request) => {
    requests.push(request);
    return true;
  });
  installBackend();
});

afterEach(() => {
  stopListening();
  cleanup();
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("GraphDesignerTab mock run", () => {
  test("launches the stored template and asks the run view to open the run", async () => {
    const detail = userDetail(loop(), 1);
    userTemplates = [detail];
    renderTab({ selected: detail.summary.ref });
    await screen.findByRole("button", { name: "Edit" });
    await waitFor(() => expect(mockButton().disabled).toBe(false));
    await act(async () => {
      fireEvent.click(mockButton());
    });
    await waitFor(() => expect(commands()).toContain("graph_run_mock"));
    const call = invokeMock.mock.calls.find(([command]) => command === "graph_run_mock")!;
    expect(call[1]).toEqual({
      ref: detail.summary.ref,
      projectId: "project-1",
      stepMs: GRAPH_DESIGNER_MOCK_STEP_MS,
    });
    expect(commands()).not.toContain("graph_template_save");
    await waitFor(() =>
      expect(requests).toEqual([
        {
          runId: "11111111-2222-3333-4444-555555555555",
          projectId: "project-1",
          environmentId: ENVIRONMENT_ID,
          mock: true,
          title: "Build Pipeline loop",
        },
      ]),
    );
  });

  test("saves an unsaved draft first, then mocks the saved template", async () => {
    const detail = userDetail(loop(), 1);
    userTemplates = [detail];
    const view = renderTab({ selected: detail.summary.ref });
    await screen.findByRole("button", { name: "Edit" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() =>
      expect(view.container.querySelector("[data-graph-editor-toolbar]")).not.toBeNull(),
    );
    fireEvent.change(screen.getByLabelText("Template name") as HTMLInputElement, {
      target: { value: "Renamed loop" },
    });
    await act(async () => {
      fireEvent.click(mockButton());
    });
    await waitFor(() => expect(commands()).toContain("graph_run_mock"));
    const order = commands().filter(
      (command) => command === "graph_template_save" || command === "graph_run_mock",
    );
    expect(order).toEqual(["graph_template_save", "graph_run_mock"]);
    const save = invokeMock.mock.calls.find(([command]) => command === "graph_template_save")!;
    expect((save[1] as { template: GraphTemplateV1 }).template.name).toBe("Renamed loop");
  });

  test("a built-in cannot be mocked until it is duplicated", async () => {
    renderTab({ selected: pipeline.summary.ref });
    await screen.findByRole("button", { name: /Duplicate/ });
    await waitFor(() => expect(mockButton().title).toContain("duplicate it"));
    expect(mockButton().disabled).toBe(true);
  });
});
