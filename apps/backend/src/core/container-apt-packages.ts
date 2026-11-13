import {
  aptPackagesNeedArchive,
  declaredAptPackagesFromText,
} from "@orkestrator/protocol/apt-packages";
import { readDefaultBranchConfigText, type GitBlobReader } from "./setup-approval.js";

/**
 * Whether a new restricted runtime should reach Debian's archive: its project
 * declares `aptPackages` (to-do 7770) that setup would install
 * (`aptPackagesNeedArchive`; a list setup refuses outright never reaches the
 * archive, so it opens nothing), read from this machine's checkout
 * without fetching, on the first of `branches` that exists there (the
 * environment's own branch, then the one it starts from). Without a checkout
 * or any of the branches, nothing is opened; setup then says the archive is
 * unreachable and how to add it.
 *
 * Advisory, like `get_project_setup_requirements`: the container's installer
 * decides what is installed. This decides only whether the allowlist names
 * `deb.debian.org`.
 */
export async function projectDeclaresAptPackages(
  projectPath: string | null | undefined,
  branches: readonly string[],
  readBlob?: GitBlobReader,
): Promise<boolean> {
  if (!projectPath) return false;
  for (const branch of new Set(branches.filter(Boolean))) {
    const text = await readDefaultBranchConfigText(projectPath, branch, readBlob);
    if (text === null) continue;
    return text.trim() ? aptPackagesNeedArchive(declaredAptPackagesFromText(text)) : false;
  }
  return false;
}

/**
 * Whether a runtime may be given Debian's archive at all: restricted, behind
 * an egress gateway (the only runtimes whose installer installs under
 * Restricted), from an image that ships the installer.
 */
export function runtimeInstallsAptPackages(input: {
  networkMode: "full" | "restricted";
  enforcement: "gateway" | "container" | "none";
  imageAptPackagesVersion: number;
}): boolean {
  return (
    input.networkMode === "restricted" &&
    input.enforcement === "gateway" &&
    input.imageAptPackagesVersion >= 1
  );
}
