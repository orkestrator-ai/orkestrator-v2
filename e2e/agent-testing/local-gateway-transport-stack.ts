import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { prepareFixtureRepository } from "../../apps/desktop/scripts/dev/fixture";
import { initializeProfile, reserveLoopbackPorts } from "../../apps/desktop/scripts/dev/profile-io";
import { ownProcessGroup } from "../process-cleanup";
import { withStartingProcess } from "./local-gateway-transport-lifecycle";
import { recordProcessOutput } from "./electron-diagnostics";
import { expect } from "./electron-fixtures";
import { electronSpecEnvironment } from "./electron-spec-environment";

/**
 * The disposable profile, fixture repository and Vite renderer both local
 * transport specs run a window against, with the transport chosen by `mode`.
 */

export type TransportMode = "relay" | "gateway";

export const repositoryRoot = path.resolve(import.meta.dirname, "../..");
export const packageRoot = path.join(repositoryRoot, "apps", "desktop");
export const webRoot = path.join(repositoryRoot, "apps", "web");
export const electronExecutable = path.join(packageRoot, "node_modules", ".bin", "electron");
export const electronMain = path.join(packageRoot, "dist", "electron", "main.js");
export const countsDir = path.join(
  repositoryRoot,
  "output",
  "agent-testing",
  "local-transport-counts",
);

export async function waitForUrl(url: string): Promise<void> {
  await expect
    .poll(
      async () =>
        fetch(url)
          .then((response) => response.ok)
          .catch(() => false),
      { timeout: 30_000 },
    )
    .toBe(true);
}

export type TransportStack = {
  profile: ReturnType<typeof resolveRuntimeProfile>;
  profilePath: string;
  projectPath: string;
  rendererUrl: string;
  /** Owned process group; stop it with `stopProcessGroup`. */
  vite: ChildProcess;
  /** The environment for an Electron main on this profile's Vite renderer. */
  electronEnv: Record<string, string>;
};

/** A fresh profile under `root` with the transport setting for `mode`, and its Vite. */
export async function startTransportStack(
  mode: TransportMode,
  root: string,
  profileId: string,
): Promise<TransportStack> {
  const [rendererPort, gatewayPort] = (await reserveLoopbackPorts(2)) as [number, number];
  const profile = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: profileId,
    flavor: "agent-test",
    rendererPort,
    gatewayPort,
    roots: {
      developmentRoot: path.join(root, "dev"),
      productionDataDir: path.join(root, "production"),
      homeDir: root,
    },
  });
  const profilePath = await initializeProfile(profile);
  const projectPath = await prepareFixtureRepository(
    profile,
    path.join(repositoryRoot, "test-fixtures", "agent-project"),
  );
  // Each run states its transport: since to-do 4501 task 2 the direct one is
  // the default, so only an explicit `false` gives the relay.
  await mkdir(profile.dataDir, { recursive: true });
  await writeFile(
    path.join(profile.dataDir, "config.json"),
    JSON.stringify({
      repositories: {},
      global: { localWindowGatewayTransport: mode === "gateway" },
    }),
  );
  const rendererUrl = `http://127.0.0.1:${rendererPort}`;
  const vite = spawn("bun", ["run", "dev"], {
    cwd: webRoot,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      VITE_DEV_HOST: "127.0.0.1",
      VITE_DEV_PORT: String(rendererPort),
      VITE_ORKESTRATOR_PROFILE: profile.id,
    },
  });
  ownProcessGroup(vite);
  return withStartingProcess(vite, async () => {
    recordProcessOutput("vite", vite);
    await waitForUrl(rendererUrl);
    return {
      profile,
      profilePath,
      projectPath,
      rendererUrl,
      vite,
      electronEnv: electronSpecEnvironment(process.env, {
        ELECTRON_DEV: "1",
        VITE_DEV_SERVER_URL: rendererUrl,
        ORKESTRATOR_RUNTIME_PROFILE_FILE: profilePath,
      }),
    };
  });
}
