import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as realBackend from "@/lib/backend";

const realBackendSnapshot = { ...realBackend };
const getProjectNotesMock = mock(async (_projectId: string) => ({ content: "saved notes" }));
const saveProjectNotesMock = mock(async (_projectId: string, _content: string) => {});
const getComposeDraftMock = mock(async () => null);
const saveComposeDraftMock = mock(async (..._args: unknown[]) => undefined);
const deleteComposeDraftMock = mock(async (..._args: unknown[]) => undefined);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getProjectNotes: getProjectNotesMock,
  saveProjectNotes: saveProjectNotesMock,
  getComposeDraft: getComposeDraftMock,
  saveComposeDraft: saveComposeDraftMock,
  deleteComposeDraft: deleteComposeDraftMock,
}));

const { useKanbanStore } = await import("@/stores/kanbanStore");
const { useProjectStore } = await import("@/stores/projectStore");
const { ProjectNotesView } = await import("./ProjectNotesView");

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

afterEach(() => cleanup());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("ProjectNotesView", () => {
  beforeEach(() => {
    getProjectNotesMock.mockReset();
    getProjectNotesMock.mockResolvedValue({ content: "saved notes" });
    saveProjectNotesMock.mockReset();
    saveProjectNotesMock.mockResolvedValue(undefined);
    getComposeDraftMock.mockReset();
    getComposeDraftMock.mockResolvedValue(null);
    saveComposeDraftMock.mockReset();
    deleteComposeDraftMock.mockReset();
    deleteComposeDraftMock.mockResolvedValue(undefined);
    useKanbanStore.setState({
      notes: "",
      notesLoading: false,
      currentNotesProjectId: null,
    });
    useProjectStore.setState({
      projects: [{
        id: "project-1",
        name: "Orkestrator",
        gitUrl: "https://example.invalid/repo.git",
        localPath: null,
        addedAt: "2026-08-05T00:00:00.000Z",
        order: 0,
      }],
    });
  });

  test("loads notes, edits them, and saves explicitly", async () => {
    render(<ProjectNotesView projectId="project-1" onBack={() => {}} />);
    const editor = await screen.findByPlaceholderText(/Write project notes here/);
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe("saved notes"));

    fireEvent.change(editor, { target: { value: "replacement" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saveProjectNotesMock).toHaveBeenCalledWith(
      "project-1",
      "replacement",
    ));
    await waitFor(() => expect(deleteComposeDraftMock).toHaveBeenCalled());
  });

  test("does not erase text typed while an older save is in flight", async () => {
    const pendingSave = deferred<void>();
    saveProjectNotesMock.mockImplementationOnce(() => pendingSave.promise);
    render(<ProjectNotesView projectId="project-1" onBack={() => {}} />);
    const editor = await screen.findByPlaceholderText(/Write project notes here/);
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe("saved notes"));

    fireEvent.change(editor, { target: { value: "first edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.change(editor, { target: { value: "newer edit" } });
    await act(async () => pendingSave.resolve());

    expect((editor as HTMLTextAreaElement).value).toBe("newer edit");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(deleteComposeDraftMock).not.toHaveBeenCalled();
  });

  test("serializes an older slow save before a newer manual save", async () => {
    const olderSave = deferred<void>();
    let backendContent = "saved notes";
    saveProjectNotesMock
      .mockImplementationOnce(async (_projectId, content) => {
        await olderSave.promise;
        backendContent = content;
      })
      .mockImplementationOnce(async (_projectId, content) => {
        backendContent = content;
      });
    render(<ProjectNotesView projectId="project-1" onBack={() => {}} />);
    const editor = await screen.findByPlaceholderText(/Write project notes here/);
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe("saved notes"));

    fireEvent.change(editor, { target: { value: "older edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveProjectNotesMock).toHaveBeenCalledTimes(1));

    fireEvent.change(editor, { target: { value: "newest edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    // The newer backend write waits behind the older one instead of racing it.
    expect(saveProjectNotesMock).toHaveBeenCalledTimes(1);

    olderSave.resolve();
    await waitFor(() => expect(saveProjectNotesMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(backendContent).toBe("newest edit"));
    expect((editor as HTMLTextAreaElement).value).toBe("newest edit");
    await waitFor(() => expect(deleteComposeDraftMock).toHaveBeenCalledTimes(1));
  });

  test("keeps failed edits visible and recoverable", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    saveProjectNotesMock.mockRejectedValueOnce(new Error("disk full"));
    render(<ProjectNotesView projectId="project-1" onBack={() => {}} />);
    const editor = await screen.findByPlaceholderText(/Write project notes here/);
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe("saved notes"));

    fireEvent.change(editor, { target: { value: "unsaved edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(warning).toHaveBeenCalled());
    expect((editor as HTMLTextAreaElement).value).toBe("unsaved edit");
    expect(deleteComposeDraftMock).not.toHaveBeenCalled();
    warning.mockRestore();
  });
});
