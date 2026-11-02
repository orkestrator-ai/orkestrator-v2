import { defineLogAreas } from "./define.js";

export const WEB_FILES_LOG_AREAS = defineLogAreas({
  "web.files": {
    description: "The files panel, file viewer and file search.",
    events: {
      "file.save-failed": "A file could not be saved.",
      "git-changes.load-failed": "The files panel could not load the git changes.",
      "file-tree.load-failed": "The file tree could not be loaded.",
      "changes.refresh-failed": "Refreshing the files panel's changes failed.",
      "folder.load-failed": "An expanded folder's contents could not be loaded.",
      "path.copy-failed": "A file's path could not be copied to the clipboard.",
      "draft.persist-failed": "A file viewer tab's draft could not be saved.",
      "draft.restore-failed": "A file viewer tab's saved draft could not be restored.",
      "draft.discard-failed": "A file's saved draft could not be discarded before a reload.",
    },
  },
});
