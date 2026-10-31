import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@/lib/native/backend";
import type { NodeActionRequestView } from "@/lib/portal/portal-store";
import { AgentsMdApprovalDialog } from "./AgentsMdApprovalDialog";
import { FederationProvider } from "./FederationProvider";
import { NodeActionRequestsDialog } from "./NodeActionRequestsDialog";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
});

const SECTION = "## Orkestrator\n\nPreamble.\n\n- Never touch ports 34121/34122.\n";

const request: NodeActionRequestView = {
  requestId: "agents-md-1",
  kind: "update-agents-md",
  state: "pending",
  reason: "Agreed while planning",
  targets: [{ nodeId: "self", nodeName: "this machine", projectId: "p1", projectName: "widgets" }],
  requestedBy: { projectId: "p1" },
  agentsMd: {
    changes: [
      { action: "add", text: "Commit flaky-test records in the same change." },
      {
        action: "replace",
        replaces: "Never touch ports 34121/34122.",
        text: "Never bind ports 34121 or 34122.",
      },
    ],
  },
};

function backend(options: { section?: string | null; outcome?: Record<string, unknown> } = {}) {
  const resolved: Array<Record<string, unknown>> = [];
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "preview_agents_md_update") {
      const section = options.section === undefined ? SECTION : options.section;
      return {
        baseBranch: "main",
        baseCommit: "b".repeat(40),
        fetched: true,
        fileExists: true,
        section: section
          ? { exists: true, text: section, entries: [] }
          : { exists: false, text: null, entries: [] },
      };
    }
    if (command === "resolve_node_action_request") {
      resolved.push(args);
      return {
        ...request,
        state: args.decision === "approve" ? "executed" : "rejected",
        result: options.outcome ?? {
          code: "pr-opened",
          message: "Opened",
          url: "https://github.com/acme/widgets/pull/9",
        },
      };
    }
    if (command === "list_node_action_requests") return [request];
    return undefined;
  });
  return resolved;
}

const diffLines = (type: string) =>
  Array.from(screen.getByTestId("agents-md-diff").querySelectorAll(`[data-diff="${type}"]`)).map(
    (line) => line.textContent,
  );

