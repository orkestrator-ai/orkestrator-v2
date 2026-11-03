import type { FullConfig } from "@playwright/test";
import { electronSpecDisplayProblem } from "./electron-launch-switches";

/** Fails the run before its first launch when the Electron specs have no display to use. */
export default function globalSetup(config?: FullConfig): void {
  const headlessOnly =
    !!config?.projects.length &&
    config.projects.every(
      (project) =>
        project.testMatch.length === 1 && project.testMatch[0] === "design-canvas-electron.spec.ts",
    );
  const problem = electronSpecDisplayProblem(process.platform, process.env, headlessOnly);
  if (problem) throw new Error(problem);
}
