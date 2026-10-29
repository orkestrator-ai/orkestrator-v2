import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import type { GraphTemplateDetail } from "@orkestrator/protocol/graphs/library";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { graphDesignerTab, useGraphDesignerStore } from "@/stores/graphDesignerStore";
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

/**
 * The editable designer end to end in the tab (item 212): new graph, palette,
 * undo and redo, keyboard commands, saving with compare-and-swap and the
 * conflict's "Save as copy", and taint acknowledgements.
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

/** The bake-off without its sub-graph, and without the acknowledgements. */
function bakeOff(): GraphTemplateV1 {
  const template = graphTemplateExample("design-bake-off");
  template.nodes = template.nodes.filter((node) => node.id !== "review");
  template.edges = template.edges.filter(
    (edge) => edge.id !== "build-review" && !edge.id.startsWith("review-"),
  );
  template.edges.push(
    {
      id: "build-describe",
      from: { node: "build", port: "code" },
      to: { node: "describe-pr", port: "code" },
    },
    { id: "build-pr", from: { node: "build", port: "code" }, to: { node: "pr", port: "code" } },
  );
  template.roles = template.roles.filter((role) =>
    ["designer", "judge", "builder", "describer"].includes(role.key),
  );
  template.limits.maxAgentSessions = 6;
  delete template.acknowledgements;
  return template;
}

let userTemplates: GraphTemplateDetail[] = [];
let saveHandler: (args: Record<string, unknown>) => unknown = () => {
  throw new Error("no save expected");
};

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
      case "graph_template_save":
        return saveHandler(args);
      case "graph_template_import": {
        const template = JSON.parse(args.text as string) as GraphTemplateV1;
        const detail = userDetail({ ...template, id: `${template.id}-1` }, 1);
        userTemplates = [...userTemplates, detail];
        return { ok: true, detail };
      }
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

function draft(): GraphTemplateV1 {
  return graphDesignerTab(TAB_ID).editor!.draft;
}

async function openForEditing(detail: GraphTemplateDetail) {
  userTemplates = [detail];
  const view = renderTab({ selected: detail.summary.ref });
  await screen.findByRole("button", { name: "Edit" });
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  await waitFor(() =>
    expect(view.container.querySelector("[data-graph-editor-toolbar]")).not.toBeNull(),
  );
  return view;
}

beforeEach(() => {
  userTemplates = [];
  saveHandler = () => {
    throw new Error("no save expected");
  };
  installBackend();
});

