// Test factory functions for creating mock data
import type {
  Project,
  Environment,
  EnvironmentStatus,
  AppConfig,
  RepositoryConfig,
} from "../../../apps/web/src/types";
import {
  DEFAULT_TERMINAL_APPEARANCE,
  DEFAULT_TERMINAL_SCROLLBACK,
} from "../../../apps/web/src/constants/terminal";

/**
 * Creates a mock Project with sensible defaults that can be overridden
 */
export function createMockProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "mock-project-id",
    name: "mock-repo",
    gitUrl: "git@github.com:test/repo.git",
    localPath: null,
    addedAt: new Date().toISOString(),
    order: 0,
    ...overrides,
  };
}

/**
 * Creates a mock Environment with sensible defaults that can be overridden
 */
export function createMockEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "mock-env-id",
    projectId: "mock-project-id",
    name: "mock-env",
    branch: "mock-env",
    containerId: null,
    status: "stopped" satisfies EnvironmentStatus,
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date().toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: "containerized",
    ...overrides,
  };
}

/**
 * Creates a mock RepositoryConfig with sensible defaults
 */
export function createMockRepositoryConfig(
  overrides: Partial<RepositoryConfig> = {},
): RepositoryConfig {
  return {
    defaultBranch: "main",
    prBaseBranch: "main",
    ...overrides,
  };
}

/**
 * Creates a mock AppConfig with sensible defaults
 */
export function createMockAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    version: "1.0",
    global: {
      containerResources: {
        cpuCores: 2,
        memoryGb: 4,
      },
      envFilePatterns: [".env.local", ".env"],
      allowedDomains: [],
      terminalAppearance: { ...DEFAULT_TERMINAL_APPEARANCE },
      terminalScrollback: DEFAULT_TERMINAL_SCROLLBACK,
      experimentalCodexRawEventLogging: true,
    },
    repositories: {},
    ...overrides,
  };
}

/**
 * Creates multiple mock projects with unique IDs
 */
export function createMockProjects(count: number, baseOverrides: Partial<Project> = {}): Project[] {
  return Array.from({ length: count }, (_, i) =>
    createMockProject({
      id: `project-${i + 1}`,
      name: `repo-${i + 1}`,
      gitUrl: `git@github.com:test/repo${i + 1}.git`,
      ...baseOverrides,
    }),
  );
}

/**
 * Creates multiple mock environments with unique IDs
 */
export function createMockEnvironments(
  count: number,
  projectId: string,
  baseOverrides: Partial<Environment> = {},
): Environment[] {
  return Array.from({ length: count }, (_, i) =>
    createMockEnvironment({
      id: `env-${i + 1}`,
      projectId,
      name: `env-${i + 1}`,
      ...baseOverrides,
    }),
  );
}
