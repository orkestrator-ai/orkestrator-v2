import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  GraphLaunchOptions,
  GraphLaunchProviderOption,
  GraphLaunchRequest,
} from "@orkestrator/protocol/graphs/launch";
import type { GraphTemplateRef } from "@orkestrator/protocol/graphs/library";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useKanbanStore } from "@/stores/kanbanStore";
import type { Environment } from "@/types";
import type { KanbanTask } from "@/stores/kanbanStore";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import { GraphLaunchDialog } from "./GraphLaunchDialog";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

const REF: GraphTemplateRef = { scope: "user", id: "review-panel" };
const PROJECT = "project-1";
const ENVIRONMENT = "env-1";

function provider(
  platform: GraphLaunchProviderOption["platform"],
  overrides: Partial<GraphLaunchProviderOption> = {},
): GraphLaunchProviderOption {
  return {
    platform,
    tier: "enforced",
    allowed: true,
    structuredResults: true,
    available: true,
    ...overrides,
  };
}

function launchOptions(overrides: Partial<GraphLaunchOptions> = {}): GraphLaunchOptions {
  return {
    summary: {
      ref: REF,
      scope: "user",
      id: "review-panel",
      name: "Review panel",
      revision: 3,
      digest: "a".repeat(64),
      readOnly: false,
      trust: "trusted",
      launchable: true,
      compile: {
        ok: true,
        launchable: true,
        errors: 0,
        warnings: 0,
        infos: 0,
        pendingAcknowledgements: 0,
        planDigest: "b".repeat(64),
        cost: { agentSessions: { best: 3, worst: 3 }, peakParallelism: 2 },
      },
    },
    launchable: true,
    errors: [],
    roles: [
      {
        role: { key: "reviewer", label: "Reviewer", multiplicity: "panel", maxPanel: 3 },
        nodes: ["review"],
        floor: "provider-configured",
        panel: true,
        maxPanel: 3,
        providers: [
          provider("claude"),
          provider("codex"),
          provider("grok", {
            tier: "advisory",
            allowed: false,
            available: false,
            blockedBy: { nodeId: "review", tier: "advisory", floor: "provider-configured" },
            unavailableReason:
              "Holds step review only at advisory, below its floor (provider-configured)",
          }),
          provider("pi", {
            structuredResults: false,
            available: false,
            unavailableReason: "Cannot return this role's typed results on this host",
          }),
        ],
        default: [{ platform: "claude" }, { platform: "codex" }],
      },
      {
        role: { key: "fixer", label: "Fixer", multiplicity: "one" },
        nodes: ["fix"],
        panel: false,
        maxPanel: 1,
        providers: [provider("claude"), provider("codex")],
        default: { platform: "codex" },
      },
    ],
    parameters: [
      { key: "autoFix", label: "Fix automatically", type: "boolean", default: false },
      { key: "maxRounds", label: "Rounds", type: "integer", min: 1, max: 5, default: 2 },
      { key: "mode", label: "Mode", type: "enum", options: ["fast", "deep"], default: "fast" },
    ],
    params: { autoFix: true, maxRounds: 3, mode: "deep" },
    inputs: [
      {
        name: "ticket",
        type: "ticket@1",
        label: "Ticket",
        required: true,
        ticket: true,
        launchable: true,
      },
    ],
    environment: { workspace: "environment", default: "existing" },
    cost: {
      agentSessions: { best: 3, worst: 3 },
      activations: { best: 3, worst: 3 },
      peakParallelism: 2,
      incomplete: false,
      nodes: [
        {
          nodeId: "review",
          kind: "agent",
          branches: { min: 2, max: 2 },
          attempts: 1,
          iterations: 1,
          skippable: false,
          agentSessions: { best: 2, worst: 2 },
          activations: { best: 2, worst: 2 },
        },
        {
          nodeId: "fix",
          kind: "agent",
          branches: { min: 1, max: 1 },
          attempts: 1,
          iterations: 1,
          skippable: false,
          agentSessions: { best: 1, worst: 1 },
          activations: { best: 1, worst: 1 },
        },
      ],
    },
    saved: {
      roles: {},
      params: { autoFix: true, maxRounds: 3, mode: "deep" },
      environment: "existing",
      updatedAt: "2026-10-29T00:00:00.000Z",
    },
    ...overrides,
  };
}

