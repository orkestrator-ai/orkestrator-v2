import type { FullConfig } from "@playwright/test";
import { realpathSync } from "node:fs";
import path from "node:path";

// Outside CI the config reuses whatever already listens on the fixture port, and
// every worktree uses the same port. A fixture server started by another
// checkout would then serve that checkout's sources, and the run would test
// code other than this one. Vite only serves `/@fs/` paths inside its own
// workspace, so asking for one of this checkout's files tells the two apart.
export default async function assertFixtureServerOwner(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) return;
  const fixtureEntry = realpathSync(path.join(import.meta.dirname, "fixture/main.tsx"));
  const response = await fetch(new URL(`/@fs${fixtureEntry}`, baseURL));
  if (response.ok) return;
  throw new Error(
    `The fixture server at ${baseURL} does not serve ${fixtureEntry} (HTTP ${response.status}). ` +
      "It belongs to another checkout. Stop it, or set ORKESTRATOR_E2E_PORT to a free port.",
  );
}
