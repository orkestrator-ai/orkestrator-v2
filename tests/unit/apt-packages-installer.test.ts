import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APT_PACKAGE_DENYLIST,
  APT_PACKAGE_NAME_MAX_LENGTH,
  MAX_APT_PACKAGES,
} from "../../packages/protocol/src/apt-packages";
import { IMAGE_CAPABILITIES } from "../../packages/protocol/src/image-manifest";
import { CONTRACT_FILES } from "../../docker/image-manifest";

/**
 * The root-owned installer for orkestrator-ai.json's "aptPackages"
 * (`docker/orkestrator-apt-install.sh`, to-do 7770) and how the image ships
 * it. The cases that run it stop at its argument checks, which come before
 * anything reads the system; the live suite
 * (`apps/backend/tests/container-live-apt-packages.test.ts`) installs for real.
 */

setDefaultTimeout(30_000);

const repoRoot = join(import.meta.dir, "..", "..");
const installerPath = join(repoRoot, "docker", "orkestrator-apt-install.sh");
const installer = readFileSync(installerPath, "utf8");
const dockerfile = readFileSync(join(repoRoot, "docker", "Dockerfile"), "utf8");

function run(...names: string[]): { code: number | null; stderr: string } {
  const result = spawnSync("bash", [installerPath, ...names], { encoding: "utf8" });
  return { code: result.status, stderr: result.stderr ?? "" };
}

function shellValue(name: string): string {
  const match = new RegExp(`^${name}=(?:"([^"]*)"|(\\S+))$`, "m").exec(installer);
  if (!match) throw new Error(`${name} is not set in the installer`);
  return match[1] ?? match[2] ?? "";
}

describe("orkestrator-apt-install rules", () => {
  test("the installer and the protocol module agree on every rule", () => {
    expect(shellValue("APT_PACKAGE_DENYLIST").split(" ")).toEqual([...APT_PACKAGE_DENYLIST]);
    expect(Number(shellValue("APT_PACKAGES_MAX"))).toBe(MAX_APT_PACKAGES);
    expect(Number(shellValue("APT_NAME_MAX"))).toBe(APT_PACKAGE_NAME_MAX_LENGTH);
    expect(installer).toContain("^[a-z0-9][a-z0-9+.-]+$");
  });

  test("refuses before reading the system", () => {
    expect(run().code).toBe(2);
    for (const name of ["foo;rm", "Sudo", "-o", "x", "pkg:amd64", "pkg=1.0", "pkg/trixie", "a b"]) {
      const result = run(name);
      expect(result.code).toBe(3);
      expect(result.stderr).toContain("is not a Debian package name");
    }
    expect(run("a".repeat(APT_PACKAGE_NAME_MAX_LENGTH + 1)).code).toBe(3);
    for (const name of APT_PACKAGE_DENYLIST) {
      const result = run("hello", name);
      expect(result.code).toBe(3);
      expect(result.stderr).toContain(`${name} is not allowed`);
    }
    const tooMany = Array.from({ length: MAX_APT_PACKAGES + 1 }, (_, index) => `pkg${index}`);
    expect(run(...tooMany).stderr).toContain(`at most ${MAX_APT_PACKAGES} are allowed`);
  });

  test.skipIf(existsSync("/etc/orkestrator"))(
    "a host with no recorded network policy installs nothing",
    () => {
      const result = run("orkestrator-test-not-a-package");
      expect(result.code).toBe(4);
      expect(result.stderr).toContain("no recorded network policy");
    },
  );

  test("is safe to run as root from node's sudo grant", () => {
    const lines = installer.split("\n");
    const firstCommand = lines.findIndex(
      (line) => /^[A-Za-z]/.test(line) && !line.startsWith("set "),
    );
    expect(lines[firstCommand]).toBe("PATH=/usr/sbin:/usr/bin:/sbin:/bin");
    expect(installer).not.toMatch(/^\s*(source|\.)\s/m);
    expect(installer).not.toContain("eval ");
    // apt runs with nothing from the caller's environment, and the names
    // always follow `--`.
    expect(installer).toContain("env -i PATH=");
    expect(installer).toContain('install -s -y --no-install-recommends -- "${packages[@]}"');
    expect(installer).toContain('-o Dpkg::Options::=--force-confold -- "${packages[@]}"');
    // Exact real names only: apt-get would read `sud.` as a pattern.
    expect(installer).toContain("apt-cache pkgnames --");
    // Only root-owned records decide where it may install.
    expect(installer).toContain("/etc/orkestrator/network-mode");
    expect(installer).toContain("/etc/orkestrator/egress");
    expect(installer).toContain("/run/orkestrator-network/firewall-boot");
  });
});

describe("the image ships the installer", () => {
  test("root-owned, granted to node through sudo, and declared as a capability", () => {
    expect(dockerfile).toContain(
      "COPY docker/orkestrator-apt-install.sh /usr/local/bin/orkestrator-apt-install",
    );
    expect(dockerfile).toContain(
      "chown root:root /usr/local/bin/orkestrator-apt-install && chmod 0755 /usr/local/bin/orkestrator-apt-install",
    );
    expect(dockerfile).toContain(
      "'node ALL=(root) NOPASSWD: /usr/local/bin/orkestrator-apt-install *'",
    );
    expect(installer).toContain(
      `# ORKESTRATOR_CAPABILITY apt-packages=${IMAGE_CAPABILITIES["apt-packages"]}`,
    );
    expect(CONTRACT_FILES).toContainEqual({
      installed: "/usr/local/bin/orkestrator-apt-install",
      source: "docker/orkestrator-apt-install.sh",
    });
  });

  test("apt reaches Debian's archive over HTTPS after the image's own installs", () => {
    const switchAt = dockerfile.indexOf(
      "sed -i 's#http://deb.debian.org/#https://deb.debian.org/#g' /etc/apt/sources.list.d/debian.sources",
    );
    expect(switchAt).toBeGreaterThan(dockerfile.indexOf("apt-get update"));
    expect(switchAt).toBeGreaterThan(dockerfile.indexOf("playwright install --with-deps"));
    expect(dockerfile).toContain(
      "! grep -q '^URIs:.*http://' /etc/apt/sources.list.d/debian.sources",
    );
    expect(dockerfile).toContain("test -x /usr/sbin/policy-rc.d");
  });
});
