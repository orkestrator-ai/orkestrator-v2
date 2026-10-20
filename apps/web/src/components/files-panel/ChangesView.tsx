import type { ChangeFileRow } from "@orkestrator/protocol/change-resources";
import { useFilesPanelStore } from "@/stores";
import { useTerminalContext, type CreateFileTabOptions } from "@/contexts";
import { ChangedFileItem } from "./ChangedFileItem";
import { ChangeFileRowItem, changeRowPath, changeRowStatusLetter } from "./ChangeFileRowItem";
import { useEnvironmentChangeRows } from "./useEnvironmentChangeRows";
import { Loader2, GitBranch } from "lucide-react";
import { useMediaQuery } from "@/hooks";
import { changeReason, projectionTitle } from "@/lib/changes/labels";
import { Button } from "@/components/ui/button";

interface ChangesViewProps {
  /**
   * Environment whose `environment-net` projection supplies the rows (the
   * same measurement as its sidebar badge). Without one, or on an older
   * backend that has no projection, the legacy git-status list is shown.
   */
  environmentId?: string | null;
  onReveal?: (path: string) => void;
  onRevert?: (path: string) => void;
  onDelete?: (path: string) => void;
  /** Opens a file when no environment panes are mounted (the project root). */
  onOpenFile?: (path: string, options?: CreateFileTabOptions) => void;
}

function basename(path: string): string {
  return path.split("/").at(-1) || path;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
      {children}
    </div>
  );
}

function LoadingChanges() {
  return (
    <Centered>
      <Loader2 className="mb-2 h-6 w-6 animate-spin" />
      <p className="text-sm">Loading changes...</p>
    </Centered>
  );
}

export function ChangesView({
  environmentId,
  onReveal,
  onRevert,
  onDelete,
  onOpenFile,
}: ChangesViewProps = {}) {
  const changes = useFilesPanelStore((state) => state.changes);
  const isLoadingChanges = useFilesPanelStore((state) => state.isLoadingChanges);
  const closePanel = useFilesPanelStore((state) => state.closePanel);
  const { createFileTab } = useTerminalContext();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const changeRows = useEnvironmentChangeRows(environmentId);
  const { projection, resourceKey } = changeRows;

  const openFile = (path: string, options: CreateFileTabOptions) => {
    const open = createFileTab ?? onOpenFile;
    if (!open) return;
    open(path, options);
    if (isMobile) closePanel();
  };

  const handleFileClick = (path: string, status: string) => {
    // Open in diff mode when clicking from Changes view
    openFile(path, { isDiff: true, gitStatus: status });
  };

  const handleRowClick = (row: ChangeFileRow) => {
    if (!projection || !resourceKey) return;
    const path = changeRowPath(row);
    openFile(path, {
      isDiff: true,
      gitStatus: changeRowStatusLetter(row.status),
      changeDiff: {
        kind: "live",
        resourceKey,
        pathId: row.pathId,
        rowId: row.rowId,
        revision: projection.revision,
        title: basename(path),
      },
    });
  };

  if (projection) {
    if (projection.state === "loading" || changeRows.loadingFirstPage) return <LoadingChanges />;
    const { rows } = changeRows;
    if (rows.length === 0) {
      const unavailable =
        projection.state === "unavailable" ||
        projection.state === "deleted" ||
        (projection.measurementId !== null && projection.hasFileChanges !== false);
      return (
        <Centered>
          <GitBranch className="mb-2 h-8 w-8 opacity-50" />
          <p className="text-sm">{unavailable ? "Changes unavailable" : "No changes"}</p>
          {projection.reasonKeys.map((reason) => (
            <p key={reason} className="mt-1 px-4 text-xs">
              {changeReason(reason)}
            </p>
          ))}
        </Centered>
      );
    }
    return (
      <div
        className="p-2"
        data-testid="change-rows"
        data-measurement-id={projection.measurementId ?? ""}
        data-change-state={projection.state}
      >
        {projection.state !== "ready" && projection.reasonKeys.length > 0 && (
          <p
            className="mb-1 px-2 text-[11px] text-muted-foreground"
            title={projectionTitle(projection)}
            data-testid="change-rows-reasons"
          >
            {projection.reasonKeys.map(changeReason).join(" · ")}
          </p>
        )}
        {rows.map((row) => (
          <ChangeFileRowItem
            key={row.rowId}
            row={row}
            onClick={handleRowClick}
            onReveal={onReveal}
            onRevert={onRevert}
            onDelete={onDelete}
          />
        ))}
        {changeRows.hasMore && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 w-full text-xs text-muted-foreground"
            disabled={changeRows.loadingMore}
            onClick={changeRows.loadMore}
          >
            {changeRows.loadingMore
              ? "Loading more files..."
              : changeRows.totalRows !== null
                ? `Show more files (${rows.length} of ${changeRows.totalRows})`
                : "Show more files"}
          </Button>
        )}
      </div>
    );
  }

  if (isLoadingChanges) return <LoadingChanges />;

  if (changes.length === 0) {
    return (
      <Centered>
        <GitBranch className="mb-2 h-8 w-8 opacity-50" />
        <p className="text-sm">No changes</p>
      </Centered>
    );
  }

  return (
    <div className="p-2">
      {changes.map((change) => (
        <ChangedFileItem
          key={change.path}
          change={change}
          onClick={(path) => handleFileClick(path, change.status)}
          onReveal={onReveal}
          onRevert={onRevert}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}
