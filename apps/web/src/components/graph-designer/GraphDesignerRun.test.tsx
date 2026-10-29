import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import type { GraphTemplateDetail } from "@orkestrator/protocol/graphs/library";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
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

/** The designer's "Run" (item 214): launchable stored templates only, drafts saved first. */

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

let restoreDom: () => void;
beforeAll(() => {
  restoreDom = installReactFlowDomStubs();
});
afterAll(() => restoreDom());

const ENVIRONMENT_ID = "env-graphs";
const TAB_ID = "graphs-tab";
const pipeline = builtInDetail("build-pipeline");

function launchableUser(): GraphTemplateDetail {
  const template = graphTemplateExample("multi-review");
  const detail = userDetail({ ...template, id: "panel-review", name: "Panel review" }, 2);
  return { ...detail, summary: { ...detail.summary, launchable: true } };
}

let userTemplates: GraphTemplateDetail[] = [];

function installBackend() {
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    const all = [pipeline, ...userTemplates];
    const find = (ref: { scope: string; id?: string }) =>
      all.find((detail) => detail.summary.ref.scope === ref.scope && detail.summary.id === ref.id);
    switch (command) {
      case "graph_runs_list":
        return [];
      case "graph_templates_list":
        return listResult(all.map((detail) => detail.summary));
      case "graph_template_get":
        return find(args.ref as { scope: string; id: string });
      case "graph_template_compile":
        return compileResponse(find(args.ref as { scope: string; id: string })!.template);
      case "graph_template_save": {
        const saved = userDetail(args.template as GraphTemplateV1, 3);
        return { ...saved, summary: { ...saved.summary, launchable: true } };
      }
      case "graph_launch_options":
        return new Promise(() => undefined);
      default:
        return undefined;
    }
  });
  window.orkestrator = { invoke: invokeMock, listen: () => () => undefined } as never;
}

function renderTab(data: GraphDesignerTabData) {
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

function runButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /^Run$/ }) as HTMLButtonElement;
}

beforeEach(() => {
  userTemplates = [];
  installBackend();
});

afterEach(() => {
  cleanup();
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("GraphDesignerTab Run", () => {
  test("a built-in on its own engine cannot run", async () => {
    renderTab({ selected: pipeline.summary.ref });
    await screen.findByRole("button", { name: /Duplicate/ });
    await waitFor(() =>
      expect(useGraphDesignerStore.getState().tabs.get(TAB_ID)?.compile).toBeTruthy(),
    );
    expect(runButton().disabled).toBe(true);
  });

  test("a launchable user template opens the launch dialog on it", async () => {
    const detail = launchableUser();
    userTemplates = [detail];
    renderTab({ selected: detail.summary.ref });
    await waitFor(() => expect(runButton().disabled).toBe(false));
    await act(async () => {
      fireEvent.click(runButton());
    });
    await screen.findByRole("dialog");
    expect(
      invokeMock.mock.calls.find(([command]) => command === "graph_launch_options")?.[1],
    ).toEqual({ ref: detail.summary.ref, projectId: "project-1", environmentId: ENVIRONMENT_ID });
    expect(invokeMock.mock.calls.some(([command]) => command === "graph_template_save")).toBe(
      false,
    );
  });

  test("unsaved edits are saved before the launch dialog opens", async () => {
    const detail = launchableUser();
    userTemplates = [detail];
    renderTab({ selected: detail.summary.ref });
    await screen.findByRole("button", { name: "Edit" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() =>
      expect(useGraphDesignerStore.getState().tabs.get(TAB_ID)?.editor).toBeTruthy(),
    );
    act(() => {
      useGraphDesignerStore
        .getState()
        .edit(TAB_ID, "Rename", (template) => ({ ...template, name: "Panel review, edited" }));
    });
    await waitFor(() => expect(runButton().disabled).toBe(false));
    await act(async () => {
      fireEvent.click(runButton());
    });
    await screen.findByRole("dialog");
    const commands = invokeMock.mock.calls.map(([command]) => command);
    const save = commands.indexOf("graph_template_save");
    const options = commands.indexOf("graph_launch_options");
    expect(save).toBeGreaterThanOrEqual(0);
    expect(options).toBeGreaterThan(save);
  });
});
