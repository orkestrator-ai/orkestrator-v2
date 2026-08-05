import { useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft } from "lucide-react";
import { useKanbanStore } from "@/stores/kanbanStore";
import { useProjectStore } from "@/stores";
import { useDurableComposeDraft } from "@/hooks/useDurableComposeDraft";

interface ProjectNotesViewProps {
  projectId: string;
  onBack: () => void;
}

export function ProjectNotesView({ projectId, onBack }: ProjectNotesViewProps) {
  const notes = useKanbanStore((s) => s.notes);
  const loadNotes = useKanbanStore((s) => s.loadNotes);
  const saveNotes = useKanbanStore((s) => s.saveNotes);
  const notesLoading = useKanbanStore((s) => s.notesLoading);
  const currentNotesProjectId = useKanbanStore((s) => s.currentNotesProjectId);
  const getProjectById = useProjectStore((s) => s.getProjectById);

  const project = getProjectById(projectId);
  const notesReady = currentNotesProjectId === projectId && !notesLoading;
  const [draft, setDraft, clearDurableDraft] = useDurableComposeDraft<string>({
    ownerType: "project",
    ownerId: projectId,
    namespace: "project-notes",
    localKey: "editor",
    initialValue: notes,
    isEmpty: (value) => value.length === 0,
    isValid: (value): value is string => typeof value === "string",
    enabled: notesReady,
  });
  const isDirty = notesReady && draft !== notes;
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void loadNotes(projectId);
  }, [projectId, loadNotes]);

  const persistNotes = useCallback(async (value: string) => {
    try {
      await saveNotes(projectId, value);
      await clearDurableDraft();
    } catch (error) {
      console.warn("[ProjectNotesView] Notes remain in the durable draft:", error);
    }
  }, [clearDurableDraft, projectId, saveNotes]);

  const handleChange = useCallback(
    (value: string) => {
      setDraft(value);

      // Auto-save after 1 second of inactivity
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      saveTimeoutRef.current = setTimeout(() => {
        void persistNotes(value);
      }, 1000);
    },
    [persistNotes, setDraft]
  );

  const handleSaveNow = () => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    void persistNotes(draft);
  };

  // The durable draft hook flushes on unmount; only cancel the convenience
  // auto-save timer here so a hidden view cannot race a later explicit save.
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-border">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h2 className="text-lg font-semibold text-foreground">
          {project?.name ?? "Project"} Notes
        </h2>
        {isDirty && (
          <span className="text-xs text-muted-foreground italic">Unsaved changes</span>
        )}
        <div className="ml-auto">
          <Button size="sm" onClick={handleSaveNow} disabled={!isDirty}>
            Save
          </Button>
        </div>
      </div>

      {/* Notes Editor */}
      <div className="flex-1 p-6">
        <Textarea
          value={draft}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="Write project notes here... These notes are shared across all environments in this project."
          className="h-full min-h-[300px] resize-none text-sm font-mono"
          disabled={!notesReady}
        />
      </div>
    </div>
  );
}
