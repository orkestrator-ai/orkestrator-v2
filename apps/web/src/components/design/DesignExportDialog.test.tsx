import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  DesignExportPreview,
  DesignExportReceipt,
  DesignExportTarget,
  DesignPendingExport,
  DesignWorkspaceMeta,
} from "@orkestrator/protocol/design-operations";
import { emptyProjection, type DesignIntent, type DesignProjection } from "@/stores/designStore";
import { DesignClientError } from "./design-client";
import type { DesignCanvasController } from "./design-controller";
import { DesignExportDialog, type DesignExportApi } from "./DesignExportDialog";

const environmentId = "env-1";
const canvasId = "canvas-1";
const suggested = "Landing-canvas01.orkdes";

function target(relativePath: string, patch: Partial<DesignExportTarget> = {}): DesignExportTarget {
  return {
    relativePath,
    exists: false,
    sameCanvas: false,
    readable: true,
    needsReplaceConfirmation: false,
    ...patch,
  };
}

function preview(
  relativePath = suggested,
  patch: Partial<DesignExportTarget> = {},
  revision = 7,
): DesignExportPreview {
  return { suggestedPath: suggested, target: target(relativePath, patch), revision };
}

function receipt(
  relativePath: string,
  revision: number,
  currentRevision = revision,
): DesignExportReceipt {
  return {
    token: "ex_1",
    relativePath,
    revision,
    digest: "sha256:new",
    replaced: false,
    exportedAt: new Date().toISOString(),
    currentRevision,
  };
}

function workspace(pendingExport?: DesignPendingExport): DesignWorkspaceMeta {
  return {
    recordSequence: 1,
    statusVersion: 1,
    incarnation: "i",
    createdAt: "",
    modifiedAt: "",
    frames: {},
    sessions: [],
    history: { revision: 7, undoCount: 0, redoCount: 0, canUndo: false, canRedo: false },
    ...(pendingExport ? { pendingExport } : {}),
  };
}