describe("AGENTS.md approval dialog", () => {
  test("shows the section diff against the base branch; approve sends the user's edits", async () => {
    const resolved = backend();
    const settled = mock(() => {});
    render(<AgentsMdApprovalDialog request={request} onSettled={settled} />);
    const dialog = await screen.findByTestId("agents-md-request");
    expect(dialog.textContent).toContain("Agreed while planning");
    await screen.findByTestId("agents-md-diff");
    expect(diffLines("add")).toEqual([
      "+ - Never bind ports 34121 or 34122.",
      "+ - Commit flaky-test records in the same change.",
    ]);
    expect(diffLines("remove")).toEqual(["- - Never touch ports 34121/34122."]);
    expect(dialog.textContent).toContain("Compared with origin/main (bbbbbbbb)");

    await act(async () => {
      fireEvent.change(screen.getByRole("textbox", { name: "Entry 1 text" }), {
        target: { value: "Commit flaky-test records with the fix." },
      });
    });
    expect(diffLines("add")).toContain("+ - Commit flaky-test records with the fix.");
    expect(resolved).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Approve and open PR" }));
    await waitFor(() =>
      expect(resolved).toEqual([
        {
          requestId: "agents-md-1",
          decision: "approve",
          approval: {
            changes: [
              { action: "add", text: "Commit flaky-test records with the fix." },
              {
                action: "replace",
                replaces: "Never touch ports 34121/34122.",
                text: "Never bind ports 34121 or 34122.",
              },
            ],
          },
        },
      ]),
    );
    await waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
  });

  test("an edit that would escape the section blocks approval; decline still works", async () => {
    const resolved = backend();
    const settled = mock(() => {});
    render(<AgentsMdApprovalDialog request={request} onSettled={settled} />);
    await screen.findByTestId("agents-md-diff");
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox", { name: "Entry 1 text" }), {
        target: { value: "## Injected heading" },
      });
    });
    expect(screen.getByRole("alert").textContent).toContain("cannot start with a heading");
    const approve = screen.getByRole("button", {
      name: "Approve and open PR",
    }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() =>
      expect(resolved).toEqual([{ requestId: "agents-md-1", decision: "reject" }]),
    );
  });

  test("a replacement whose original is gone is a conflict; dropping it allows approval", async () => {
    const resolved = backend({ section: "## Orkestrator\n\n- Something else\n" });
    render(<AgentsMdApprovalDialog request={request} onSettled={() => {}} />);
    await screen.findByTestId("agents-md-diff");
    expect(screen.getByRole("alert").textContent).toContain("no longer in the section");
    const approve = () =>
      screen.getByRole("button", { name: "Approve and open PR" }) as HTMLButtonElement;
    expect(approve().disabled).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Include entry 2" }));
    });
    expect(approve().disabled).toBe(false);
    fireEvent.click(approve());
    await waitFor(() =>
      expect(resolved[0]?.approval).toEqual({
        changes: [{ action: "add", text: "Commit flaky-test records in the same change." }],
      }),
    );
  });

  test("a missing section is shown as created at the end", async () => {
    backend({ section: null });
    render(
      <AgentsMdApprovalDialog
        request={{ ...request, agentsMd: { changes: [request.agentsMd!.changes[0]!] } }}
        onSettled={() => {}}
      />,
    );
    await screen.findByTestId("agents-md-diff");
    expect(screen.getByTestId("agents-md-request").textContent).toContain(
      "the section will be added at the end of AGENTS.md",
    );
    expect(diffLines("add")[0]).toBe("+ ## Orkestrator");
  });

  test("entries wrap and grow in a capped textarea but stay one line", async () => {
    backend();
    const long = `Keep ${"a long decision ".repeat(20)}on one line.`;
    render(
      <AgentsMdApprovalDialog
        request={{ ...request, agentsMd: { changes: [{ action: "add", text: long }] } }}
        onSettled={() => {}}
      />,
    );
    await screen.findByTestId("agents-md-diff");
    const entry = screen.getByRole("textbox", { name: "Entry 1 text" }) as HTMLTextAreaElement;
    expect(entry.tagName).toBe("TEXTAREA");
    expect(entry.value).toBe(long);
    expect(entry.maxLength).toBe(500);
    expect(entry.getAttribute("wrap")).toBeNull();
    expect(entry.className).toContain("field-sizing-content");
    expect(entry.className).toContain("max-h-[calc(8lh+0.75rem+2px)]");

    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    entry.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    const composing = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    entry.dispatchEvent(composing);
    expect(composing.defaultPrevented).toBe(false);

    await act(async () => {
      fireEvent.change(entry, { target: { value: "Pasted\nacross\nthree lines" } });
    });
    expect(entry.value).toBe("Pasted across three lines");
    expect(diffLines("add")).toContain("+ - Pasted across three lines");
    expect(screen.queryByRole("alert") === null).toBe(true);
  });

  test("entries and diff scroll between a fixed header and footer", async () => {
    backend();
    const long = (n: number) => `Decision ${n}: ${"keep this entry readable in full ".repeat(12)}`;
    render(
      <AgentsMdApprovalDialog
        request={{
          ...request,
          agentsMd: {
            changes: [1, 2, 3, 4, 5, 6].map((n) => ({ action: "add" as const, text: long(n) })),
          },
        }}
        onSettled={() => {}}
      />,
    );
    await screen.findByTestId("agents-md-diff");
    const dialog = screen.getByTestId("agents-md-request");
    const body = screen.getByTestId("agents-md-body");
    expect(dialog.className).toContain("flex-col");
    expect(body.className).toContain("overflow-y-auto");
    expect(body.className).toContain("min-h-0");
    expect(body.contains(screen.getByTestId("agents-md-diff"))).toBe(true);
    expect(screen.getAllByTestId("agents-md-entry")).toHaveLength(6);
    for (const name of ["Decline", "Approve and open PR"]) {
      const button = screen.getByRole("button", { name });
      expect(body.contains(button)).toBe(false);
      expect(button.closest('[data-slot="dialog-footer"]')?.className).toContain("shrink-0");
    }
  });

  test("paste falls back to a normalized selection replacement without an editing command", async () => {
    backend();
    render(<AgentsMdApprovalDialog request={request} onSettled={() => {}} />);
    await screen.findByTestId("agents-md-diff");
    const entry = screen.getByRole("textbox", { name: "Entry 1 text" }) as HTMLTextAreaElement;
    const original = entry.value;
    entry.focus();
    entry.setSelectionRange(0, 6);
    await act(async () => {
      fireEvent.paste(entry, {
        clipboardData: { getData: () => "Save\nthese\u2028decisions" },
      });
    });
    expect(entry.value).toBe(`Save these decisions${original.slice(6)}`);
    expect(diffLines("add")).toContain(`+ - ${entry.value}`);
  });

  test("an unchecked row's entry is disabled", async () => {
    backend();
    render(<AgentsMdApprovalDialog request={request} onSettled={() => {}} />);
    await screen.findByTestId("agents-md-diff");
    const entry = screen.getByRole("textbox", { name: "Entry 2 text" }) as HTMLTextAreaElement;
    expect(entry.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Include entry 2" }));
    });
    expect(entry.disabled).toBe(true);
  });

  test("the coordinator request dialog routes AGENTS.md requests here", async () => {
    backend();
    render(
      <FederationProvider>
        <NodeActionRequestsDialog />
      </FederationProvider>,
    );
    expect((await screen.findByTestId("agents-md-request")).textContent).toContain(
      "Save decisions to AGENTS.md?",
    );
  });
});

