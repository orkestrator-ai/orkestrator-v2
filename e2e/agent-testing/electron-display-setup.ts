import type { FullConfig } from "@playwright/test";
import {
  HEADLESS_CAPABLE_ELECTRON_SPECS,
  electronSpecDisplayProblem,
} from "./electron-launch-switches";

/** Fails the run before its first launch when the Electron specs have no display to use. */
export default function globalSetup(config?: FullConfig): void {
  const headlessOnly =
    !!config?.projects.length &&
    config.projects.every(
      (project) =>
        Array.isArray(project.testMatch) &&
        project.testMatch.length > 0 &&
        project.testMatch.every(
          (spec) => typeof spec === "string" && HEADLESS_CAPABLE_ELECTRON_SPECS.includes(spec),
        ),
    );
  const problem = electronSpecDisplayProblem(process.platform, process.env, headlessOnly);
  if (problem) throw new Error(problem);
}
