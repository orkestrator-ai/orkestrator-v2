import { FolderGit2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Shared loading and empty states for the project lists. Offer creation or
 * clearing a filter according to the machines shown.
 */
export function SidebarEmptyState({
  loading = false,
  message = "No projects yet",
  onAdd,
  onClearFilter,
}: {
  loading?: boolean;
  message?: string;
  onAdd?: () => void;
  onClearFilter?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
      <FolderGit2 className="h-8 w-8 mb-2 opacity-50" />
      <p className="text-sm">{loading ? "Loading projects..." : message}</p>
      {!loading && onAdd ? (
        <Button variant="link" size="sm" onClick={onAdd}>
          Add your first project
        </Button>
      ) : null}
      {!loading && onClearFilter ? (
        <Button variant="link" size="sm" onClick={onClearFilter}>
          Clear machine filter
        </Button>
      ) : null}
    </div>
  );
}
