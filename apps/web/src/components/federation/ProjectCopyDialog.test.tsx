import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProjectCopyOptions, ProjectCopyRecord } from "@orkestrator/protocol/project-copy";
import { invoke } from "@/lib/native/backend";
import { useProjectCopyStore } from "@/stores/projectCopyStore";
import { FederationProvider } from "./FederationProvider";
import { NodeActionRequestsDialog } from "./NodeActionRequestsDialog";
import { ProjectCopyDialog } from "./ProjectCopyDialog";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

afterEach(() => {
  cleanup();
  act(() => useProjectCopyStore.getState().close());
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
});

const OPTIONS: ProjectCopyOptions = {
  source: {
    nodeId: "bk_self",
    projectId: "p1",
    nodeName: "Desk",
    projectName: "site",
    gitUrl: "git@github.com:acme/site.git",
  },
  targets: [
    {
      nodeId: "bk_down",
      nodeName: "Old box",
      available: false,
      hasProject: false,
      projectId: null,
      defaultLocation: null,
      unavailableReason: "Old box is not connected.",
    },
    {
      nodeId: "bk_leaf",
      nodeName: "Build box",
      available: true,
      hasProject: false,
      projectId: null,
      defaultLocation: "/srv/projects/site",
    },
  ],
  candidates: [
    {
      path: ".env",
      kind: "file",
      ignored: true,
      bytes: 12,
      files: 1,
      truncated: false,
      suggested: true,
      heavy: false,
    },
    {
      path: "notes.txt",
      kind: "file",
      ignored: false,
      bytes: 5,
      files: 1,
      truncated: false,
      suggested: false,
      heavy: false,
    },
    {
      path: "node_modules/",
      kind: "directory",
      ignored: true,
      bytes: 5_000_000,
      files: 20_000,
      truncated: true,
      suggested: false,
      heavy: true,
    },
  ],
  candidatesTruncated: false,
  limits: { files: 10_000, bytes: 2 * 1024 * 1024 * 1024 },
};

function record(stage: ProjectCopyRecord["stage"]): ProjectCopyRecord {
  return {
    copyId: "copy-1",
    requestKey: "k",
    source: { nodeId: "bk_self", projectId: "p1", nodeName: "Desk", projectName: "site" },
    target: {
      nodeId: "bk_leaf",
      nodeName: "Build box",
      location: "/srv/projects/site",
      projectId: stage === "completed" ? "p9" : null,
    },
    paths: [".env"],
    rememberFiles: true,
    stage,
    reusedProject: false,
    progress: { files: 1, totalFiles: 1, bytes: 12, totalBytes: 12 },
    skipped: 0,
    tooLarge: [],
    startedAt: "2026-10-24T00:00:00.000Z",
  };
}

describe("copying a project to another machine", () => {
  test("suggested files are ticked, dependencies hidden, and the copy names target, location and files", async () => {
    const copies: Array<Record<string, unknown>> = [];
    let stage: ProjectCopyRecord["stage"] = "cloning";
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "get_project_copy_options") return OPTIONS;
      if (command === "copy_project_to_node") {
        copies.push(args);
        return record("queued");
      }
      if (command === "list_project_copies") return [record(stage)];
      return undefined;
    });
    render(
      <FederationProvider>
        <ProjectCopyDialog />
      </FederationProvider>,
    );
    act(() =>
      useProjectCopyStore.getState().open({ source: { nodeId: "bk_self", projectId: "p1" } }),
    );

    const dialog = await screen.findByTestId("project-copy-dialog");
    await waitFor(() => expect(dialog.textContent).toContain("Copy site from Desk"));
    expect(screen.getByRole("checkbox", { name: ".env" }).getAttribute("data-state")).toBe(
      "checked",
    );
    expect(screen.getByRole("checkbox", { name: "notes.txt" }).getAttribute("data-state")).toBe(
      "unchecked",
    );
    // Dependencies are listed behind a toggle and never ticked.
    expect(screen.queryByRole("checkbox", { name: "node_modules/" }) === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Dependencies and build output/ }));
    expect(screen.getByRole("checkbox", { name: "node_modules/" }).getAttribute("data-state")).toBe(
      "unchecked",
    );
    // The unavailable machine cannot be picked; the connected one is.
    expect((screen.getByRole("radio", { name: "Old box" }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("radio", { name: "Build box" }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect((screen.getByLabelText("Location on Build box") as HTMLInputElement).value).toBe(
      "/srv/projects/site",
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(copies).toHaveLength(1));
    expect(copies[0]).toMatchObject({
      source: { nodeId: "bk_self", projectId: "p1" },
      target: { nodeId: "bk_leaf", location: "/srv/projects/site" },
      paths: [".env"],
      rememberFiles: true,
    });
    await waitFor(() =>
      expect(dialog.textContent).toContain("Cloning the repository on Build box"),
    );
    stage = "completed";
    await waitFor(
      () => expect(screen.getByRole("button", { name: "Open on Build box" })).toBeTruthy(),
      { timeout: 5_000 },
    );
  });

  test("a coordinator's copy request is approved from the copy dialog with the user's choices", async () => {
    const resolved: Array<Record<string, unknown>> = [];
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "get_node_summaries") return { selfId: "bk_self", nodes: [] };
      if (command === "get_node_status") return { nodeId: "bk_self", mode: "command" };
      if (command === "list_node_action_requests") {
        return resolved.length
          ? []
          : [
              {
                requestId: "req-copy",
                kind: "create-project",
                targets: [
                  {
                    nodeId: "bk_leaf",
                    nodeName: "Build box",
                    projectName: "site",
                    files: ["notes.txt"],
                  },
                ],
                requestedBy: { projectId: "p1" },
                reason: "Run the tests there.",
                state: "pending",
              },
            ];
      }
      if (command === "get_project_copy_options") return OPTIONS;
      if (command === "resolve_node_action_request") {
        resolved.push(args);
        return { requestId: "req-copy", state: "executed", result: { code: "copying" } };
      }
      if (command === "list_project_copies")
        return [{ ...record("copying"), actionRequestId: "req-copy" }];
      return undefined;
    });
    render(
      <FederationProvider>
        <NodeActionRequestsDialog />
        <ProjectCopyDialog />
      </FederationProvider>,
    );

    const request = await screen.findByTestId("node-action-request");
    expect(request.textContent).toContain("Copy site to Build box?");
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Review and copy…" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Review and copy…" }));

    const dialog = await screen.findByTestId("project-copy-dialog");
    await waitFor(() => expect(dialog.textContent).toContain("Run the tests there."));
    // The request's suggestion is ticked along with the suggested files.
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "notes.txt" }).getAttribute("data-state")).toBe(
        "checked",
      ),
    );
    expect(screen.queryByTestId("node-action-request") === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Approve and copy" }));

    await waitFor(() => expect(resolved).toHaveLength(1));
    expect(resolved[0]).toEqual({
      requestId: "req-copy",
      decision: "approve",
      approval: {
        location: "/srv/projects/site",
        paths: [".env", "notes.txt"],
        rememberFiles: true,
      },
    });
    await waitFor(() => expect(dialog.textContent).toContain("Copying files"));
  });
});
