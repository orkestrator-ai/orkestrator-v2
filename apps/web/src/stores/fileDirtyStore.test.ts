import { beforeEach, describe, expect, test } from "bun:test";
import { useFileDirtyStore } from "./fileDirtyStore";

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
});
