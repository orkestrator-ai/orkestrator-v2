import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft } from "lucide-react";
import { useKanbanStore } from "@/stores/kanbanStore";
import { useProjectStore } from "@/stores";

interface ProjectNotesViewProps {
  projectId: string;
  onBack: () => void;
}

export function ProjectNotesView({ projectId, onBack }: ProjectNotesViewProps) {
  const notes = useKanbanStore((s) => s.notes);
  const loadNotes = useKanbanStore((s) => s.loadNotes);
  const saveNotes = useKanbanStore((s) => s.saveNotes);
  const getProjectById = useProjectStore((s) => s.getProjectById);

  const project = getProjectById(projectId);
  const [draft, setDraft] = useState(notes);
  const [isDirty, setIsDirty] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef(draft);
  const isDirtyRef = useRef(isDirty);
  draftRef.current = draft;
  isDirtyRef.current = isDirty;

  useEffect(() => {
    void loadNotes(projectId);
  }, [projectId, loadNotes]);

  // Sync draft when notes load from backend
  useEffect(() => {
    setDraft(notes);
    setIsDirty(false);
  }, [notes]);

  const handleChange = useCallback(
    (value: string) => {
      setDraft(value);
      setIsDirty(true);

      // Auto-save after 1 second of inactivity
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      saveTimeoutRef.current = setTimeout(() => {
        void saveNotes(projectId, value);
        setIsDirty(false);
      }, 1000);
    },
    [projectId, saveNotes]
  );

  const handleSaveNow = () => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    void saveNotes(projectId, draft);
    setIsDirty(false);
  };

  // Clean up timeout on unmount and flush save if dirty
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      if (isDirtyRef.current) {
        void saveNotes(projectId, draftRef.current);
      }
    };
  }, [projectId, saveNotes]);

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
        />
      </div>
    </div>
  );
}
