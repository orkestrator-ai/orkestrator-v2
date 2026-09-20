import type { DesignCanvas } from "@orkestrator/protocol/design-canvas";
import type { CreatableTabType, CreateTabOptions } from "@/contexts/TerminalContext";

export async function launchDesignWorkspace(options: {
  name: string;
  agent: "claude" | "codex";
  prompt: string;
  agentTabId: string;
  action: <T>(action: string, input: Record<string, unknown>) => Promise<T>;
  createTab: (type: CreatableTabType, options?: CreateTabOptions) => boolean;
  openCanvas: (canvasId: string) => void;
  removeAgentTab: (tabId: string) => void;
}): Promise<DesignCanvas> {
  let canvas: DesignCanvas | null = null;
  try {
    canvas = await options.action<DesignCanvas>("create_canvas", { name: options.name });
    const initialPrompt = `Use the orkestrator-design MCP server for this design workspace. Canvas ID: ${canvas.id}. First call get_canvas. Review the current repository, then build HTML/CSS mockups in this canvas. Designs must be self-contained, with embedded CSS and data-URL images/fonts; authored scripts and remote resources are disabled. Use frame revisions for edits, re-read on conflicts, and capture_frame to review your work. Save the finished export_canvas JSON to a .orkdes file in this repository.\n\n${options.prompt.trim() || "Review this repository and propose an initial design mockup."}`;
    if (
      !options.createTab(options.agent, {
        tabId: options.agentTabId,
        agentLaunchMode: "native",
        displayTitle: "Design",
        initialPrompt,
      })
    ) {
      throw new Error("Could not open design agent");
    }
    options.openCanvas(canvas.id);
    return canvas;
  } catch (error) {
    options.removeAgentTab(options.agentTabId);
    if (canvas)
      await options.action("delete_canvas", { canvasId: canvas.id }).catch(() => undefined);
    throw error;
  }
}

export async function importAndOpenDesign(options: {
  document: string;
  importCanvas: (document: string) => Promise<DesignCanvas>;
  openCanvas: (canvasId: string) => void;
  deleteCanvas: (canvasId: string) => Promise<unknown>;
}): Promise<DesignCanvas> {
  const canvas = await options.importCanvas(options.document);
  try {
    options.openCanvas(canvas.id);
    return canvas;
  } catch (error) {
    await options.deleteCanvas(canvas.id).catch(() => undefined);
    throw error;
  }
}
