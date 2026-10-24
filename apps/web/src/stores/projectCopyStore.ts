import { create } from "zustand";

/**
 * The open "Copy project to machine" dialog, if any. Any project menu opens
 * it (this machine's projects and other machines'), and so does a
 * coordinator's request to copy its project, which the user approves there.
 */
export interface ProjectCopyDialogRequest {
  source: { nodeId: string; projectId: string };
  /** Preselected (and, for a coordinator's request, fixed) target machine. */
  targetNodeId?: string;
  location?: string;
  /** Paths to tick in addition to the suggested ones. */
  paths?: string[];
  /** The coordinator request this copy approves. */
  actionRequestId?: string;
  reason?: string;
}

interface ProjectCopyStore {
  request: ProjectCopyDialogRequest | null;
  open: (request: ProjectCopyDialogRequest) => void;
  close: () => void;
}

export const useProjectCopyStore = create<ProjectCopyStore>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));
