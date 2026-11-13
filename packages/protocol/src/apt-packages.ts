/**
 * Debian packages a project declares in `orkestrator-ai.json`'s `aptPackages`
 * field (to-do 7770).
 *
 * A container installs them through the image's root-owned
 * `orkestrator-apt-install` (`docker/orkestrator-apt-install.sh`), which is
 * the authority: it applies the same grammar, count and denylist as root,
 * and also refuses anything an install would bring in from the denylist and
 * any removal. This module is what the backend and the launchers use to say
 * so before a container exists. `tests/unit/apt-packages-installer.test.ts`
 * keeps the two in step.
 */

/** A Debian package name, as the installer accepts it. */
export const APT_PACKAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9+.-]+$/;
export const APT_PACKAGE_NAME_MAX_LENGTH = 100;
/** The most packages one install takes. */
export const MAX_APT_PACKAGES = 32;

/**
 * Packages that change the container boundary: privilege grants, the
 * firewall, and remote login. A denylist is never complete; it names the
 * obvious ways to widen access, and the installer applies it to every package
 * an install would bring in, not only the ones named.
 */
export const APT_PACKAGE_DENYLIST: readonly string[] = Object.freeze([
  "sudo",
  "sudo-ldap",
  "sudo-rs",
  "doas",
  "opendoas",
  "pkexec",
  "polkitd",
  "policykit-1",
  "iptables",
  "iptables-persistent",
  "netfilter-persistent",
  "nftables",
  "ufw",
  "firewalld",
  "arptables",
  "ebtables",
  "ipset",
  "conntrack",
  "openssh-server",
  "dropbear",
  "dropbear-bin",
  "tinysshd",
  "telnetd",
  "inetutils-telnetd",
  "openbsd-inetd",
  "xinetd",
]);

/**
 * The hosts a restricted container reaches Debian's archive on: the image's
 * apt sources (`debian` and `debian-security`), both on `deb.debian.org` over
 * HTTPS. Added to a runtime's allowlist only when its project declared
 * packages when the runtime was created.
 */
export const DEBIAN_ARCHIVE_DOMAINS: readonly string[] = Object.freeze(["deb.debian.org"]);

export type AptPackageRefusal = "malformed" | "denied";

/** Why the installer would refuse this name before looking it up, or null. */
export function aptPackageRefusal(name: string): AptPackageRefusal | null {
  if (name.length > APT_PACKAGE_NAME_MAX_LENGTH || !APT_PACKAGE_NAME_PATTERN.test(name)) {
    return "malformed";
  }
  return APT_PACKAGE_DENYLIST.includes(name) ? "denied" : null;
}

export interface DeclaredAptPackages {
  /** Names the installer would look up, in order, without duplicates. */
  packages: string[];
  /** Entries it would refuse outright, each shortened to a displayable length. */
  refused: { name: string; reason: AptPackageRefusal }[];
  /**
   * The field is present but cannot be installed as written: not an array,
   * an entry that is not a string, or more than {@link MAX_APT_PACKAGES}
   * names (duplicates count). Setup stops on it.
   */
  invalid: boolean;
}

const NONE: DeclaredAptPackages = { packages: [], refused: [], invalid: false };

/**
 * The `aptPackages` an `orkestrator-ai.json` value declares, read as
 * `docker/workspace-setup.sh` reads it: absent or null declares none, an
 * array of strings declares each one (empty strings are skipped).
 */
export function declaredAptPackages(config: unknown): DeclaredAptPackages {
  if (!config || typeof config !== "object" || Array.isArray(config)) return NONE;
  const field = (config as { aptPackages?: unknown }).aptPackages;
  if (field === undefined || field === null) return NONE;
  if (!Array.isArray(field)) return { ...NONE, invalid: true };
  const packages: string[] = [];
  const refused: DeclaredAptPackages["refused"] = [];
  let invalid = false;
  let named = 0;
  for (const entry of field) {
    if (typeof entry !== "string") {
      invalid = true;
      continue;
    }
    if (entry === "") continue;
    named += 1;
    const reason = aptPackageRefusal(entry);
    if (reason) {
      if (refused.length < MAX_APT_PACKAGES) {
        refused.push({ name: entry.slice(0, APT_PACKAGE_NAME_MAX_LENGTH), reason });
      }
      continue;
    }
    if (!packages.includes(entry)) packages.push(entry);
  }
  // The installer counts every name it is given, duplicates included.
  if (named > MAX_APT_PACKAGES) invalid = true;
  return { packages: packages.slice(0, MAX_APT_PACKAGES), refused, invalid };
}

/** {@link declaredAptPackages} of `orkestrator-ai.json` text; unparseable text declares none. */
export function declaredAptPackagesFromText(text: string): DeclaredAptPackages {
  try {
    return declaredAptPackages(JSON.parse(text));
  } catch {
    return NONE;
  }
}

/** Whether a declaration asks the container to install anything. */
export function declaresAptPackages(declared: DeclaredAptPackages): boolean {
  return declared.packages.length > 0 || declared.refused.length > 0 || declared.invalid;
}

/**
 * Whether setup would reach Debian's archive for this declaration: it names
 * packages and setup will not stop on it first. A refused name stops the
 * installer before `apt-get update`, and an invalid field stops setup (or the
 * installer's count check) before the installer looks anything up, so neither
 * needs the archive, and a runtime created for one is not given it.
 */
export function aptPackagesNeedArchive(declared: DeclaredAptPackages): boolean {
  return declared.packages.length > 0 && declared.refused.length === 0 && !declared.invalid;
}
