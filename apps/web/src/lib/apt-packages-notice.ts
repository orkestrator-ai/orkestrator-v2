import {
  DEBIAN_ARCHIVE_DOMAINS,
  MAX_APT_PACKAGES,
  type DeclaredAptPackages,
} from "@orkestrator/protocol/apt-packages";

/** How many names a launcher lists before "and N more". */
const LISTED_NAMES = 6;

export interface AptPackagesNotice {
  /** `warning` when setup will stop on the list; `info` when it will install it. */
  tone: "warning" | "info";
  text: string;
}

function listNames(names: readonly string[]): string {
  const shown = names.slice(0, LISTED_NAMES).join(", ");
  return names.length > LISTED_NAMES ? `${shown} and ${names.length - LISTED_NAMES} more` : shown;
}

/**
 * What a container launcher says about the Debian packages a project's
 * default branch declares in `aptPackages` (to-do 7770): that setup will stop
 * on a list the installer refuses, or which packages it installs and, under
 * Restricted, that the environment can then reach Debian's archive. `null`
 * when the project declares none or the machine cannot tell.
 */
export function aptPackagesNotice(
  declared: DeclaredAptPackages | null | undefined,
  networkAccessMode: "restricted" | "full",
): AptPackagesNotice | null {
  if (!declared) return null;
  if (declared.refused.length > 0) {
    const denied = declared.refused.filter((entry) => entry.reason === "denied");
    const malformed = declared.refused.filter((entry) => entry.reason === "malformed");
    const parts = [
      denied.length > 0
        ? `${listNames(denied.map((entry) => entry.name))} could change the container's protections`
        : null,
      malformed.length > 0
        ? `${listNames(malformed.map((entry) => entry.name))} ${malformed.length === 1 ? "is not a Debian package name" : "are not Debian package names"}`
        : null,
    ].filter(Boolean);
    return {
      tone: "warning",
      text: `orkestrator-ai.json's aptPackages will be refused: ${parts.join("; ")}. Setup will stop there.`,
    };
  }
  if (declared.invalid) {
    return {
      tone: "warning",
      text: `orkestrator-ai.json's aptPackages must be a list of at most ${MAX_APT_PACKAGES} Debian package names. Setup will stop there.`,
    };
  }
  if (declared.packages.length === 0) return null;
  const count = declared.packages.length;
  const installs = `Setup installs ${count === 1 ? "a Debian package" : `${count} Debian packages`} from Debian's archive (${listNames(declared.packages)})`;
  return {
    tone: "info",
    text:
      networkAccessMode === "restricted"
        ? `${installs}, so this environment can also reach ${DEBIAN_ARCHIVE_DOMAINS.join(", ")}.`
        : `${installs}.`,
  };
}
