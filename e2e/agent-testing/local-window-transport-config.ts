import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDefaultAppConfig } from "@orkestrator/protocol/app-config-defaults";

/**
 * Seeds a profile's config.json with the local window transport stated
 * explicitly, before the app starts. Since to-do 4501 task 2 the direct
 * gateway transport is the default, so a spec about main's relay writes
 * `false`.
 *
 * The file is the backend's own default config (what it uses when no file
 * exists) with only that setting changed. A partial file is not equivalent:
 * the backend reads an existing file as stored, without filling defaults in,
 * and the renderer's `get_config` decoder then rejects it for every missing
 * required key (`version`, `global.containerResources`, …), leaving a window
 * with no settings and no terminal.
 */
export async function seedLocalWindowTransport(dataDir: string, direct: boolean): Promise<void> {
  const config = createDefaultAppConfig();
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    path.join(dataDir, "config.json"),
    JSON.stringify({
      ...config,
      global: { ...config.global, localWindowGatewayTransport: direct },
    }),
  );
}
