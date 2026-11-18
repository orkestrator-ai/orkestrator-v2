import { useState } from "react";
import { useFileMentions } from "./useFileMentions";
import { useFileSearch } from "./useFileSearch";

export function useComposerFileMentions(
  containerId: string | undefined,
  worktreePath: string | undefined,
) {
  const [open, setOpen] = useState(false);
  const fileSearch = useFileSearch(containerId, worktreePath, open, "composer");
  const mentions = useFileMentions({
    searchFiles: fileSearch.searchFiles,
    openState: { open, setOpen },
    onEmptyEnter: fileSearch.error ? fileSearch.refresh : undefined,
  });
  return { ...mentions, fileSearch };
}
