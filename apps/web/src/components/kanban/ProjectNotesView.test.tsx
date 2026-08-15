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

/** Matches the inactivity delay `handleChange` schedules its autosave with. */
const AUTOSAVE_DELAY_MS = 1000;

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
      notesError: null,
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

  // The editor autosaves a second after the last keystroke. That path captures
  // the edit revision when the timer is scheduled, so it is the one that decides
  // whether the durable recovery record may be discarded.
  test("autosaves after a pause and discards the recovery record", async () => {
    render(<ProjectNotesView projectId="project-1" onBack={() => {}} />);
    const editor = await screen.findByPlaceholderText(/Write project notes here/);
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe("saved notes"));

    fireEvent.change(editor, { target: { value: "typed and left alone" } });
    expect(saveProjectNotesMock).not.toHaveBeenCalled();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DELAY_MS + 100));
    });

    expect(saveProjectNotesMock).toHaveBeenCalledWith("project-1", "typed and left alone");
    await waitFor(() => expect(deleteComposeDraftMock).toHaveBeenCalled());
    expect(screen.queryByText("Unsaved changes") === null).toBe(true);
  });

  test("keeps a newer keystroke recoverable when an autosave completes behind it", async () => {
    const pendingSave = deferred<void>();
    saveProjectNotesMock.mockImplementationOnce(() => pendingSave.promise);
    render(<ProjectNotesView projectId="project-1" onBack={() => {}} />);
    const editor = await screen.findByPlaceholderText(/Write project notes here/);
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe("saved notes"));

    fireEvent.change(editor, { target: { value: "autosaved edit" } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DELAY_MS + 100));
    });
    await waitFor(() => expect(saveProjectNotesMock).toHaveBeenCalledTimes(1));

    fireEvent.change(editor, { target: { value: "typed while autosaving" } });
    await act(async () => pendingSave.resolve());

    // The revision captured when the timer was scheduled is older than the live
    // editor, so the newer text stays in the durable draft.
    expect(deleteComposeDraftMock).not.toHaveBeenCalled();
    expect((editor as HTMLTextAreaElement).value).toBe("typed while autosaving");
  });

  test("cancels a pending autosave on unmount but still flushes the durable draft", async () => {
    const view = render(<ProjectNotesView projectId="project-1" onBack={() => {}} />);
    const editor = await screen.findByPlaceholderText(/Write project notes here/);
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe("saved notes"));

    fireEvent.change(editor, { target: { value: "unmounted before the autosave" } });
    view.unmount();

    await waitFor(() => expect(saveComposeDraftMock).toHaveBeenCalledWith(
      "project-notes:project-1:editor",
      "project",
      "project-1",
      "unmounted before the autosave",
      0,
    ));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DELAY_MS + 100));
    });
    expect(saveProjectNotesMock).not.toHaveBeenCalled();
  });

  test("discards the draft of the project the save belonged to after a switch", async () => {
    const pendingSave = deferred<void>();
    saveProjectNotesMock.mockImplementationOnce(() => pendingSave.promise);
    const view = render(<ProjectNotesView projectId="project-1" onBack={() => {}} />);
    const editor = await screen.findByPlaceholderText(/Write project notes here/);
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe("saved notes"));

    fireEvent.change(editor, { target: { value: "project one edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    view.rerender(<ProjectNotesView projectId="project-2" onBack={() => {}} />);
    await act(async () => pendingSave.resolve());

    // The completed save belongs to project-1, so its recovery record is the one
    // that may be removed — never the freshly keyed project-2 draft.
    await waitFor(() => expect(deleteComposeDraftMock).toHaveBeenCalled());
    for (const call of deleteComposeDraftMock.mock.calls) {
      expect(call[0]).toBe("project-notes:project-1:editor");
    }
  });

  test("never renders the previous project's draft while the next load is pending or failed", async () => {
    const secondLoad = deferred<{ content: string }>();
    getProjectNotesMock
      .mockResolvedValueOnce({ content: "private project one notes" })
      .mockImplementationOnce(() => secondLoad.promise);
    const view = render(<ProjectNotesView projectId="project-1" onBack={() => {}} />);
    const editor = await screen.findByPlaceholderText(/Write project notes here/) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe("private project one notes"));

    view.rerender(<ProjectNotesView projectId="project-2" onBack={() => {}} />);
    expect(editor.value).toBe("");
    expect(editor.disabled).toBe(true);

    secondLoad.reject(new Error("project two unavailable"));
    await screen.findByRole("alert");
    expect(editor.value).toBe("");
    expect(editor.disabled).toBe(true);
  });

  test("re-persists a draft that is edited again after a discard", async () => {
    render(<ProjectNotesView projectId="project-1" onBack={() => {}} />);
    const editor = await screen.findByPlaceholderText(/Write project notes here/);
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe("saved notes"));

    fireEvent.change(editor, { target: { value: "saved once" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(deleteComposeDraftMock).toHaveBeenCalled());

    fireEvent.change(editor, { target: { value: "edited after the discard" } });

    await waitFor(() => expect(saveComposeDraftMock).toHaveBeenCalledWith(
      "project-notes:project-1:editor",
      "project",
      "project-1",
      "edited after the discard",
      0,
    ));
  });

  test("keeps the editor disabled and saves nothing when the load fails", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    getProjectNotesMock.mockRejectedValueOnce(new Error("notes unavailable"));
    render(<ProjectNotesView projectId="project-1" onBack={() => {}} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("notes unavailable");
    const editor = screen.getByPlaceholderText(/Write project notes here/) as HTMLTextAreaElement;
    // An enabled empty editor would autosave its first keystroke over the real
    // backend notes, which the failed load never read.
    expect(editor.disabled).toBe(true);
    expect(editor.value).toBe("");
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);

    fireEvent.change(editor, { target: { value: "x" } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DELAY_MS + 100));
    });
    expect(saveProjectNotesMock).not.toHaveBeenCalled();
    expect(saveComposeDraftMock).not.toHaveBeenCalled();

    getProjectNotesMock.mockResolvedValue({ content: "recovered notes" });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(editor.value).toBe("recovered notes"));
    expect(editor.disabled).toBe(false);
    expect(screen.queryByRole("alert") === null).toBe(true);
    consoleError.mockRestore();
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
