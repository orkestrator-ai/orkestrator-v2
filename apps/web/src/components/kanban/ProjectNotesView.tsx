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
  const notesError = useKanbanStore((s) => s.notesError);
  const currentNotesProjectId = useKanbanStore((s) => s.currentNotesProjectId);
  const getProjectById = useProjectStore((s) => s.getProjectById);

  const project = getProjectById(projectId);
  // A failed load leaves an empty editor that is not this project's content, so
  // it must stay disabled until a retry succeeds. An enabled empty editor
  // could save its first keystroke over the real backend notes.
  const notesReady = currentNotesProjectId === projectId && !notesLoading && !notesError;
  const [draft, setDraft, , discardDurableDraft] = useDurableComposeDraft<string>({
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
  const editRevisionRef = useRef(0);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    void loadNotes(projectId);
  }, [projectId, loadNotes]);

  const persistNotes = useCallback(
    (value: string, editRevision: number) => {
      const queuedSave = saveQueueRef.current.then(async () => {
        try {
          await saveNotes(projectId, value);
          // A newer edit may have landed while this request was in flight. Only
          // discard the recovery record when the completed save still represents
          // the live editor; otherwise the newer text must remain recoverable.
          if (editRevisionRef.current === editRevision) {
            await discardDurableDraft();
          }
        } catch (error) {
          console.warn("[ProjectNotesView] Notes remain in the durable draft:", error);
        }
      });
      // Serialize writes so an older slow save can never complete after a newer
      // manual save and overwrite the backend with stale content.
      saveQueueRef.current = queuedSave;
      return queuedSave;
    },
    [discardDurableDraft, projectId, saveNotes],
  );

  const handleChange = useCallback(
    (value: string) => {
      // Disabling the textarea is an affordance, not a guard: nothing may be
      // written back while the editor is not showing this project's loaded
      // notes.
      if (!notesReady) return;
      editRevisionRef.current += 1;
      setDraft(value);
    },
    [notesReady, setDraft],
  );

  const handleSaveNow = () => {
    void persistNotes(draft, editRevisionRef.current);
  };

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
        {isDirty && <span className="text-xs text-muted-foreground italic">Unsaved changes</span>}
        <div className="ml-auto">
          <Button size="sm" onClick={handleSaveNow} disabled={!isDirty}>
            Save
          </Button>
        </div>
      </div>

      {notesError && (
        <div
          role="alert"
          className="flex items-center gap-3 border-b border-destructive/20 bg-destructive/10 px-6 py-2 text-xs text-destructive"
        >
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">
            Couldn’t load these notes: {notesError}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-7 shrink-0"
            onClick={() => {
              void loadNotes(projectId);
            }}
          >
            Retry
          </Button>
        </div>
      )}

      {/* Notes Editor */}
      <div className="flex-1 p-6">
        <Textarea
          value={notesReady ? draft : ""}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="Write project notes here... These notes are shared across all environments in this project."
          className="h-full min-h-[300px] resize-none text-sm font-mono"
          disabled={!notesReady}
        />
      </div>
    </div>
  );
}
