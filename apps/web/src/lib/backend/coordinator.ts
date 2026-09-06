import type { CoordinatorSnapshot, ProjectGitStatus } from "@orkestrator/protocol/coordinator";
import { invoke } from "@/lib/native/backend";

export const ensureProjectCoordinator = (projectId: string): Promise<CoordinatorSnapshot> =>
  invoke("ensure_project_coordinator", { projectId });

export const getProjectCoordinator = (projectId: string): Promise<CoordinatorSnapshot | null> =>
  invoke("get_project_coordinator", { projectId });

export const createCoordinatorConversation = (
  projectId: string,
  title?: string,
): Promise<CoordinatorSnapshot> => invoke("create_coordinator_conversation", { projectId, title });

export const selectCoordinatorConversation = (
  projectId: string,
  conversationId: string | null,
): Promise<CoordinatorSnapshot> =>
  invoke("select_coordinator_conversation", { projectId, conversationId });

export const closeCoordinatorConversation = (
  projectId: string,
  conversationId: string,
): Promise<CoordinatorSnapshot> =>
  invoke("close_coordinator_conversation", { projectId, conversationId });

export const pauseProjectCoordinator = (projectId: string): Promise<CoordinatorSnapshot> =>
  invoke("pause_project_coordinator", { projectId });

export const resumeProjectCoordinator = (projectId: string): Promise<CoordinatorSnapshot> =>
  invoke("resume_project_coordinator", { projectId });

export const getProjectGitStatus = (projectId: string): Promise<ProjectGitStatus> =>
  invoke("get_project_git_status", { projectId });

export const fetchProjectGit = (projectId: string, force = false): Promise<ProjectGitStatus> =>
  invoke("fetch_project_git", { projectId, force });

export const syncProjectGit = (projectId: string): Promise<ProjectGitStatus> =>
  invoke("sync_project_git", { projectId });

export const switchProjectGitBranch = (projectId: string, ref: string): Promise<ProjectGitStatus> =>
  invoke("switch_project_git_branch", { projectId, ref });

export const writeCoordinatorAttachment = (
  environmentId: string,
  filename: string,
  base64Data: string,
): Promise<string> =>
  invoke("write_coordinator_attachment", { environmentId, filename, base64Data });
