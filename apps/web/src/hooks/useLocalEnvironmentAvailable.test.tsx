import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useProjectStore } from "@/stores/projectStore";
import { useLocalEnvironmentAvailable } from "./useLocalEnvironmentAvailable";
import type { Project } from "@/types";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    name: "Project One",
    gitUrl: "https://example.test/project-one.git",
    localPath: "/work/project-one",
    addedAt: "2026-08-11T00:00:00.000Z",
    order: 0,
    ...overrides,
  };
}

function Probe({ projectId }: { projectId: string | undefined | null }) {
  const available = useLocalEnvironmentAvailable(projectId);
  return <span data-testid="available">{String(available)}</span>;
}

const readAvailable = () => screen.getByTestId("available").textContent;

describe("useLocalEnvironmentAvailable", () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [] });
  });
  afterEach(cleanup);

  test("reports availability from the project's local checkout", () => {
    useProjectStore.setState({ projects: [makeProject()] });
    render(<Probe projectId="project-1" />);
    expect(readAvailable()).toBe("true");
  });

  test("reports unavailable for a known project with no checkout", () => {
    useProjectStore.setState({ projects: [makeProject({ localPath: null })] });
    render(<Probe projectId="project-1" />);
    expect(readAvailable()).toBe("false");
  });

  test("treats an unknown project as available while the store hydrates", () => {
    // `selectedProjectId` is restored synchronously from the persisted UI
    // store, so a project the list has not caught up with yet is "not loaded",
    // not "no checkout". Answering false here lets a launcher rewrite the
    // user's local default to containerized, and nothing rewrites it back.
    render(<Probe projectId="project-1" />);
    expect(readAvailable()).toBe("true");

    act(() => {
      useProjectStore.setState({ projects: [makeProject({ localPath: null })] });
    });
    expect(readAvailable()).toBe("false");
  });

  test("treats a missing project id as available", () => {
    render(<Probe projectId={undefined} />);
    expect(readAvailable()).toBe("true");
  });
});
