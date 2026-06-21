// Mock implementations for backend commands
import type { Project, Environment, AppConfig, EnvironmentStatus } from "../../../src/types";
import { mock, type Mock } from "bun:test";
import { createMockProject, createMockEnvironment } from "../utils/testFactories";

// Create mock functions that can be configured per test
export const mockGetProjects = mock<() => Promise<Project[]>>(() => Promise.resolve([]));
export const mockAddProject = mock<(gitUrl: string, localPath?: string) => Promise<Project>>(
  (gitUrl: string) => Promise.resolve(createMockProject({ gitUrl }))
);
export const mockRemoveProject = mock<(projectId: string) => Promise<void>>(() => Promise.resolve());
export const mockValidateGitUrl = mock<(url: string) => Promise<boolean>>(() => Promise.resolve(true));

export const mockGetEnvironments = mock<(projectId: string) => Promise<Environment[]>>(() => Promise.resolve([]));
export const mockGetEnvironment = mock<(environmentId: string) => Promise<Environment | null>>(() =>
  Promise.resolve(null)
);
export const mockCreateEnvironment = mock<(projectId: string) => Promise<Environment>>((projectId: string) =>
  Promise.resolve(createMockEnvironment({ projectId }))
);
export const mockDeleteEnvironment = mock<(environmentId: string) => Promise<void>>(() => Promise.resolve());
export const mockStartEnvironment = mock<(environmentId: string) => Promise<void>>(() => Promise.resolve());
export const mockStopEnvironment = mock<(environmentId: string) => Promise<void>>(() => Promise.resolve());
export const mockSyncEnvironmentStatus = mock<(environmentId: string) => Promise<Environment>>(
  (environmentId: string) =>
    Promise.resolve(createMockEnvironment({ id: environmentId, containerId: "mock-container", status: "running" }))
);

export const mockCreateTerminalSession = mock<(containerId: string, cols: number, rows: number) => Promise<string>>(
  () => Promise.resolve("mock-session-id")
);
export const mockStartTerminalSession = mock<(sessionId: string) => Promise<void>>(() => Promise.resolve());
export const mockDetachTerminal = mock<(sessionId: string) => Promise<void>>(() => Promise.resolve());
export const mockWriteTerminal = mock<(sessionId: string, data: string) => Promise<void>>(() => Promise.resolve());
export const mockResizeTerminal = mock<(sessionId: string, cols: number, rows: number) => Promise<void>>(() =>
  Promise.resolve()
);

export const mockGetEnvironmentPrUrl = mock<(environmentId: string) => Promise<string | null>>(() =>
  Promise.resolve(null)
);
export const mockClearEnvironmentPr = mock<(environmentId: string) => Promise<void>>(() => Promise.resolve());
export const mockSetEnvironmentPr = mock<(environmentId: string, prUrl: string) => Promise<Environment>>(
  (environmentId: string, prUrl: string) =>
    Promise.resolve(createMockEnvironment({ id: environmentId, containerId: "mock-container", status: "running", prUrl }))
);
export const mockOpenInBrowser = mock<(url: string) => Promise<void>>(() => Promise.resolve());

// Export all mocks for easy resetting
export const allMocks = [
  mockGetProjects,
  mockAddProject,
  mockRemoveProject,
  mockValidateGitUrl,
  mockGetEnvironments,
  mockGetEnvironment,
  mockCreateEnvironment,
  mockDeleteEnvironment,
  mockStartEnvironment,
  mockStopEnvironment,
  mockSyncEnvironmentStatus,
  mockCreateTerminalSession,
  mockStartTerminalSession,
  mockDetachTerminal,
  mockWriteTerminal,
  mockResizeTerminal,
  mockGetEnvironmentPrUrl,
  mockClearEnvironmentPr,
  mockSetEnvironmentPr,
  mockOpenInBrowser,
];

export function resetAllMocks() {
  allMocks.forEach((m) => m.mockClear());
}

// Default export object matching the backend module interface
export default {
  getProjects: mockGetProjects,
  addProject: mockAddProject,
  removeProject: mockRemoveProject,
  validateGitUrl: mockValidateGitUrl,
  getEnvironments: mockGetEnvironments,
  getEnvironment: mockGetEnvironment,
  createEnvironment: mockCreateEnvironment,
  deleteEnvironment: mockDeleteEnvironment,
  startEnvironment: mockStartEnvironment,
  stopEnvironment: mockStopEnvironment,
  syncEnvironmentStatus: mockSyncEnvironmentStatus,
  createTerminalSession: mockCreateTerminalSession,
  startTerminalSession: mockStartTerminalSession,
  detachTerminal: mockDetachTerminal,
  writeTerminal: mockWriteTerminal,
  resizeTerminal: mockResizeTerminal,
  getEnvironmentPrUrl: mockGetEnvironmentPrUrl,
  clearEnvironmentPr: mockClearEnvironmentPr,
  setEnvironmentPr: mockSetEnvironmentPr,
  openInBrowser: mockOpenInBrowser,
};