test("pending preview blocks approval but permits decline", async () => {
  const resolved = backend();
  const fallback = invokeMock.getMockImplementation()!;
  invokeMock.mockImplementation((command: string, args: Record<string, unknown>) =>
    command === "preview_agents_md_update" ? new Promise(() => {}) : fallback(command, args),
  );
  render(<AgentsMdApprovalDialog request={request} onSettled={() => {}} />);
  const approve = screen.getByRole("button", { name: "Approve and open PR" }) as HTMLButtonElement;
  expect(approve.disabled).toBe(true);
  fireEvent.click(approve);
  expect(resolved).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Decline" }));
  await waitFor(() =>
    expect(resolved).toEqual([{ requestId: request.requestId, decision: "reject" }]),
  );
});

test("failed preview blocks approval; retry enables it after a valid diff", async () => {
  const resolved = backend();
  const fallback = invokeMock.getMockImplementation()!;
  let attempts = 0;
  invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
    if (command === "preview_agents_md_update" && attempts++ === 0)
      return Promise.reject(new Error("node offline"));
    return fallback(command, args);
  });
  render(<AgentsMdApprovalDialog request={request} onSettled={() => {}} />);
  await screen.findByText(/node offline/);
  const approve = () =>
    screen.getByRole("button", { name: "Approve and open PR" }) as HTMLButtonElement;
  expect(approve().disabled).toBe(true);
  fireEvent.click(approve());
  expect(resolved).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Retry preview" }));
  await screen.findByTestId("agents-md-diff");
  expect(approve().disabled).toBe(false);
});

test("a merge exception blocks approval", async () => {
  const resolved = backend({ section: "## Orkestrator\n- a\n## Orkestrator\n- b\n" });
  render(<AgentsMdApprovalDialog request={request} onSettled={() => {}} />);
  await screen.findByText(/more than one/);
  const approve = screen.getByRole("button", { name: "Approve and open PR" }) as HTMLButtonElement;
  expect(approve.disabled).toBe(true);
  fireEvent.click(approve);
  expect(resolved).toEqual([]);
});
