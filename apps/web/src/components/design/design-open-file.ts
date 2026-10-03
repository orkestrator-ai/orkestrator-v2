import { DESIGN_EXPORT_NAME, DESIGN_EXPORT_PATH_MAX } from "./design-export-path";
import { toast } from "sonner";
import type { CreatableTabType, CreateTabOptions } from "@/contexts/TerminalContext";
import { designApi, failureOf } from "./design-client";

export const isDesignFilePath = (filePath: string) =>
  filePath.length <= DESIGN_EXPORT_PATH_MAX && DESIGN_EXPORT_NAME.test(filePath);

/**
 * Opens a repository `.orkdes` file in the design canvas. The backend reuses
 * the canvas already made from the same file content, otherwise imports it,
 * so opening a file twice focuses one canvas.
 */
export async function openDesignFile(
  environmentId: string,
  relativePath: string,
  createTab: (type: CreatableTabType, options?: CreateTabOptions) => boolean,
  deps: {
    openFile: typeof designApi.openFile;
    reportError: (message: string) => void;
  } = {
    openFile: designApi.openFile,
    reportError: (message) => toast.error("Could not open design", { description: message }),
  },
): Promise<void> {
  try {
    const { canvasId } = await deps.openFile(environmentId, relativePath);
    if (!createTab("design-canvas", { canvasId, designPlacement: "current" }))
      deps.reportError("The design could not be opened in this layout. Close a tab and try again.");
  } catch (error) {
    deps.reportError(failureOf(error).message);
  }
}
