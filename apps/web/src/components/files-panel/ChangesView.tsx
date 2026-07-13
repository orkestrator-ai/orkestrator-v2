import { useFilesPanelStore } from "@/stores";
import { useTerminalContext } from "@/contexts";
import { ChangedFileItem } from "./ChangedFileItem";
import { Loader2, GitBranch } from "lucide-react";
import { useMediaQuery } from "@/hooks";

export function ChangesView() {
  const { changes, isLoadingChanges, closePanel } = useFilesPanelStore();
  const { createFileTab } = useTerminalContext();
  const isMobile = useMediaQuery("(max-width: 767px)");

  const handleFileClick = (path: string, status: string) => {
    if (!createFileTab) return;
    // Open in diff mode when clicking from Changes view
    createFileTab(path, { isDiff: true, gitStatus: status });
    if (isMobile) closePanel();
  };

  if (isLoadingChanges) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="mb-2 h-6 w-6 animate-spin" />
        <p className="text-sm">Loading changes...</p>
      </div>
    );
  }

  if (changes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
        <GitBranch className="mb-2 h-8 w-8 opacity-50" />
        <p className="text-sm">No changes</p>
      </div>
    );
  }

  return (
    <div className="p-2">
      {changes.map((change) => (
        <ChangedFileItem
          key={change.path}
          change={change}
          onClick={(path) => handleFileClick(path, change.status)}
        />
      ))}
    </div>
  );
}
