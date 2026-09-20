import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useState } from "react";
import { Paintbrush } from "lucide-react";
import type { DesignCanvas } from "@orkestrator/protocol/design-canvas";
import type { CreatableTabType, CreateTabOptions } from "@/contexts/TerminalContext";
import { MAX_TABS } from "@/contexts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { invoke } from "@/lib/native/backend";
import { designAction } from "./design-client";

export function DesignLaunchButton({
  environmentId,
  disabled,
  tabCount,
  createTab,
}: {
  environmentId?: string;
  disabled: boolean;
  tabCount: number;
  createTab: ((type: CreatableTabType, options?: CreateTabOptions) => boolean) | null;
}) {
  const hydrated = usePaneLayoutStore((state) =>
    environmentId ? state.hydration.get(environmentId) === "done" : false,
  );
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const [name, setName] = useState("Untitled design");
  const [agent, setAgent] = useState<"claude" | "codex">("claude");
  const [prompt, setPrompt] = useState("");
  const [existing, setExisting] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const fail = (reason: unknown) =>
    setError(reason instanceof Error ? reason.message : String(reason));
  const openCanvas = (canvasId: string) => {
    if (!createTab?.("design-canvas", { canvasId }))
      throw new Error("No room for a design tab. Close a tab and try again.");
    setOpen(false);
  };
  const create = async () => {
    if (!environmentId || !createTab) return;
    setBusy(true);
    setError(null);
    try {
      const canvas = await designAction<DesignCanvas>(environmentId, "create_canvas", { name });
      // The ordinary native chat owns approvals, prompts and background work.
      // The adjacent design tab carries no duplicated session or document state.
      const initialPrompt = `Use the orkestrator-design MCP server for this design workspace. Canvas ID: ${canvas.id}. First call get_canvas. Review the current repository, then build HTML/CSS mockups in this canvas. Designs must be self-contained, with embedded CSS and data-URL images/fonts; authored scripts and remote resources are disabled. Use frame revisions for edits, re-read on conflicts, and capture_frame to review your work. Save the finished export_canvas JSON to a .orkdes file in this repository.\n\n${prompt.trim() || "Review this repository and propose an initial design mockup."}`;
      if (!createTab(agent, { agentLaunchMode: "native", displayTitle: "Design", initialPrompt }))
        throw new Error("Could not open design agent");
      openCanvas(canvas.id);
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        aria-label="New design workspace"
        disabled={disabled || !environmentId || !hydrated}
        onClick={() => {
          setOpen(true);
          setError(null);
          if (environmentId)
            void designAction<Array<{ id: string; name: string }>>(environmentId, "list_canvases")
              .then(setExisting)
              .catch(fail);
        }}
      >
        <Paintbrush className="size-4" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Design workspace</DialogTitle>
            <DialogDescription>
              Design with Claude or Codex on the left and a shared HTML canvas on the right.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <label className="grid gap-1 text-sm">
              Name
              <input
                className="rounded border bg-background p-2"
                required
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="grid gap-1 text-sm">
              Agent
              <select
                aria-label="Design agent"
                className="rounded border bg-background p-2"
                value={agent}
                onChange={(event) => setAgent(event.target.value as "claude" | "codex")}
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              Design brief
              <textarea
                className="min-h-24 rounded border bg-background p-2"
                maxLength={20000}
                placeholder="Review this repo and mock up…"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </label>
            {tabCount > MAX_TABS - 2 && (
              <p className="text-sm text-muted-foreground">
                Close a tab to make room for the chat and canvas.
              </p>
            )}
            <Button type="submit" disabled={busy || tabCount > MAX_TABS - 2}>
              {busy ? "Opening…" : "Create design workspace"}
            </Button>
          </form>
          {existing.length > 0 && (
            <label className="grid gap-1 text-sm">
              Open a saved canvas
              <select
                className="rounded border bg-background p-2"
                defaultValue=""
                onChange={(event) => {
                  if (event.target.value) {
                    try {
                      openCanvas(event.target.value);
                    } catch (reason) {
                      fail(reason);
                    }
                  }
                }}
              >
                <option value="" disabled>
                  Choose canvas…
                </option>
                {existing.map((canvas) => (
                  <option key={canvas.id} value={canvas.id}>
                    {canvas.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="grid gap-1 text-sm">
            Import .orkdes
            <input
              type="file"
              accept=".orkdes,application/json"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file || !environmentId) return;
                if (file.size > 4 * 1024 * 1024) {
                  setError("Design file exceeds 4 MiB");
                  return;
                }
                setBusy(true);
                void file
                  .text()
                  .then((document) =>
                    invoke<DesignCanvas>("design_import", { environmentId, document }),
                  )
                  .then((canvas) => openCanvas(canvas.id))
                  .catch(fail)
                  .finally(() => setBusy(false));
              }}
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
