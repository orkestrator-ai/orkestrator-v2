# Declarative system packages for restricted containers

## Task analysis

Analysed 2026-11-11 against `main` at `14df96544`.

### Tasks

1. **Decide how a project asks for system packages without running its own code as root.** Status: open.
2. **Build the trusted package installer and its `orkestrator-ai.json` field.** Status: open (depends on 1).
3. **Let a restricted container reach the package archive for the install.** Status: open (depends on 1).
4. **Tell launchers and setup output about packages, separately from root steps.** Status: open (depends on 2).
5. **Qualify it live and document it.** Status: open (depends on 2, 3 and 4).

### 1. Decide how a project asks for system packages without running its own code as root

**Problem.** `orkestrator-ai.json`'s `root` steps run only in containers with full network access (`docker/run-root-setup.sh` refuses them otherwise, since #757). Most root steps exist to install a system package or a tool. A project that needs one therefore has to give up network isolation, though what it actually needs is narrower than root.

**Context.** The gate is about root, not about the addresses a step contacts. A root step is repository-controlled: any branch, including an agent's own commits or a stranger's pull request, can change it. As uid 0 it can reach what the container boundary protects from `node`: the bridge tokens in root-only `/run/orkestrator-bridge`, the root-owned bridges in `/opt` that answer approvals, and the paths `docker/verify-root-boundary.sh` keeps `node` out of. On runtimes whose firewall is still inside the container (no egress gateway), root can also rewrite the firewall itself. Found while investigating dd-tools-web's failed pipeline (2026-11-11), whose only root step installs mise if it is missing. The image already has mise, so that project only needed the `root` field removed.

**Investigation.** Read from the code and the 2.37.6-beta image on 2026-11-11. Per `docker/AGENTS.md`, `node`'s only sudo grants are the entrypoint and `run-root-setup.sh` (the image has `/etc/sudoers.d/node-firewall`; its contents were not read). The image's apt sources are `http://deb.debian.org/debian` and `http://deb.debian.org/debian-security`, signed by `/usr/share/keyrings/debian-archive-keyring.pgp` (apt 3.0.3). `local` environments never run `root` steps; only `setupLocal`, behind the setup approval gate (`apps/backend/src/core/setup-approval.ts`).

**Decisions.**

- **How should a project get system packages in a restricted container?**
  - **A declarative field, for example `"aptPackages": ["libvips-dev"]`, installed by a root-owned wrapper that takes only validated package names (recommended).**
    - Pros: no repository-controlled command runs as root; packages come from Debian's signed archive; the field is data a launcher can show before anything runs.
    - Cons: Debian maintainer scripts still run as root (trusted, signed code, but code); covers apt packages only, not `curl | sh` installers or third-party repositories.
  - **A per-project image built on the host (`FROM` the environment image, plus the packages), cached by a hash of the list.**
    - Pros: nothing runs as root inside a live container; the build has the host's network, not the container's.
    - Cons: image builds, caching, disk use and rebuild semantics per project; slow first start; another lifecycle for container-lifecycle operations to own.
  - **Trust `root` steps that match the default branch's, as local `setupLocal` is trusted.**
    - Pros: tiny change; no new field.
    - Cons: still arbitrary root code from the repository, so a compromised or careless default branch defeats the boundary; on runtimes with an in-container firewall it can disable the restriction.
  - **Bake more tools into the image and add nothing.**
    - Pros: no runtime mechanism at all.
    - Cons: cannot cover every project's packages, and grows the image for everyone.
- **Which packages may the field name?**
  - **Any package from the image's configured Debian sources, with a short denylist of packages that change the boundary (`sudo` configuration, `iptables`, `nftables`, `ufw`, `openssh-server`) (recommended).**
    - Pros: useful for most projects at once; the denylist covers the obvious ways to widen access.
    - Cons: a denylist is never complete; any package's maintainer script runs as root.
  - **A fixed allowlist maintained in the repository.**
    - Pros: every installable package is reviewed.
    - Cons: every new need is a release; projects stay on Full access in the meantime.
- **Which runtimes may install packages under Restricted?**
  - **Only runtimes whose firewall is in an egress gateway (`egress-gateway=1`), where root inside the runtime cannot change the rules (recommended).**
    - Pros: a maintainer script cannot touch the firewall.
    - Cons: older runtimes keep the current rule until they are rebuilt.
  - **Every runtime.**
    - Pros: no capability check.
    - Cons: on an in-container firewall, root during the install holds `NET_ADMIN`.