function projection(patch: Partial<DesignProjection> = {}): DesignProjection {
  return {
    ...emptyProjection("key", environmentId, canvasId),
    snapshot: "current",
    revision: 7,
    statusVersion: 1,
    workspace: workspace(),
    ...patch,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const exportPreview = mock<DesignExportApi["exportPreview"]>();
const exportReconcile = mock<DesignExportApi["exportReconcile"]>();
const api: DesignExportApi = { exportPreview, exportReconcile };
const exportSave = mock<DesignCanvasController["exportSave"]>();
const settleEdits = mock<DesignCanvasController["settleEdits"]>();
const refresh = mock(async () => {});
const controller = { exportSave, settleEdits, refresh } as unknown as DesignCanvasController;

function renderDialog(current: DesignProjection) {
  const props = { open: true, onOpenChange: () => {}, controller, api };
  const view = render(<DesignExportDialog {...props} projection={current} />);
  return {
    ...view,
    update: (next: DesignProjection) =>
      view.rerender(<DesignExportDialog {...props} projection={next} />),
  };
}

function nameField() {
  return screen.getByLabelText("File name") as HTMLInputElement;
}

function button(name: string | RegExp) {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

beforeEach(() => {
  exportPreview.mockReset();
  exportReconcile.mockReset();
  exportSave.mockReset();
  settleEdits.mockReset();
  refresh.mockClear();
});

afterEach(() => cleanup());

describe("DesignExportDialog", () => {
  test("previews the suggested path, exports that revision and flags newer workspace changes", async () => {
    exportPreview.mockImplementation(async (_env, _canvas, path) => preview(path ?? suggested));
    exportSave.mockResolvedValue(receipt(suggested, 7));
    const view = renderDialog(projection());

    expect(await screen.findByText(`New file: ${suggested} will be created.`)).toBeTruthy();
    expect(exportPreview).toHaveBeenCalledWith(environmentId, canvasId, undefined);
    expect(nameField().value).toBe(suggested);
    expect(screen.getByText("Exports committed revision 7.")).toBeTruthy();

    fireEvent.click(button("Export revision 7"));
    expect(await screen.findByText(`Exported revision 7 to ${suggested}`)).toBeTruthy();
    expect(exportSave).toHaveBeenCalledWith(suggested, 7, undefined);
    expect(screen.queryByText(/newer changes/) === null).toBe(true);

    view.update(projection({ revision: 9 }));
    expect(await screen.findByText(/The workspace has newer changes \(revision 9\)/)).toBeTruthy();
  });

  test("updating your previous export passes its fingerprint without extra confirmation", async () => {
    exportPreview.mockResolvedValue({
      ...preview(suggested, {
        exists: true,
        sameCanvas: true,
        fingerprint: "sha256:mine",
        reason: "same-canvas",
      }),
      association: {
        relativePath: suggested,
        repository: "r",
        lastExportedRevision: 5,
        digest: "sha256:mine",
        exportedAt: "",
      },
    });
    exportSave.mockResolvedValue(receipt(suggested, 7));
    renderDialog(projection());

    expect(
      await screen.findByText(
        /is your previous export of this design \(revision 5\)\. It is safe to update\./,
      ),
    ).toBeTruthy();
    fireEvent.click(button("Export revision 7"));
    await waitFor(() => expect(exportSave).toHaveBeenCalledWith(suggested, 7, "sha256:mine"));
  });

  test("a collision requires an explicit replace plus confirmation and passes the fingerprint", async () => {
    exportPreview.mockResolvedValue(
      preview(suggested, {
        exists: true,
        canvasId: "other",
        fingerprint: "sha256:theirs",
        needsReplaceConfirmation: true,
        reason: "other-canvas",
      }),
    );
    exportSave.mockResolvedValue(receipt(suggested, 7));
    renderDialog(projection());

    expect(await screen.findByText(/already contains a different design/)).toBeTruthy();
    expect(button("Export revision 7").disabled).toBe(true);
    expect(button("Choose a new name")).toBeTruthy();

    fireEvent.click(button("Replace it"));
    expect(button("Replace and export").disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: `Confirm replacing ${suggested}` }));
    expect(button("Replace and export").disabled).toBe(false);

    fireEvent.click(button("Replace and export"));
    await waitFor(() => expect(exportSave).toHaveBeenCalledWith(suggested, 7, "sha256:theirs"));
  });

  test("a collision at save time re-checks the target", async () => {
    exportPreview.mockResolvedValue(preview());
    exportSave.mockRejectedValue(
      new DesignClientError({
        code: "export-collision",
        message: "The file already exists",
        retry: "review",
      }),
    );
    renderDialog(projection());
    await screen.findByText(`New file: ${suggested} will be created.`);

    fireEvent.click(button("Export revision 7"));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "The file changed since it was checked",
    );
    await waitFor(() =>
      expect(exportPreview).toHaveBeenLastCalledWith(environmentId, canvasId, suggested),
    );
  });

  test("validates the file name and ignores a stale preview for an earlier name", async () => {
    const slow = deferred<DesignExportPreview>();
    exportPreview.mockImplementation(async (_env, _canvas, path) => {
      if (path === "first.orkdes") return slow.promise;
      return preview(path ?? suggested);
    });
    renderDialog(projection());
    await screen.findByText(`New file: ${suggested} will be created.`);

    fireEvent.change(nameField(), { target: { value: "docs/design.orkdes" } });
    expect(screen.getByText(/is not a valid file name/)).toBeTruthy();
    expect(button("Export revision …").disabled).toBe(true);

    fireEvent.change(nameField(), { target: { value: "first.orkdes" } });
    await waitFor(() =>
      expect(exportPreview).toHaveBeenCalledWith(environmentId, canvasId, "first.orkdes"),
    );
    fireEvent.change(nameField(), { target: { value: "second.orkdes" } });
    expect(await screen.findByText("New file: second.orkdes will be created.")).toBeTruthy();

    await act(async () =>
      slow.resolve(
        preview("first.orkdes", {
          exists: true,
          needsReplaceConfirmation: true,
          reason: "not-design",
          fingerprint: "x",
        }),
      ),
    );
    expect(screen.queryByText(/is not a design file/) === null).toBe(true);
    expect(screen.getByText("New file: second.orkdes will be created.")).toBeTruthy();
    expect(exportPreview).not.toHaveBeenCalledWith(environmentId, canvasId, "docs/design.orkdes");
  });

  test("offers to wait for pending edits or export the committed revision explicitly", async () => {
    const pendingIntent: DesignIntent = {
      id: "i-1",
      environmentId,
      canvasId,
      lane: "hero",
      descriptor: { input: { kind: "delete_frame", frameId: "hero" }, preconditions: {} },
      label: "Delete hero",
      createdAt: 0,
      phase: "submitting",
    };
    let committed = 7;
    exportPreview.mockImplementation(async (_env, _canvas, path) =>
      preview(path ?? suggested, {}, committed),
    );
    const settled = deferred<boolean>();
    settleEdits.mockReturnValue(settled.promise);
    exportSave.mockResolvedValue(receipt(suggested, 7));
    const view = renderDialog(projection({ intents: [pendingIntent] }));
    await screen.findByText(`New file: ${suggested} will be created.`);

    expect(
      screen.getByText(/1 edit is not committed yet and is not part of revision 7/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Export revision 7" }) === null).toBe(true);

    fireEvent.click(button("Wait for pending edits"));
    expect(settleEdits).toHaveBeenCalledTimes(1);
    expect(button("Export committed revision 7 now").disabled).toBe(true);
    const previews = exportPreview.mock.calls.length;
    committed = 8;
    view.update(projection({ revision: 8 }));
    await act(async () => settled.resolve(true));
    await waitFor(() => expect(exportPreview.mock.calls.length).toBeGreaterThan(previews));
    expect(await screen.findByText("Exports committed revision 8.")).toBeTruthy();
    expect(screen.queryByText(/not committed yet/) === null).toBe(true);

    view.update(projection({ revision: 8, intents: [pendingIntent] }));
    fireEvent.click(button("Export committed revision 8 now"));
    await waitFor(() => expect(exportSave).toHaveBeenCalledWith(suggested, 8, undefined));
  });

  test("an unknown export outcome must be checked before exporting again", async () => {
    const pending: DesignPendingExport = {
      token: "ex_0",
      relativePath: suggested,
      repository: "r",
      revision: 6,
      digest: "sha256:d",
      startedAt: "",
      state: "unknown",
    };
    exportPreview.mockResolvedValue(preview());
    exportReconcile.mockResolvedValueOnce({ state: "not-exported" }).mockResolvedValueOnce({
      state: "exported",
      receipt: receipt(suggested, 6, 7),
    });
    renderDialog(projection({ workspace: workspace(pending) }));
    await screen.findByText(`New file: ${suggested} will be created.`);

    expect(screen.getByText(/The export of revision 6 to .* did not confirm/)).toBeTruthy();
    expect(button("Export revision 7").disabled).toBe(true);

    fireEvent.click(button("Check export"));
    expect(
      await screen.findByText("The export was not written. You can export again."),
    ).toBeTruthy();
    expect(exportReconcile).toHaveBeenCalledWith(environmentId, canvasId);
    expect(refresh).toHaveBeenCalled();

    fireEvent.click(button("Check export"));
    expect(await screen.findByText(`Exported revision 6 to ${suggested}`)).toBeTruthy();
    expect(screen.getByText(/The workspace has newer changes \(revision 7\)/)).toBeTruthy();
    expect(exportSave).not.toHaveBeenCalled();
  });

  test("export busy state disables exporting without touching editing", async () => {
    exportPreview.mockResolvedValue(preview());
    renderDialog(projection({ busy: { export: true, import: false, history: false } }));
    await screen.findByText(`New file: ${suggested} will be created.`);
    expect(button("Export revision 7").disabled).toBe(true);
    expect(nameField().disabled).toBe(true);
  });
});
