import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Everything `docker/orkestrator-apt-install.sh` (to-do 7770) decides after
 * its argument checks: the runtime gate, the exact-name check, the simulated
 * plan's denylist and removal checks, the lock that keeps the plan checked the
 * plan installed, and the real install's own `--no-remove`.
 *
 * The real script runs with its fixed root paths rewritten into a temporary
 * root and its fixed `PATH` led by stub `apt-get`, `apt-cache` and
 * `dpkg-query`, which act on a package state file. The script itself has no
 * override: a root-owned script must not take its paths from the caller. The
 * live suite (`apps/backend/tests/container-live-apt-packages.test.ts`)
 * installs from the real archive.
 */

setDefaultTimeout(30_000);

const repoRoot = join(import.meta.dir, "..", "..");
const installerSource = readFileSync(
  join(repoRoot, "docker", "orkestrator-apt-install.sh"),
  "utf8",
);
const flockAvailable = spawnSync("flock", ["--version"], { encoding: "utf8" }).status === 0;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const APT_GET_STUB = `#!/bin/bash
dir=__DIR__
printf '%s\\n' "$*" >> "$dir/apt-get.log"
cmd=""; sim=0; noremove=0; after=0; names=()
while [ $# -gt 0 ]; do
    if [ "$after" = 1 ]; then names+=("$1"); shift; continue; fi
    case "$1" in
        --) after=1 ;;
        -o) shift ;;
        -s) sim=1 ;;
        --no-remove) noremove=1 ;;
        -*) ;;
        *) [ -z "$cmd" ] && cmd=$1 ;;
    esac
    shift
done
case "$cmd" in
    update) [ -e "$dir/update-fails" ] && exit 100; exit 0 ;;
    clean) exit 0 ;;
    install) ;;
    *) exit 2 ;;
esac
removals() {
    local name a b
    for name in "\${names[@]}"; do
        while read -r a b; do
            if [ "$a" = "$name" ] && grep -qxF -- "$b" "$dir/installed"; then echo "$b"; fi
        done < "$dir/conflicts"
    done
}
if [ "$sim" = 1 ]; then
    [ -e "$dir/plan-fails" ] && { echo "E: Unable to correct problems"; exit 100; }
    [ -e "$dir/sim-blind" ] || removals | while read -r gone; do echo "Remv $gone [1.0]"; done
    [ -e "$dir/extra-plan" ] && cat "$dir/extra-plan"
    for name in "\${names[@]}"; do echo "Inst $name (1.0 Debian:13/stable [amd64])"; done
    exit 0
fi
[ -e "$dir/install-delay" ] && sleep "$(cat "$dir/install-delay")"
gone=$(removals)
if [ -n "$gone" ] && [ "$noremove" = 1 ]; then
    echo "E: Packages need to be removed but remove is disabled." >&2
    exit 100
fi
for name in $gone; do
    grep -vxF -- "$name" "$dir/installed" > "$dir/installed.next" || true
    mv "$dir/installed.next" "$dir/installed"
    echo "$name" >> "$dir/removed"
done
for name in "\${names[@]}"; do echo "$name" >> "$dir/installed"; done
`;

const APT_CACHE_STUB = `#!/bin/bash
# apt-cache pkgnames -- <name>
grep -xF -- "\${@: -1}" __DIR__/archive || true
`;

const DPKG_QUERY_STUB = `#!/bin/bash
# dpkg-query -W -f=... -- <name>
grep -qxF -- "\${@: -1}" __DIR__/installed || exit 1
printf 'ii '
`;

interface Sandbox {
  dir: string;
  installer: string;
  setRecords(records: { networkMode?: string; egress?: string; firewallBoot?: string }): void;
  write(name: string, content: string): void;
  installed(): string[];
  removed(): string[];
  aptGetCalls(): string[];
}

