import type { CommandContext } from "./commands-context.js";
import { syncContainerGitHubCredential } from "./commands-files.js";
import { currentRuntimeIdentity } from "./container-lifecycle-service.js";
import { readImageManifest } from "./docker-image.js";
import { withdrawAuthenticatedGitMirrors } from "./project-git-mirror.js";
import type { Environment } from "./models.js";

/**
 * Delivers the container's GitHub token the way its image supports. An image
 * the backend cannot read gets the older form, which every image accepts; the
 * next sync on a capable image removes the rewrite again.
 */
export async function syncRuntimeGitHubCredential(
  environment: Environment | null,
  containerId: string,
  token: string | undefined,
  context: Pick<CommandContext, "storage">,
  readManifest = readImageManifest,
): Promise<void> {
  if (environment) {
    await withdrawAuthenticatedGitMirrors(context.storage.getDataDir(), environment.projectId);
  }
  const imageId = environment ? currentRuntimeIdentity(environment, context)?.imageId : undefined;
  const read = imageId ? await readManifest(imageId, context).catch(() => null) : null;
  await syncContainerGitHubCredential(containerId, token, {
    gitCredentialHelper:
      read?.kind === "manifest" && (read.manifest.capabilities["github-git-credential"] ?? 0) >= 1,
  });
}
