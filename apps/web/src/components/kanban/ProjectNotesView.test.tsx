import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import * as realBackend from "@/lib/backend";
import { mockToastError } from "../../../../../tests/mocks/sonner";

const realBackendSnapshot = { ...realBackend };
const getProjectNotesMock = mock(async (_projectId: string) => ({ content: "saved notes" }));
const saveProjectNotesMock = mock(async (_projectId: string, _content: string) => {});
const getComposeDraftMock = mock(
  async (..._args: unknown[]): Promise<Awaited<ReturnType<typeof realBackend.getComposeDraft>>> =>
    null,
);
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

const { kanbanStore } = await import("@/stores/kanbanStore");
const { appCommandStore } = await import("@/test/app-command-store");
const { projectStore } = await import("@/stores/projectStore");
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
  let logs: LogCapture;

  afterEach(() => logs.restore());

  beforeEach(() => {
    logs = captureLogs();
    getProjectNotesMock.mockReset();
    getProjectNotesMock.mockResolvedValue({ content: "saved notes" });
    saveProjectNotesMock.mockReset();
    saveProjectNotesMock.mockResolvedValue(undefined);
    getComposeDraftMock.mockReset();
    getComposeDraftMock.mockResolvedValue(null);
    saveComposeDraftMock.mockReset();
    deleteComposeDraftMock.mockReset();
    deleteComposeDraftMock.mockResolvedValue(undefined);
    appCommandStore(kanbanStore).setState({
      notes: "",
      notesLoading: false,
      notesLoaded: false,
      notesError: null,
      currentNotesProjectId: null,
    });
    appCommandStore(projectStore).setState({
      projects: [
        {
          id: "project-1",
          name: "Orkestrator",
          gitUrl: "https://example.invalid/repo.git",
          localPath: null,
          addedAt: "2026-08-05T00:00:00.000Z",
          order: 0,
        },
      ],
    });
  });

  test("explains that notes live outside the repository", () => {
    render(<ProjectNotesView projectId="project-1" />);
    const notice = screen.getByRole("note").textContent ?? "";
    expect(notice).toContain("not in the repository");
    expect(notice).toContain("Unlike AGENTS.md");
    expect(screen.queryByRole("button", { name: "Back" }) === null).toBe(true);
  });

  test("loads notes, edits them, and saves explicitly", async () => {
    render(<ProjectNotesView projectId="project-1" />);
    const editor = await screen.findByPlaceholderText(/Write project notes here/);
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe("saved notes"));

    fireEvent.change(editor, { target: { value: "replacement" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(saveProjectNotesMock).toHaveBeenCalledWith("project-1", "replacement"),
    );
    await waitFor(() => expect(deleteComposeDraftMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("Unsaved changes") === null).toBe(true));
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });

  test("does not erase text typed while an older save is in flight", async () => {
    const pendingSave = deferred<void>();
    saveProjectNotesMock.mockImplementationOnce(() => pendingSave.promise);
    render(<ProjectNotesView projectId="project-1" />);
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
    render(<ProjectNotesView projectId="project-1" />);
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

  test("does not schedule a project-notes autosave while typing", async () => {
    render(<ProjectNotesView projectId="project-1" />);
    const editor = await screen.findByPlaceholderText(/Write project notes here/);
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe("saved notes"));
    const setTimeoutSpy = spyOn(globalThis, "setTimeout");

    try {
      fireEvent.change(editor, { target: { value: "first edit" } });
      fireEvent.change(editor, { target: { value: "typed and left alone" } });
      expect(saveProjectNotesMock).not.toHaveBeenCalled();
      // Durable draft persistence still schedules its 400 ms debounce. The
      // removed shared-note autosave used a separate 1000 ms timer.
      expect(setTimeoutSpy.mock.calls.some((call) => call[1] === 1_000)).toBe(false);
      expect(deleteComposeDraftMock).not.toHaveBeenCalled();
      expect((editor as HTMLTextAreaElement).value).toBe("typed and left alone");
      expect(screen.getByText("Unsaved changes")).toBeTruthy();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  test("restores an unsaved durable draft after remount", async () => {
    const firstView = render(<ProjectNotesView projectId="project-1" />);
    const firstEditor = await screen.findByPlaceholderText(/Write project notes here/);
    await waitFor(() => expect((firstEditor as HTMLTextAreaElement).value).toBe("saved notes"));

    fireEvent.change(firstEditor, { target: { value: "recovered after remount" } });
    firstView.unmount();
    await waitFor(() => expect(saveComposeDraftMock).toHaveBeenCalled());

    getComposeDraftMock.mockResolvedValue({
      draftKey: "project-notes:project-1:editor",
      ownerType: "project",
      ownerId: "project-1",
      value: "recovered after remount",
      updatedAt: "2026-08-28T00:00:00.000Z",
      revision: 1,
    });
    const refresh = deferred<{ content: string }>();
    getProjectNotesMock.mockImplementationOnce(() => refresh.promise);
    render(<ProjectNotesView projectId="project-1" />);
    const restoredEditor = await screen.findByPlaceholderText(/Write project notes here/);

    await waitFor(() =>
      expect((restoredEditor as HTMLTextAreaElement).value).toBe("recovered after remount"),
    );
    expect((restoredEditor as HTMLTextAreaElement).disabled).toBe(false);
    await act(async () => refresh.resolve({ content: "refreshed notes" }));
    expect((restoredEditor as HTMLTextAreaElement).value).toBe("recovered after remount");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false);
  });

  test("keeps a live draft editable throughout a same-project resource refresh", async () => {
    render(<ProjectNotesView projectId="project-1" />);
    const editor = screen.getByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe("saved notes"));
    fireEvent.change(editor, { target: { value: "unsaved draft" } });
    const refresh = deferred<{ content: string }>();
    getProjectNotesMock.mockImplementationOnce(() => refresh.promise);
    let loading!: Promise<void>;
    act(() => {
      loading = appCommandStore(kanbanStore).getState().loadNotes("project-1");
    });
    expect(editor.value).toBe("unsaved draft");
    expect(editor.disabled).toBe(false);
    fireEvent.change(editor, { target: { value: "edited during refresh" } });
    await act(async () => {
      refresh.resolve({ content: "remote notes" });
      await loading;
    });
    expect(editor.value).toBe("edited during refresh");
    expect(editor.disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(saveProjectNotesMock).toHaveBeenCalledWith("project-1", "edited during refresh"),
    );
  });

  test("retains the live draft and editability when a refresh fails and retries", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(<ProjectNotesView projectId="project-1" />);
      const editor = screen.getByRole("textbox") as HTMLTextAreaElement;
      await waitFor(() => expect(editor.value).toBe("saved notes"));
      fireEvent.change(editor, { target: { value: "unsaved during failure" } });
      getProjectNotesMock.mockRejectedValueOnce(new Error("refresh failed"));
      await act(async () => {
        await appCommandStore(kanbanStore).getState().loadNotes("project-1");
      });
      expect(screen.getByRole("alert").textContent).toContain("refresh failed");
      expect(editor.value).toBe("unsaved during failure");
      expect(editor.disabled).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(screen.queryByRole("alert") === null).toBe(true));
      expect(editor.value).toBe("unsaved during failure");
      expect(editor.disabled).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("flushes the durable draft on unmount without saving project notes", async () => {
    const view = render(<ProjectNotesView projectId="project-1" />);
    const editor = await screen.findByPlaceholderText(/Write project notes here/);
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe("saved notes"));

    fireEvent.change(editor, { target: { value: "unmounted before saving" } });
    view.unmount();

    await waitFor(() =>
      expect(saveComposeDraftMock).toHaveBeenCalledWith(
        "project-notes:project-1:editor",
        "project",
        "project-1",
        "unmounted before saving",
        0,
      ),
    );
    expect(saveProjectNotesMock).not.toHaveBeenCalled();
  });

  test("warns when an unsaved draft cannot be persisted on unmount", async () => {
    saveComposeDraftMock.mockRejectedValueOnce(new Error("draft storage unavailable"));
    const view = render(<ProjectNotesView projectId="project-1" />);
    const editor = await screen.findByPlaceholderText(/Write project notes here/);
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe("saved notes"));

    fireEvent.change(editor, { target: { value: "not durably stored" } });
    view.unmount();

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Draft could not be saved", {
        id: "compose-draft-persistence:project-notes:project-1:editor",
        description:
          "Your input is still here, but it may be lost if you close or reload this view. Copy it somewhere safe or try editing again.",
      }),
    );
    expect(saveProjectNotesMock).not.toHaveBeenCalled();
  });

  test("discards the draft of the project the save belonged to after a switch", async () => {
    const pendingSave = deferred<void>();
    saveProjectNotesMock.mockImplementationOnce(() => pendingSave.promise);
    const view = render(<ProjectNotesView projectId="project-1" />);
    const editor = await screen.findByPlaceholderText(/Write project notes here/);
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe("saved notes"));

    fireEvent.change(editor, { target: { value: "project one edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    view.rerender(<ProjectNotesView projectId="project-2" />);
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
    const view = render(<ProjectNotesView projectId="project-1" />);
    const editor = (await screen.findByPlaceholderText(
      /Write project notes here/,
    )) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe("private project one notes"));

    view.rerender(<ProjectNotesView projectId="project-2" />);
    expect(editor.value).toBe("");
    expect(editor.disabled).toBe(true);

    secondLoad.reject(new Error("project two unavailable"));
    await screen.findByRole("alert");
    expect(editor.value).toBe("");
    expect(editor.disabled).toBe(true);
  });

  test("re-persists a draft that is edited again after a discard", async () => {
    render(<ProjectNotesView projectId="project-1" />);
    const editor = await screen.findByPlaceholderText(/Write project notes here/);
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe("saved notes"));

    fireEvent.change(editor, { target: { value: "saved once" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(deleteComposeDraftMock).toHaveBeenCalled());

    fireEvent.change(editor, { target: { value: "edited after the discard" } });

    await waitFor(() =>
      expect(saveComposeDraftMock).toHaveBeenCalledWith(
        "project-notes:project-1:editor",
        "project",
        "project-1",
        "edited after the discard",
        0,
      ),
    );
  });

  test("keeps the editor disabled and saves nothing when the load fails", async () => {
    getProjectNotesMock.mockRejectedValueOnce(new Error("notes unavailable"));
    render(<ProjectNotesView projectId="project-1" />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("notes unavailable");
    const editor = screen.getByPlaceholderText(/Write project notes here/) as HTMLTextAreaElement;
    // An enabled empty editor could save its first keystroke over the real
    // backend notes, which the failed load never read.
    expect(editor.disabled).toBe(true);
    expect(editor.value).toBe("");
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);

    fireEvent.change(editor, { target: { value: "x" } });
    expect(saveProjectNotesMock).not.toHaveBeenCalled();
    expect(saveComposeDraftMock).not.toHaveBeenCalled();

    getProjectNotesMock.mockResolvedValue({ content: "recovered notes" });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(editor.value).toBe("recovered notes"));
    expect(editor.disabled).toBe(false);
    expect(screen.queryByRole("alert") === null).toBe(true);
    expect(logs.records()).toContainEqual(
      expect.objectContaining({
        level: "error",
        area: "web.kanban",
        event: "notes.load-failed",
        fields: expect.objectContaining({ projectId: "project-1" }),
      }),
    );
  });

  test("keeps failed edits visible and recoverable", async () => {
    saveProjectNotesMock.mockRejectedValueOnce(new Error("disk full"));
    render(<ProjectNotesView projectId="project-1" />);
    const editor = await screen.findByPlaceholderText(/Write project notes here/);
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe("saved notes"));

    fireEvent.change(editor, { target: { value: "unsaved edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(logs.records()).toContainEqual(
        expect.objectContaining({
          level: "warn",
          area: "web.kanban",
          event: "notes.draft-retained",
          fields: expect.objectContaining({
            projectId: "project-1",
            error: expect.objectContaining({ message: "disk full" }),
          }),
        }),
      ),
    );
    expect(logs.records()).toContainEqual(
      expect.objectContaining({ level: "error", area: "web.kanban", event: "notes.save-failed" }),
    );
    expect(logs.lines.join("\n")).not.toContain("unsaved edit");
    expect((editor as HTMLTextAreaElement).value).toBe("unsaved edit");
    expect(deleteComposeDraftMock).not.toHaveBeenCalled();
  });
});