### 2. Build the trusted package installer and its `orkestrator-ai.json` field

**Problem.** Nothing in the image installs packages on a project's behalf without running the project's own command as root.

**Context.** The installer would sit beside `run-root-setup.sh`, root-owned, with a sudoers grant for `node`, under every rule in `docker/AGENTS.md` ("Users and isolation"): reset `PATH` first, source nothing `node` can write, and read the package list as arguments rather than from a `node`-writable file. `workspace-setup.sh` would call it before `setupContainer`, and the image would gain a capability marker so the backend knows which images have it.

**Investigation.** Not started.

**Decisions.**

- **How is the list validated?**
  - **The wrapper accepts only Debian package names (`^[a-z0-9][a-z0-9+.-]+$`), at most a fixed count, refuses denylisted names, and runs `apt-get install --no-install-recommends` with `--` before them (recommended).**
    - Pros: no option or shell injection; the denylist is enforced by root, not by the script calling it.
    - Cons: no version pins (`name=version`) unless allowed explicitly.
  - **Accept `name=version` pins as well.**
    - Pros: reproducible installs.
    - Cons: a wider grammar to validate; Debian drops old versions from the archive.

### 3. Let a restricted container reach the package archive for the install

**Problem.** The image's apt sources use plain HTTP on port 80, and under network policy 3 a bare allowlist domain is reachable on TCP 443 only. `deb.debian.org` is not in `DEFAULT_ALLOWED_DOMAINS` either.

**Context.** The egress gateway applies allowlist edits in place (`update-firewall.sh --set-domains`), and its name filter checks TLS SNI or the HTTP Host header. The archive is signed, so the transport does not have to be trusted for integrity.

**Investigation.** Sources read from the image on 2026-11-11. Not checked: whether `deb.debian.org` serves both archives over HTTPS everywhere the image is used.

**Decisions.**

- **How does the install reach the archive?**
  - **Switch the image's sources to `https://deb.debian.org` and add the Debian hosts to an environment's required domains only when its project declares packages (recommended).**
    - Pros: works with policy 3's TCP 443 default and the name filter; projects without packages are unchanged.
    - Cons: those environments can reach Debian's mirrors for their whole life, not just during setup.
  - **Open the hosts for the install only, then remove them with `--set-domains`.**
    - Pros: the narrowest reach.
    - Cons: a second firewall edit per start, and the agent cannot install a package later in the session.
  - **Name `deb.debian.org:80` entries and keep HTTP.**
    - Pros: no image change.
    - Cons: plain HTTP through the name filter's Host check only; one more port opened.

### 4. Tell launchers and setup output about packages, separately from root steps

**Problem.** The launchers now warn when a project has `root` steps and Restricted is chosen (`get_project_setup_requirements`, `apps/backend/src/core/project-setup-requirements.ts`). A project that declares packages instead needs no warning on a capable runtime, but should say that Debian's mirrors will be reachable.

**Context.** `get_project_setup_requirements` returns `{ rootSteps }`. A new optional `packages` count is a compatible addition (`docs/architecture/version-compatibility.md`, "How to add a command").

**Investigation.** Not started.

**Decisions.** None beyond tasks 1 to 3.

### 5. Qualify it live and document it

**Problem.** The installer runs as root inside the container boundary, so it needs the same live evidence as the other root paths.

**Context.** `docker/tests/root-boundary-smoke.sh` plants files as `node` and fails if a root process runs them; the installer must pass it. The Container live qualification workflow covers restricted boots on both architectures.

**Investigation.** Not started.

**Decisions.** None.

## Constraints and rationale

- The `root-steps-need-full-network` setup failure reason stays: older images emit it, and `root` steps keep their current rule.
- Never let the installer read its list from a path `node` can write; the arguments come from the setup script's own parse.

## Related

- `docker/run-root-setup.sh`, `docker/workspace-setup.sh` (`run_project_root_setup`).
- `docker/AGENTS.md`, "Users and isolation" and "Network isolation".
- The launcher warning for root steps (`BuildLaunchDialog`, `CreateEnvironmentDialog`), added 2026-11-11.