function sandbox(input: {
  archive: string[];
  installed?: string[];
  conflicts?: string[];
}): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "ork-apt-install-"));
  dirs.push(dir);
  const root = join(dir, "fs");
  const stubs = join(dir, "stubs");
  for (const path of [join(root, "root"), join(root, "etc", "orkestrator"), stubs]) {
    mkdirSync(path, { recursive: true });
  }
  mkdirSync(join(root, "run", "orkestrator-network"), { recursive: true });
  for (const [name, body] of [
    ["apt-get", APT_GET_STUB],
    ["apt-cache", APT_CACHE_STUB],
    ["dpkg-query", DPKG_QUERY_STUB],
  ] as const) {
    writeFileSync(join(stubs, name), body.replaceAll("__DIR__", dir));
    chmodSync(join(stubs, name), 0o755);
  }
  const lines = (values: string[] = []) => values.map((value) => `${value}\n`).join("");
  writeFileSync(join(dir, "archive"), lines(input.archive));
  writeFileSync(join(dir, "installed"), lines(input.installed));
  writeFileSync(join(dir, "conflicts"), lines(input.conflicts));
  writeFileSync(join(dir, "apt-get.log"), "");

  let source = installerSource;
  for (const [from, to] of [
    ["/root/", `${root}/root/`],
    ["/etc/orkestrator/", `${root}/etc/orkestrator/`],
    ["/run/orkestrator-network/", `${root}/run/orkestrator-network/`],
    ["PATH=/usr/sbin:/usr/bin:/sbin:/bin", `PATH=${stubs}:/usr/sbin:/usr/bin:/sbin:/bin`],
  ] as const) {
    // A rewrite that no longer matches would test the host instead.
    expect(source).toContain(from);
    source = source.replaceAll(from, to);
  }
  const installer = join(dir, "orkestrator-apt-install");
  writeFileSync(installer, source);

  const read = (name: string) =>
    existsSync(join(dir, name))
      ? readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean)
      : [];
  return {
    dir,
    installer,
    setRecords(records) {
      const put = (path: string, value: string | undefined) => {
        if (value === undefined) rmSync(path, { force: true });
        else writeFileSync(path, `${value}\n`);
      };
      put(join(root, "etc", "orkestrator", "network-mode"), records.networkMode);
      put(join(root, "etc", "orkestrator", "egress"), records.egress);
      put(join(root, "run", "orkestrator-network", "firewall-boot"), records.firewallBoot);
    },
    write(name, content) {
      writeFileSync(join(dir, name), content);
    },
    installed: () => read("installed"),
    removed: () => read("removed"),
    aptGetCalls: () => read("apt-get.log"),
  };
}

const GATEWAY = { networkMode: "restricted", egress: "gateway", firewallBoot: "gateway" };

function install(box: Sandbox, ...names: string[]): { code: number | null; stderr: string } {
  const result = spawnSync("bash", [box.installer, ...names], { encoding: "utf8" });
  return { code: result.status, stderr: result.stderr ?? "" };
}