afterEach(() => {
  cleanup();
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("GraphDesignerTab editing", () => {
  test("New graph: add from the palette, then undo and redo with the toolbar and the keyboard", async () => {
    const { container } = renderTab();
    await screen.findByText(pipeline.summary.name);
    fireEvent.click(screen.getByRole("button", { name: /New graph/ }));
    await waitFor(() => expect(container.querySelector("[data-graph-palette]")).not.toBeNull());
    expect(container.querySelector("[data-graph-designer-title]")!.textContent).toBe("New graph");
    expect(container.querySelector('[data-graph-draft-state="dirty"]')).not.toBeNull();
    // The empty canvas still shows both ends, with a + output handle.
    expect(
      container.querySelector('[data-graph-io="outputs"] [data-graph-port="in:+"]'),
    ).not.toBeNull();

    const palette = within(container.querySelector("[data-graph-palette]") as HTMLElement);
    await act(async () => {
      fireEvent.click(palette.getByRole("button", { name: /Agent/ }));
    });
    await waitFor(() =>
      expect(container.querySelector('[data-graph-node-id="agent"]')).not.toBeNull(),
    );
    // The new node is selected: its form opens.
    expect(container.querySelector('[data-graph-node-editor="agent"]')).not.toBeNull();
    expect(draft().nodes.map((node) => node.id)).toEqual(["agent"]);

    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
    expect(draft().nodes).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /Redo/ }));
    expect(draft().nodes.map((node) => node.id)).toEqual(["agent"]);

    const root = container.querySelector("[data-graph-designer]")!;
    fireEvent.keyDown(root, { key: "z", ctrlKey: true });
    expect(draft().nodes).toEqual([]);
    fireEvent.keyDown(root, { key: "z", ctrlKey: true, shiftKey: true });
    expect(draft().nodes).toHaveLength(1);

    // Leaving unsaved edits asks first.
    fireEvent.click(screen.getByText(pipeline.summary.name));
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "Keep editing" }));
    expect(graphDesignerTab(TAB_ID).editor).not.toBeNull();
  });

  test("keyboard: C opens Connect to… (only compatible targets), Delete removes the focused node", async () => {
    const template = bakeOff();
    template.edges = template.edges.filter((edge) => edge.id !== "describe-pr-pr");
    const { container } = await openForEditing(userDetail(template, 2));
    const describe = await waitFor(() => {
      const found = container.querySelector(
        '.react-flow__node[data-id="describe-pr"]',
      ) as HTMLElement;
      expect(found).not.toBeNull();
      return found;
    });
    describe.focus();
    fireEvent.keyDown(describe, { key: "c" });
    const dialog = await screen.findByRole("dialog");
    const to = within(dialog).getByLabelText("To") as HTMLSelectElement;
    const options = Array.from(to.options).map((option) => option.textContent);
    expect(options).toContain("pr.description (pr-description@1)");
    expect(options).not.toContain("pr.code (workspace@1)");
    fireEvent.change(to, { target: { value: "pr|in:description" } });
    expect(within(dialog).getByRole("status").textContent).toContain("describe-pr.description");
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(
      draft().edges.some(
        (edge) =>
          edge.to.node === "pr" &&
          edge.to.port === "description" &&
          "node" in edge.from &&
          edge.from.node === "describe-pr",
      ),
    ).toBe(true);

    const pr = container.querySelector('.react-flow__node[data-id="pr"]') as HTMLElement;
    fireEvent.keyDown(pr, { key: "Delete" });
    expect(draft().nodes.some((node) => node.id === "pr")).toBe(false);
    fireEvent.keyDown(container.querySelector("[data-graph-designer]")!, {
      key: "z",
      metaKey: true,
    });
    expect(draft().nodes.some((node) => node.id === "pr")).toBe(true);
  });

  test("taint warnings wait for an acknowledgement, recorded in the draft against the digest", async () => {
    const { container } = await openForEditing(userDetail(bakeOff(), 2));
    const pending = await waitFor(() => {
      const found = container.querySelector("[data-graph-pending-acknowledgements]");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(pending.getAttribute("data-graph-pending-acknowledgements")).toBe("2");
    const buttons = within(pending).getAllByRole("button", { name: /^Acknowledge/ });
    fireEvent.click(buttons[0]!);
    fireEvent.click(
      within(pending).getAllByRole("button", { name: /^Acknowledge/ })[1] ?? buttons[1]!,
    );
    expect(draft().acknowledgements?.map((entry) => entry.kind)).toEqual(["taint", "taint"]);
    // The next browser compile finds nothing pending: the template may launch.
    await waitFor(() =>
      expect(container.querySelector("[data-graph-pending-acknowledgements]")).toBeNull(),
    );
    expect(graphDesignerTab(TAB_ID).compile?.launchable).toBe(true);
  });

  test("saves with compare-and-swap; a lost race keeps the draft and offers Save as copy", async () => {
    const detail = userDetail(bakeOff(), 3);
    const { container } = await openForEditing(detail);
    // Rename the template from the template form (nothing selected).
    const name = screen.getByLabelText("Template name") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Bake-off, ours" } });
    saveHandler = () => {
      throw new Error("Template design-bake-off is at revision 4, not 3; reload it before saving");
    };
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    });
    const save = invokeMock.mock.calls.find(([command]) => command === "graph_template_save")!;
    expect(save[1]).toMatchObject({ expectedRevision: 3, projectId: "project-1" });
    const alert = container.querySelector("[data-graph-save-conflict]")!;
    expect(alert.textContent).toContain("revision 3");
    expect(draft().name).toBe("Bake-off, ours");
    expect(screen.getByRole("button", { name: /Reload latest/ })).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save as copy/ }));
    });
    const imported = invokeMock.mock.calls.find(
      ([command]) => command === "graph_template_import",
    )!;
    expect(JSON.parse((imported[1] as { text: string }).text)).toMatchObject({
      id: "design-bake-off-copy",
      name: "Bake-off, ours (copy)",
    });
    await waitFor(() =>
      expect(persisted()).toEqual({ selected: { scope: "user", id: "design-bake-off-copy-1" } }),
    );
    expect(graphDesignerTab(TAB_ID).editor).toMatchObject({ conflict: false, isNew: false });
  });

  test("a saved edit rebases the editor on the stored revision", async () => {
    const detail = userDetail(bakeOff(), 3);
    await openForEditing(detail);
    fireEvent.change(screen.getByLabelText("Template name") as HTMLInputElement, {
      target: { value: "Renamed" },
    });
    saveHandler = (args) => userDetail(args.template as GraphTemplateV1, 4);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    });
    await waitFor(() => expect(graphDesignerTab(TAB_ID).editor?.baseRevision).toBe(4));
    expect(screen.getByText("Saved · revision 4")).toBeDefined();
  });
});