let options = launchOptions();
let launched: GraphLaunchRequest[] = [];

function installBackend() {
  launched = [];
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case "graph_launch_options":
        return options;
      case "graph_run_launch":
        launched.push(args as unknown as GraphLaunchRequest);
        return {
          runId: "launch-1",
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          status: "running",
          template: { id: "review-panel", revision: 3, name: "Review panel" },
          repeated: false,
        };
      case "get_kanban_tasks":
        return [{ id: "task-1", projectId: PROJECT, title: "Fix login" }];
      default:
        return undefined;
    }
  });
}

function seedStores() {
  useEnvironmentStore.setState({
    environments: [
      { id: ENVIRONMENT, projectId: PROJECT, name: "feature-login" } as Environment,
      { id: "env-other", projectId: "project-2", name: "elsewhere" } as Environment,
    ],
  });
  useKanbanStore.setState({
    tasks: [{ id: "task-1", projectId: PROJECT, title: "Fix login" } as KanbanTask],
  });
}

function renderDialog(props: Partial<Parameters<typeof GraphLaunchDialog>[0]> = {}) {
  const onLaunched = mock(() => undefined);
  const onOpenChange = mock(() => undefined);
  render(
    <GraphLaunchDialog
      open
      onOpenChange={onOpenChange}
      projectId={PROJECT}
      template={REF}
      environmentId={ENVIRONMENT}
      ticketTaskId="task-1"
      onLaunched={onLaunched}
      {...props}
    />,
  );
  return { onLaunched, onOpenChange };
}

beforeEach(() => {
  options = launchOptions();
  seedStores();
  installBackend();
});

afterEach(() => {
  cleanup();
  invokeMock.mockImplementation(() => Promise.resolve());
});

async function ready() {
  return screen.findByRole("region", { name: "Role Reviewer" });
}

