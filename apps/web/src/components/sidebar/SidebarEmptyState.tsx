import { FolderGit2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * A project list with nothing to show yet: this window's tree, another
 * machine's section and the merged lists all say it the same way. `onAdd`
 * offers "Add your first project" where the list's machine accepts one.
 */
export function SidebarEmptyState({
  loading = false,
  onAdd,
}: {
  loading?: boolean;
  onAdd?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
      <FolderGit2 className="h-8 w-8 mb-2 opacity-50" />
      <p className="text-sm">{loading ? "Loading projects..." : "No projects yet"}</p>
      {!loading && onAdd ? (
        <Button variant="link" size="sm" onClick={onAdd}>
          Add your first project
        </Button>
      ) : null}
    </div>
  );
}
