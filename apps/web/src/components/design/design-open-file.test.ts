import { describe, expect, mock, test } from "bun:test";
import { DesignClientError } from "./design-client";
import { isDesignFilePath, openDesignFile } from "./design-open-file";

describe("isDesignFilePath", () => {
  test("matches .orkdes files in any folder, case-insensitively", () => {
    expect(isDesignFilePath("designs/home.orkdes")).toBe(true);
    expect(isDesignFilePath("home.ORKDES")).toBe(true);
    expect(isDesignFilePath("home.orkdes.json")).toBe(false);
    expect(isDesignFilePath("notes.md")).toBe(false);
  });
});

describe("openDesignFile", () => {
  test("opens the canvas the backend resolves in the current pane", async () => {
    const createTab = mock(() => true);
    const reportError = mock(() => {});
    const openFile = mock(async () => ({ canvasId: "canvas-1", imported: true }));
    await openDesignFile("env-1", "designs/home.orkdes", createTab, { openFile, reportError });
    expect(openFile).toHaveBeenCalledWith("env-1", "designs/home.orkdes");
    expect(createTab).toHaveBeenCalledWith("design-canvas", {
      canvasId: "canvas-1",
      designPlacement: "current",
    });
    expect(reportError).not.toHaveBeenCalled();
  });

  test("reports a backend failure without opening a tab", async () => {
    const createTab = mock(() => true);
    const reportError = mock((_message: string) => {});
    const openFile = mock(async () => {
      throw new DesignClientError({
        code: "invalid-input",
        message: "designs/x.orkdes could not be read as a design file",
        retry: "never",
      });
    });
    await openDesignFile("env-1", "designs/x.orkdes", createTab, { openFile, reportError });
    expect(createTab).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith("designs/x.orkdes could not be read as a design file");
  });

  test("reports a layout that cannot take another tab", async () => {
    const reportError = mock((_message: string) => {});
    await openDesignFile("env-1", "a.orkdes", () => false, {
      openFile: async () => ({ canvasId: "c", imported: false }),
      reportError,
    });
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
