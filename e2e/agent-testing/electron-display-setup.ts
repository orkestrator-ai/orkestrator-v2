import { electronSpecDisplayProblem } from "./electron-launch-switches";

/** Fails the run before its first launch when the Electron specs have no display to use. */
export default function globalSetup(): void {
  const problem = electronSpecDisplayProblem();
  if (problem) throw new Error(problem);
}
