import { beforeEach, describe, expect, test } from "bun:test";
import { fileSaveBaseline, useFileDirtyStore } from "./fileDirtyStore";

beforeEach(() => {
  useFileDirtyStore.setState({ dirtyFiles: new Map() });
});

describe("fileDirtyStore", () => {
  test("tracks edits against the loaded disk baseline", () => {
    const store = useFileDirtyStore.getState();
    store.setOriginalContent("tab", "disk");
    expect(store.getContent("tab")).toBe("disk");
    expect(store.isDirty("tab")).toBe(false);

    store.setContent("tab", "edited");
    expect(store.getContent("tab")).toBe("edited");
    expect(store.isDirty("tab")).toBe(true);

    store.markSaved("tab", "edited");
    expect(store.isDirty("tab")).toBe(false);
    expect(useFileDirtyStore.getState().dirtyFiles.get("tab")).toEqual({
      content: "edited",
      originalContent: "edited",
    });
  });

  test("preserves a live buffer when the disk baseline is refreshed", () => {
    const store = useFileDirtyStore.getState();
    store.hydrateDraft("tab", "newer buffer", "old disk");
    store.setOriginalContent("tab", "new disk");

    expect(useFileDirtyStore.getState().dirtyFiles.get("tab")).toEqual({
      content: "newer buffer",
      originalContent: "new disk",
    });
    expect(store.isDirty("tab")).toBe(true);
  });

  test("treats content without a baseline as an edit from an empty file", () => {
    const store = useFileDirtyStore.getState();
    store.setContent("tab", "new file");

    expect(useFileDirtyStore.getState().dirtyFiles.get("tab")).toEqual({
      content: "new file",
      originalContent: "",
    });
    expect(store.getContent("missing")).toBeNull();
    expect(store.isDirty("missing")).toBe(false);
  });

  test("clears an explicitly closed tab without affecting other buffers", () => {
    const store = useFileDirtyStore.getState();
    store.hydrateDraft("closed", "edited", "disk");
    store.hydrateDraft("kept", "other edit", "other disk");

    store.clearDirty("closed");

    expect(useFileDirtyStore.getState().dirtyFiles.has("closed")).toBe(false);
    expect(store.getContent("kept")).toBe("other edit");
  });

  test("observing disk keeps the buffer's baseline until a save or fresh load", () => {
    const store = useFileDirtyStore.getState();
    store.setOriginalContent("baseline", "loaded");
    store.setContent("baseline", "edited");
    store.observeDiskContent("baseline", "moved on disk");

    const entry = () => useFileDirtyStore.getState().dirtyFiles.get("baseline")!;
    expect(entry().originalContent).toBe("moved on disk");
    expect(fileSaveBaseline(entry())).toBe("loaded");

    // Disk coming back to the baseline needs no separate record.
    store.observeDiskContent("baseline", "loaded");
    expect(entry().baseContent).toBeUndefined();

    store.observeDiskContent("baseline", "moved again");
    store.markSaved("baseline", "edited");
    expect(fileSaveBaseline(entry())).toBe("edited");

    store.observeDiskContent("baseline", "moved after save");
    store.setOriginalContent("baseline", "loaded fresh");
    expect(fileSaveBaseline(entry())).toBe("loaded fresh");
  });

  test("a restored draft checks against what it was edited from", () => {
    const store = useFileDirtyStore.getState();
    store.hydrateDraft("draft", "edited", "disk now", "edited from");
    expect(fileSaveBaseline(useFileDirtyStore.getState().dirtyFiles.get("draft")!)).toBe(
      "edited from",
    );
  });
});
