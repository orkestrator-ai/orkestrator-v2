# Declarative system packages for restricted containers

## Task analysis

Analysed 2026-11-11 against `main` at `14df96544`; tasks 1 to 5 built and
qualified on 2026-11-13 against `main` at `17d28238c`.

### Tasks

1. **Decide how a project asks for system packages without running its own code as root.** Status: done.
2. **Build the trusted package installer and its `orkestrator-ai.json` field.** Status: done.
3. **Let a restricted container reach the package archive for the install.** Status: done.
4. **Tell launchers and setup output about packages, separately from root steps.** Status: done.
5. **Qualify it live and document it.** Status: done (beelink, Linux Engine x64).
6. **Record the Container live qualification CI run of the new suite on both architectures.** Status: open (blocked: waits on the workflow's first run of `container-live-apt-packages.test.ts` on linux-x64 and linux-arm64).

### 1. Decide how a project asks for system packages without running its own code as root

**Problem.** `orkestrator-ai.json`'s `root` steps run only in containers with full network access (`docker/run-root-setup.sh` refuses them otherwise, since #757). Most root steps exist to install a system package or a tool, so a project that needs one had to give up network isolation, though what it needs is narrower than root.

**Context.** A root step is repository-controlled: any branch, including an agent's own commits, can change it, and as uid 0 it reaches what the container boundary protects from `node`. Found while investigating dd-tools-web's failed pipeline (2026-11-11).

**Investigation.** Read from the code and the 2.37.6-beta image on 2026-11-11; the image's apt sources and apt's argument handling were re-checked on 2026-11-13 (see task 2).

**Decisions.** All three were taken as recommended; the result is described in [declared-system-packages.md](../../architecture/declared-system-packages.md).

- **How should a project get system packages in a restricted container?**
  - **A declarative `"aptPackages": [...]` field installed by a root-owned wrapper that takes only validated package names (recommended, built).**
    - Pros: no repository-controlled command runs as root; packages come from Debian's signed archive; the field is data a launcher can show before anything runs.
    - Cons: Debian maintainer scripts still run as root; apt packages only.
  - **A per-project image built on the host.**
    - Pros: nothing runs as root inside a live container.
    - Cons: image builds, caching, disk use and another lifecycle to own.
  - **Trust `root` steps that match the default branch's.**
    - Pros: tiny change.
    - Cons: still arbitrary root code from the repository.
  - **Bake more tools into the image.**
    - Pros: no runtime mechanism.
    - Cons: cannot cover every project; grows the image for everyone.
- **Which packages may the field name?**
  - **Any real package from the image's Debian sources, with a denylist of packages that change the boundary (recommended, built).**
    - Pros: useful for most projects at once.
    - Cons: a denylist is never complete.
  - **A fixed allowlist in the repository.**
    - Pros: every package reviewed.
    - Cons: every new need is a release.
- **Which runtimes may install packages under Restricted?**
  - **Only runtimes whose firewall is in an egress gateway (recommended, built).**
    - Pros: a maintainer script cannot touch the firewall.
    - Cons: older runtimes refuse until rebuilt.
  - **Every runtime.**
    - Pros: no check.
    - Cons: root holds `NET_ADMIN` during the install on an in-container firewall.

### 2. Build the trusted package installer and its `orkestrator-ai.json` field

**Problem.** Nothing in the image installed packages on a project's behalf without running the project's own command as root.

**Context.** The installer sits beside `run-root-setup.sh` under the rules in `docker/AGENTS.md` ("Users and isolation").

**Investigation.** Built 2026-11-13: `docker/orkestrator-apt-install.sh`, installed root-owned as `/usr/local/bin/orkestrator-apt-install` with a `node` sudoers grant and the `apt-packages=1` capability marker; `workspace-setup.sh` runs it (`run_project_apt_packages`) before `root` steps and `setupContainer`. In the image (apt 3.0.3, Debian 13.7) apt-get still read `sud.` as a pattern (it planned `sudo-ldap`), stripped modifiers (`sudo+` reinstalls `sudo`; `hello-` removes `hello`) and accepted virtual names, so the grammar alone is not enough: the installer also requires each name to be an exact real package (`apt-cache pkgnames`) and checks every package a simulated install would bring in against the denylist (`ssh` brings in `openssh-server`), and refuses any removal.

**Decisions.**

- **How is the list validated?**
  - **Debian names only (`^[a-z0-9][a-z0-9+.-]+$`, at most 100 characters), at most 32, denylisted names refused, `apt-get install --no-install-recommends` with `--` before the names (recommended, built; plus the exact-name and dependency checks above).**
    - Pros: no option or shell injection; root enforces the denylist.
    - Cons: no version pins.
  - **Accept `name=version` pins as well.**
    - Pros: reproducible installs.
    - Cons: a wider grammar; Debian drops old versions.

### 3. Let a restricted container reach the package archive for the install

**Problem.** The image's apt sources used plain HTTP on port 80; under network policy 3 a bare domain is reachable on TCP 443 only, and `deb.debian.org` was not on any list.

**Context.** The archive is signed, so the transport does not have to be trusted for integrity.

**Investigation.** Built 2026-11-13: the image's `debian.sources` switch to `https://deb.debian.org` after the image's own installs (the build fails if an HTTP `URIs:` line remains). A runtime that is restricted, behind a gateway, from an `apt-packages=1` image, for a project whose host checkout declares packages (environment branch, else its base branch) gets `deb.debian.org` and the label `orkestrator-debian-archive=1`; every later allowlist revision, live edit and MCP reachability hint reads the label. On 2026-11-13 `deb.debian.org` served both archives over HTTPS from beelink (x64); arm64 is task 6.

**Decisions.**

- **How does the install reach the archive?**
  - **HTTPS sources, and the Debian host on a runtime's allowlist only when its project declares packages (recommended, built).**
    - Pros: works with policy 3's TCP 443 default and the name filter; projects without packages are unchanged.
    - Cons: those environments reach Debian's mirrors for their whole life.
  - **Open the host only for the install.**
    - Pros: narrowest reach.
    - Cons: a second firewall edit per start.
  - **`deb.debian.org:80` entries over HTTP.**
    - Pros: no image change.
    - Cons: plain HTTP; one more port.

### 4. Tell launchers and setup output about packages, separately from root steps

**Problem.** The launchers warned only about `root` steps.

**Context.** `get_project_setup_requirements` returned `{ rootSteps }`.

**Investigation.** Built 2026-11-13: the command also returns optional `aptPackages` (`packages`, `refused` with a reason, `invalid`); the Build launcher and the new-environment dialog name the packages and, under Restricted, `deb.debian.org`, or warn that setup will stop on a refused list. Setup prints the packages and, on failure, one of four reasons (`apt-packages-refused`, `-unsupported-runtime`, `-archive-unreachable`, `-install-failed`), each with its own lifecycle message.

**Decisions.** None beyond tasks 1 to 3.

### 5. Qualify it live and document it

**Problem.** The installer runs as root inside the container boundary, so it needed the same live evidence as the other root paths.

**Context.** `docker/tests/root-boundary-smoke.sh` plants files as `node` and fails if a root process runs them.

**Investigation.** Run on beelink (Linux Engine 29, rootful, x64) on 2026-11-13 with an image built from this change (`orkestrator-v2:qualification-apt7770`, manifest `apt-packages=1`), through `apps/desktop/scripts/dev/docker-qualification-bin`:

- `apps/backend/tests/container-live-apt-packages.test.ts` passed twice (1 test, 29 assertions, 48–49 s each). A restricted runtime behind its gateway with name checks, created for a checkout declaring `["hello"]`, was labelled for the archive and its gateway listed `deb.debian.org`; `node` installed `hello` through `sudo` from the real archive over HTTPS and ran it; a second run reported it already installed. The installer refused `openssh-server`, `sudo`, `ssh` (would bring in `openssh-server`), `sud.`, `sudo+`, `ssh-server` and `bad;name` with status 3, and `openssh-server` stayed uninstalled. A second runtime for a checkout declaring nothing got no label and no archive, and the same install there ended `archive could not be reached` (status 5).
- `docker/tests/root-boundary-smoke.sh` passed on the same image, with `apt-get`, `apt-cache`, `dpkg`, `dpkg-query`, `env` and `rm` planted on `node`'s PATH and the installer run through `node`'s sudo grant and with the image PATH.

After the first Multi Review round (an installer lock and `--no-remove`, control characters refused in setup, no archive for a list setup refuses), both were run again on beelink the same day with a rebuilt image (`orkestrator-v2:qualification-apt7770-r1`). The live suite passed (about 54 s) with two more checks: `openntpd` and `chrony`, which conflict through `time-daemon`, installed at the same moment, so that one installed, the other was refused because its plan would remove the first (status 3), and exactly one of them remained; and a runtime for `["hello", "sudo"]` got no label and no archive. The root-boundary smoke passed with `flock` added to the commands it plants.

Documented in [declared-system-packages.md](../../architecture/declared-system-packages.md), `docker/AGENTS.md` and the root `AGENTS.md`. The suite is a step of the Container live qualification workflow.

**Decisions.** None.

### 6. Record the Container live qualification CI run of the new suite on both architectures

**Problem.** Task 5 ran on x64 only, and whether `deb.debian.org` serves the archive over HTTPS on GitHub's arm64 runners was not observed.

**Context.** The workflow (`.github/workflows/container-live-qualification.yml`, step "Live declared Debian packages") runs the suite on linux-x64 and linux-arm64 for pull requests that touch its paths and weekly.

**Investigation.** Not run yet: it runs on this change's pull request.

**Decisions.** None: record the run's result for both architectures here, then retire this file. A failure on arm64 is a bug in this feature, fixed here.

## Constraints and rationale

- The `root-steps-need-full-network` setup failure reason stays: older images emit it, and `root` steps keep their current rule.
- The installer never reads its list from a path `node` can write; the arguments come from the setup script's own parse.
- `node`'s sudo grant lets an agent run the installer later in the session, under the same rules; it gains nothing a commit to `orkestrator-ai.json` would not.

## Related

- [declared-system-packages.md](../../architecture/declared-system-packages.md).
- `docker/orkestrator-apt-install.sh`, `docker/workspace-setup.sh` (`run_project_apt_packages`), `apps/backend/src/core/container-apt-packages.ts`.
- `docker/AGENTS.md`, "Users and isolation" and "Network isolation".

## Assumptions and decisions

### Task 2: exact names and the dependency check (2026-11-13)

Chose to require exact real package names and to check a simulated install's full package set and removals, beyond the grammar the file recommended, because apt-get was observed resolving patterns, modifiers and virtual names in the image; the grammar alone would have let `sud.` or `ssh` reach a denylisted package.

### Task 2: a denylist slightly wider than the file's examples (2026-11-13)

Added the other privilege grants (`sudo-ldap`, `sudo-rs`, `doas`, `opendoas`, `pkexec`, `polkitd`, `policykit-1`), firewall front ends and tools already in the image (`iptables-persistent`, `netfilter-persistent`, `firewalld`, `arptables`, `ebtables`, `ipset`, `conntrack`) and other remote-login servers (`dropbear`, `dropbear-bin`, `tinysshd`, `telnetd`, `inetutils-telnetd`, `openbsd-inetd`, `xinetd`), as the file's "packages that change the boundary" rule names them.

### Task 2: an already-installed list needs nothing (2026-11-13)

The installer exits 0 without a network or runtime check when every package is already installed, so a list naming tools the image has works on any runtime, including one whose firewall is in the container.

### Task 3: deciding the archive at creation, from the host checkout (2026-11-13)

The allowlist is fixed when the runtime is created, before its clone exists, so the backend reads the declaration from the host checkout (environment branch, else base branch, without fetching) and records the answer as a runtime label, which every later allowlist reader uses. A project with no checkout, or one that adds packages later, gets a setup failure naming `deb.debian.org` and the remedies (add it to the environment's allowed domains, or rebuild).

### Task 4: names in the launcher answer (2026-11-13)

The file suggested a package count; the launchers show the names (bounded to 32 entries of 100 characters) because the ticket asks them to report the declared packages, and refused names with their reason so the warning can say which.

### Task 5: a CI step rather than a second manual architecture run (2026-11-13)

beelink is x64. arm64 is covered by adding the suite to the Container live qualification workflow, whose run is task 6, instead of a person-run check.

### Task 2: one install at a time, and `--no-remove` on the real install (2026-11-13, review round 1)

Review found that two installs started together could both pass the simulated-plan checks, after which the second real install could remove what the first installed. The installer now takes an exclusive `flock` on a root-only file in `/root` from `apt-get update` to the end. It waits up to 15 minutes and then exits 6. apt does not inherit the lock. The real install also runs with `--no-remove`. The lock comes after the runtime check, so a host or runtime that may not install never opens it. The already-installed shortcut takes no lock, because no install removes anything. A lock in `/run/lock` was not used: on Debian that directory is writable by everyone, so `node` could plant or hold the file.

### Task 2: setup refuses control characters in names (2026-11-13, review round 1)

Setup hands names to the installer one per line, so `"hello\nffmpeg"` became two valid names. `project_apt_packages` now refuses the whole field, with `apt-packages-refused`, when a name holds a character below U+0020 or U+007F. NUL-delimited transport was the alternative; refusing is simpler and agrees with the launchers, for which such a name is already malformed.

### Task 3: no archive for a list setup refuses (2026-11-13, review round 1)

`projectDeclaresAptPackages` now uses `aptPackagesNeedArchive`: names to install, none refused, and a valid field. A refused name stops the installer before `apt-get update`, and a field setup refuses never reaches the installer, so neither needs `deb.debian.org`. Previously the whole life of such a runtime could reach it. The launchers still report such lists through `get_project_setup_requirements`.