async function installAsync(
  box: Sandbox,
  ...names: string[]
): Promise<{ code: number; stderr: string }> {
  const child = Bun.spawn(["bash", box.installer, ...names], { stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, stderr };
}

describe.skipIf(!flockAvailable)("orkestrator-apt-install after its argument checks", () => {
  test("installs a real package behind a verified gateway, with --no-remove", () => {
    const box = sandbox({ archive: ["hello"] });
    box.setRecords(GATEWAY);
    expect(install(box, "hello").code).toBe(0);
    expect(box.installed()).toEqual(["hello"]);
    const real = box
      .aptGetCalls()
      .find((call) => call.includes("install") && !call.includes(" -s "));
    expect(real).toContain("--no-install-recommends");
    expect(real).toContain("--no-remove");
    expect(real?.endsWith("-- hello")).toBe(true);
  });

  test("Full network access installs without a gateway", () => {
    const box = sandbox({ archive: ["hello"] });
    box.setRecords({ networkMode: "full" });
    expect(install(box, "hello").code).toBe(0);
    expect(box.installed()).toEqual(["hello"]);
  });

  test("an install with nothing missing reads no record and touches no archive", () => {
    const box = sandbox({ archive: ["hello"], installed: ["hello"] });
    expect(install(box, "hello").code).toBe(0);
    expect(box.aptGetCalls()).toEqual([]);
  });

  for (const [label, records] of [
    ["no recorded network policy", {}],
    ["Restricted with its firewall inside the container", { networkMode: "restricted" }],
    [
      "Restricted with in-container egress",
      { networkMode: "restricted", egress: "container", firewallBoot: "gateway" },
    ],
    [
      "a recorded gateway the boot did not verify",
      { networkMode: "restricted", egress: "gateway", firewallBoot: "container" },
    ],
    ["a recorded gateway with no boot result", { networkMode: "restricted", egress: "gateway" }],
  ] as const) {
    test(`${label} installs nothing (status 4)`, () => {
      const box = sandbox({ archive: ["hello"] });
      box.setRecords(records);
      expect(install(box, "hello").code).toBe(4);
      expect(box.aptGetCalls()).toEqual([]);
      expect(box.installed()).toEqual([]);
    });
  }

  test("an unreachable archive is status 5", () => {
    const box = sandbox({ archive: ["hello"] });
    box.setRecords(GATEWAY);
    box.write("update-fails", "");
    expect(install(box, "hello").code).toBe(5);
    expect(box.installed()).toEqual([]);
  });

  test("a name the archive does not hold exactly is refused", () => {
    // apt-get would read `hell.` as a pattern; only an exact name passes.
    const box = sandbox({ archive: ["hello"] });
    box.setRecords(GATEWAY);
    const result = install(box, "hell.");
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("hell. is not a package in Debian's archive");
    expect(box.aptGetCalls().some((call) => call.includes("install"))).toBe(false);
  });

  test("a denylisted package the install would bring in is refused", () => {
    const box = sandbox({ archive: ["ssh"] });
    box.setRecords(GATEWAY);
    box.write("extra-plan", "Inst openssh-server (1:10.0 Debian:13/stable [amd64])\n");
    const result = install(box, "ssh");
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("would bring in openssh-server");
    expect(box.installed()).toEqual([]);
  });

  test("a plan that removes a package is refused", () => {
    const box = sandbox({
      archive: ["postfix"],
      installed: ["exim4-daemon-light"],
      conflicts: ["postfix exim4-daemon-light"],
    });
    box.setRecords(GATEWAY);
    const result = install(box, "postfix");
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("would remove exim4-daemon-light");
    expect(box.installed()).toEqual(["exim4-daemon-light"]);
    expect(box.removed()).toEqual([]);
  });

  test("a plan apt-get cannot make is status 6", () => {
    const box = sandbox({ archive: ["hello"] });
    box.setRecords(GATEWAY);
    box.write("plan-fails", "");
    expect(install(box, "hello").code).toBe(6);
    expect(box.installed()).toEqual([]);
  });

  test("the real install refuses a removal its plan did not show", () => {
    const box = sandbox({
      archive: ["postfix"],
      installed: ["exim4-daemon-light"],
      conflicts: ["postfix exim4-daemon-light"],
    });
    box.setRecords(GATEWAY);
    box.write("sim-blind", "");
    expect(install(box, "postfix").code).toBe(6);
    expect(box.installed()).toEqual(["exim4-daemon-light"]);
    expect(box.removed()).toEqual([]);
  });

  test("concurrent installs are serialized, so the plan checked is the plan installed", async () => {
    // Each would remove the other. Without the lock both plans would be
    // checked before either install ran, and the second install would then
    // have to remove the first package.
    const box = sandbox({
      archive: ["postfix", "exim4-daemon-light"],
      conflicts: ["postfix exim4-daemon-light", "exim4-daemon-light postfix"],
    });
    box.setRecords(GATEWAY);
    box.write("install-delay", "1");
    const results = await Promise.all([
      installAsync(box, "postfix"),
      installAsync(box, "exim4-daemon-light"),
    ]);
    expect(results.map((result) => result.code).sort()).toEqual([0, 3]);
    const refused = results.find((result) => result.code === 3);
    expect(refused?.stderr).toMatch(/would remove (postfix|exim4-daemon-light)/);
    expect(box.installed()).toHaveLength(1);
    expect(box.removed()).toEqual([]);
  });
});
