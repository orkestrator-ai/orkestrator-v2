# Declared system packages (`aptPackages`)

A container project that needs a system library or tool declares it in
`orkestrator-ai.json` instead of installing it from a `root` step:

```json
{
  "aptPackages": ["libvips-dev", "ffmpeg"],
  "setupContainer": ["bun install"]
}
```

Setup installs the packages from Debian's signed archive before the `root`
steps and `setupContainer`, in Restricted and Full containers alike. No
repository command runs as root: the list is data, checked and installed by
a root-owned installer in the image. Built from to-do
[7770](../todo/containers-and-environments/7770-declarative-system-packages-for-restricted-containers.md)
on 2026-11-13; `root` steps keep their rule (Full access only, the
`root-steps-need-full-network` failure).

Local environments ignore the field: the host's packages are the user's.

## The field

- An array of Debian package names. An absent or `null` field, an empty
  array and empty strings declare nothing.
- A name matches `^[a-z0-9][a-z0-9+.-]+$` and is at most 100 characters; at
  most 32 names (duplicates count). No version pins (`name=version`),
  architectures (`name:arch`), releases (`name/suite`) or patterns.
- A name must be a real package in the image's archive. Virtual names
  (`ssh-server`) are refused rather than resolved to a provider.
- The denylist (`APT_PACKAGE_DENYLIST`, `packages/protocol/src/apt-packages.ts`,
  repeated in the installer) refuses packages that change the container
  boundary: privilege grants (`sudo`, `doas`, `pkexec`, polkit), firewalls
  (`iptables`, `nftables`, `ufw`, `firewalld`, `ipset`, `conntrack`, …) and
  remote login (`openssh-server`, `dropbear`, telnet and inetd servers). The
  installer checks it against **everything the install would bring in**, so
  `ssh` (which depends on `openssh-server`) is refused too, and it refuses any
  install that would remove a package.
- A name holds no control character. Setup passes the names to the
  installer one per line, so it refuses a field with a newline (or any other
  control character) in a name rather than let `"hello\nffmpeg"` become two
  names.

A denylist is never complete, and Debian's maintainer scripts run as root.
They are Debian's signed code, not the repository's; the image's
`policy-rc.d` stops any of them starting a service.

## The installer

`/usr/local/bin/orkestrator-apt-install` (`docker/orkestrator-apt-install.sh`,
image capability `apt-packages=1`) is root-owned, and `node`'s sudoers grant
for it takes any arguments. Root enforces every rule, in this order:

1. Argument count, grammar and the denylist (exit 3), before reading anything.
2. Every package already installed: exit 0 with nothing run, so a list naming
   tools the image has (`git`, `curl`) works on any runtime.
3. The runtime, from root-owned records only: Full, or Restricted with
   recorded egress `gateway` *and* a boot that verified the gateway
   (`/run/orkestrator-network/firewall-boot` = `gateway`). Otherwise exit 4: on
   a runtime whose firewall is in the container, a maintainer script would run
   with `NET_ADMIN`.
4. An exclusive lock, `/root/.orkestrator-apt-install.lock` (root-only, held
   until the script ends and not inherited by anything apt starts; exit 6
   after 15 minutes waiting). Without it two installs could both pass the
   checks below against the same state, and the second could then remove what
   the first installed.
5. `apt-get update` (exit 5 when the archive is unreachable), then an exact
   name check with `apt-cache pkgnames`, then a simulated install whose `Inst`
   and `Remv` lines are checked against the denylist (exit 3), then the
   install, itself run with `--no-remove` (exit 6 on failure).

apt runs under `env -i` with root's `PATH`, `HOME=/root` and a private
`TMPDIR`, `--no-install-recommends`, and the names after `--`. The checks
matter because apt-get still reads a name as a regular expression (`sud.`
matched `sudo-ldap`), strips a `+`/`-` modifier (`sudo+`, `hello-` removes
`hello`) and picks a provider for a virtual name; all three were observed in
the image (apt 3.0.3, Debian 13.7) on 2026-11-13.