describe("GraphLaunchDialog", () => {
  test("asks the backend for options compiled for the launching environment", async () => {
    renderDialog();
    await ready();
    expect(invokeMock.mock.calls.find(([command]) => command === "graph_launch_options")).toEqual([
      "graph_launch_options",
      { ref: REF, projectId: PROJECT, environmentId: ENVIRONMENT },
    ]);
  });

  test("disables providers below the floor or without typed results, and says why", async () => {
    renderDialog();
    const role = await ready();
    const select = within(role).getByLabelText("Reviewer 1 provider") as HTMLSelectElement;
    const grok = Array.from(select.options).find((option) => option.value === "grok")!;
    const pi = Array.from(select.options).find((option) => option.value === "pi")!;
    const claude = Array.from(select.options).find((option) => option.value === "claude")!;
    expect(grok.disabled).toBe(true);
    expect(grok.textContent).toContain("Advisory");
    expect(pi.disabled).toBe(true);
    expect(claude.disabled).toBe(false);
    expect(claude.textContent).toContain("Enforced");
    const reasons = within(role).getByRole("list", { name: "Providers not offered for Reviewer" });
    expect(reasons.textContent).toContain("below its floor (provider-configured)");
    expect(reasons.textContent).toContain("typed results");
  });

  test("prefills defaults and saved values, edits a panel with a lens, and launches", async () => {
    const { onLaunched, onOpenChange } = renderDialog();
    const role = await ready();
    // Defaults: two reviewers (Claude, Codex), the saved parameters.
    expect((within(role).getByLabelText("Reviewer 1 provider") as HTMLSelectElement).value).toBe(
      "claude",
    );
    expect((within(role).getByLabelText("Reviewer 2 provider") as HTMLSelectElement).value).toBe(
      "codex",
    );
    expect((screen.getByLabelText("Rounds") as HTMLInputElement).value).toBe("3");
    expect((screen.getByLabelText("Mode") as HTMLSelectElement).value).toBe("deep");
    // The ticket passed in fills the ticket input.
    expect((screen.getByLabelText(/Ticket/) as HTMLSelectElement).value).toBe("task-1");
    expect(screen.getByText(/Estimated agent sessions: 3/)).toBeDefined();

    // Add a third reviewer (panel max 3) and give it a focus.
    fireEvent.click(within(role).getByRole("button", { name: /Add to Reviewer/ }));
    expect(screen.getByText(/Estimated agent sessions: 4/)).toBeDefined();
    expect(
      (within(role).getByRole("button", { name: /Add to Reviewer/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    const focus = within(role).getByLabelText("Reviewer 3 focus") as HTMLSelectElement;
    const preset = Array.from(focus.options).find((option) => option.value.startsWith("preset:"))!;
    fireEvent.change(focus, { target: { value: preset.value } });
    // Remove the second reviewer.
    fireEvent.click(within(role).getByRole("button", { name: "Remove Reviewer 2" }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    });
    expect(launched).toHaveLength(1);
    const request = launched[0]!;
    expect(request.ref).toEqual(REF);
    expect(request.projectId).toBe(PROJECT);
    expect(request.environment).toEqual({ kind: "existing", environmentId: ENVIRONMENT });
    expect(request.saveDefaults).toBe(true);
    expect(typeof request.requestId).toBe("string");
    expect(request.ticket).toEqual({ taskId: "task-1", input: "ticket" });
    expect(request.params).toEqual({ autoFix: true, maxRounds: 3, mode: "deep" });
    const reviewers = request.roles!.reviewer as Array<{ platform: string; lens?: unknown }>;
    expect(reviewers.map((member) => member.platform)).toEqual(["claude", "codex"]);
    expect(reviewers[0]!.lens).toBeUndefined();
    expect(reviewers[1]!.lens).toEqual(expect.objectContaining({ label: preset.textContent }));
    expect(request.roles!.fixer).toEqual({ platform: "codex" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onLaunched).toHaveBeenCalledWith(expect.objectContaining({ runId: "launch-1" }));
  });

  test("keeps Launch disabled while a parameter is out of range", async () => {
    renderDialog();
    await ready();
    fireEvent.change(screen.getByLabelText("Rounds"), { target: { value: "9" } });
    expect(screen.getAllByText(/Rounds must be at most 5/).length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: "Launch" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(screen.getByLabelText("Rounds"), { target: { value: "4" } });
    expect((screen.getByRole("button", { name: "Launch" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  test("a new environment re-reads options for that kind and launches without an id", async () => {
    renderDialog();
    await ready();
    fireEvent.click(screen.getByRole("radio", { name: /New container/ }));
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.some(
          ([command, args]) =>
            command === "graph_launch_options" &&
            (args as { create?: string }).create === "container",
        ),
      ).toBe(true),
    );
    expectDomAbsent(screen.queryByLabelText("Existing environment"), "existing picker");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    });
    expect(launched[0]!.environment).toEqual({ kind: "new", create: "container" });
  });

  test("shows why a template cannot be launched and never launches it", async () => {
    options = launchOptions({
      launchable: false,
      blockedReason: "The template does not compile: Edge e1 joins incompatible types",
    });
    renderDialog();
    await ready();
    expect(screen.getByRole("alert").textContent).toContain("does not compile");
    expect((screen.getByRole("button", { name: "Launch" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  test("a launch the backend refuses stays open with its message", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "graph_launch_options") return options;
      if (command === "graph_run_launch") throw new Error("claude misses the enforcement floor");
      return undefined;
    });
    const { onLaunched } = renderDialog();
    await ready();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    });
    expect(screen.getByRole("alert").textContent).toContain("enforcement floor");
    expect(onLaunched).not.toHaveBeenCalled();
  });

  test("without a template, lists templates and disables the ones that cannot launch", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "graph_templates_list") {
        return {
          templates: [
            options.summary,
            {
              ...options.summary,
              ref: { scope: "builtin", id: "multi-review" },
              id: "multi-review",
              name: "Multi Review",
              engine: "multi-review",
              launchable: false,
            },
          ],
          project: null,
          ceiling: { deny: [] },
        };
      }
      if (command === "graph_launch_options") return options;
      return undefined;
    });
    renderDialog({ template: null });
    const picker = (await screen.findByLabelText("Template")) as HTMLSelectElement;
    await waitFor(() => expect(picker.options.length).toBe(3));
    const builtin = Array.from(picker.options).find((option) =>
      option.textContent?.includes("Multi Review"),
    )!;
    expect(builtin.disabled).toBe(true);
    expect(builtin.textContent).toContain("own engine");
    fireEvent.change(picker, { target: { value: "user:review-panel" } });
    await ready();
  });
});
