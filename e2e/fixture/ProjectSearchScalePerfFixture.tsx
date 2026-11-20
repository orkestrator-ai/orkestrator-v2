import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { ProjectSearchBar } from "../../apps/web/src/components/sidebar/ProjectSearchBar";
import { appCommandStore } from "../../apps/web/src/test/app-command-store";
import { uiStore } from "../../apps/web/src/stores/uiStore";
import type { Environment, Project } from "../../apps/web/src/types";

/**
 * The sidebar search over a large synthetic machine, for
 * `e2e/perf/project-search-open-perf.ts`:
 * `/project-search-scale-perf?projects=50&environments=2000`.
 *
 * `window.__projectSearchPerf.update()` replaces the environment list, as a
 * store update does, and returns how long React took to render and commit it
 * (`flushSync`), so the harness can time an update with the palette open or
 * closed. Names are synthetic; nothing here reads a real store or backend.
 */

declare global {
  interface Window {
    __projectSearchPerf?: { ready: true; update: () => number };
  }
}

const params = new URLSearchParams(window.location.search);
const PROJECTS = Number(params.get("projects") ?? 50);
const ENVIRONMENTS = Number(params.get("environments") ?? 500);
const BASE_TIME = Date.parse("2026-11-01T00:00:00.000Z");

const projects: Project[] = Array.from({ length: PROJECTS }, (_, index) => ({
  id: `project-${index}`,
  name: `project-${index}`,
  gitUrl: `https://github.com/acme/project-${index}.git`,
  localPath: `/code/project-${index}`,
  addedAt: "2026-01-01T00:00:00.000Z",
  order: index,
}));

function environments(revision: number): Environment[] {
  return Array.from({ length: ENVIRONMENTS }, (_, index) => ({
    id: `environment-${index}`,
    projectId: `project-${index % PROJECTS}`,
    name: `feature-${index}-search-scale`,
    branch: `feature-${index}-search-scale`,
    containerId: index % 2 === 0 ? `container-${index}` : null,
    status: index % 3 === 0 ? "running" : "stopped",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(BASE_TIME - index * 60_000).toISOString(),
    // One environment's activity moves on every update, as a live store does.
    lastActivityAt: new Date(
      BASE_TIME + (index === revision % ENVIRONMENTS ? revision * 1_000 : -index * 1_000),
    ).toISOString(),
    networkAccessMode: "restricted",
    order: index,
    environmentType: index % 2 === 0 ? "containerized" : "local",
    ...(index % 2 === 0 ? {} : { worktreePath: `/code/worktrees/feature-${index}` }),
  }));
}

function install() {
  window.orkestrator = {
    ...window.orkestrator!,
    listen: () => () => {},
    invoke: async <T,>() => [] as T,
  };
  appCommandStore(uiStore).setState({
    recentProjectIds: projects.slice(0, 8).map((project) => project.id),
  });
  return true;
}

let revision = 0;

export function ProjectSearchScalePerfFixture() {
  useState(install);
  const [list, setList] = useState(() => environments(revision));
  useEffect(() => {
    window.__projectSearchPerf = {
      ready: true,
      update: () => {
        revision += 1;
        const next = environments(revision);
        const start = performance.now();
        flushSync(() => setList(next));
        return performance.now() - start;
      },
    };
    return () => {
      delete window.__projectSearchPerf;
    };
  }, []);
  return (
    <main className="w-72">
      <ProjectSearchBar
        projects={projects}
        environments={list}
        onSelectProject={() => undefined}
        onSelectEnvironment={() => undefined}
      />
    </main>
  );
}