Because the grant is `node`'s, an agent can also run the installer later in
the session. The same rules apply; it gains nothing a commit to
`orkestrator-ai.json` would not.

`workspace-setup.sh` (`run_project_apt_packages`) reads the field with `jq`,
refuses a field that is not a list of strings or holds a control character,
passes each name as one argument, and turns the installer's status into a setup failure reason:

| Status | Reason | Lifecycle message |
| --- | --- | --- |
| 3, or a malformed field | `apt-packages-refused` | `aptPackagesRefused` |
| 4 | `apt-packages-unsupported-runtime` | `aptPackagesUnsupportedRuntime` |
| 5 | `apt-packages-archive-unreachable` | `aptPackagesArchiveUnreachable` |
| any other | `apt-packages-install-failed` | `aptPackagesInstallFailed` |

## Reaching the archive

The image's apt sources are switched to `https://deb.debian.org` after the
image's own installs, so a restricted container reaches the archive on TCP
443, the port policy 3 opens for a bare domain, and the egress filter checks
the TLS SNI. The archive's signatures are what make the packages trustworthy;
HTTPS only keeps the port and the name check simple.

`deb.debian.org` (`DEBIAN_ARCHIVE_DOMAINS`) is added to a runtime's allowlist
only when, at creation, the runtime is restricted, behind an egress gateway,
from an image with `apt-packages=1`, **and** its project declares packages
setup would install (`projectDeclaresAptPackages`,
`apps/backend/src/core/container-apt-packages.ts`, through
`aptPackagesNeedArchive`): a list with a refused name, or a field setup
refuses, never reaches the archive, so it opens nothing. The launchers still
warn about such a list. The declaration is read from the host checkout's
copy of the environment's branch, else the branch it starts from, without
fetching. The decision is recorded as the runtime
label `orkestrator-debian-archive=1`, and every later allowlist revision,
live edit and MCP reachability hint reads that label, so they agree with what
the runtime was created with. A project that adds packages later needs a
rebuild, or `deb.debian.org` in the environment's allowed domains; the
unreachable message says both. Such an environment can reach Debian's mirrors
for its whole life, not only during setup.

## Launchers

`get_project_setup_requirements` returns `aptPackages` (optional; absent from
an older backend) beside `rootSteps`: the names setup would install, the names
it would refuse outright and why, and whether the field cannot be installed as
written. The Build launcher and the new-environment dialog show it under the
network choice for a container (`aptPackagesNotice`,
`apps/web/src/lib/apt-packages-notice.ts`): the packages and, under
Restricted, that `deb.debian.org` becomes reachable; or a warning that setup
will stop on the list.

## Tests

- `tests/unit/apt-packages-installer.test.ts`: the installer's rules match the
  protocol module, its argument checks, and how the image ships it.
- `tests/unit/apt-packages-installer-plan.test.ts`: the real installer with
  its root paths rewritten into a temporary root and stub `apt-get`,
  `apt-cache` and `dpkg-query`: the runtime gate, the exact-name and plan
  checks, `--no-remove`, and two concurrent installs of conflicting packages.
- `tests/unit/workspace-setup-apt-packages.test.ts`: the setup phase, its
  failure markers, and names with control characters.
- `apps/backend/tests/container-debian-archive-create.test.ts`: which new
  runtimes `createDockerContainer` gives the archive and the label, against a
  fake `docker`; `apps/backend/tests/container-network.test.ts` covers the MCP
  view of a labelled runtime.
- `docker/tests/root-boundary-smoke.sh`: the installer, through `node`'s sudo
  grant and with the image `PATH`, runs nothing `node` planted.
- `apps/backend/tests/container-live-apt-packages.test.ts` (opt-in,
  `RUN_LIVE_DOCKER_TESTS=1`): a restricted runtime behind its gateway installs
  a declared package from the real archive and refuses denied ones, two
  concurrent installs of conflicting packages (`openntpd`, `chrony`) install
  one and refuse the other, and a runtime for a refused list gets no archive.
