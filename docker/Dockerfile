# Bun is the primary runtime: it builds and runs the bridge servers. This tag
# mirrors the developer and CI version managed by the repository's mise.toml.
# Both stages pin the same multi-architecture index digest, so a rebuild cannot
# silently pick up a different base. Refresh it deliberately (security updates
# to the same tag, or a Bun bump): `docker buildx imagetools inspect
# oven/bun:<tag>` and replace the digest on both FROM lines.
# `-debian` variant is glibc-based (Debian), which keeps the musl-delete logic
# for the Claude Agent SDK below valid. (An Alpine/musl base would invert it.)
# ---------------------------------------------------------------------------
# Bridge build stage. Everything here — the workspace install, sources, the
# build tooling — stays out of the delivered image; the final stage copies
# only each bridge's runtime output. Same pinned base (and glibc) as the final
# stage, so vendored native helpers match the runtime.
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.4-debian@sha256:93d5032fe06d163427822dc1598f420363759bb18155c9cc90eb1be05a64a19e AS bridge-build
WORKDIR /opt/bridge-build
# Manifests first: a source edit reuses the install layer; a lockfile, patch or
# manifest edit invalidates it. Every workspace manifest is present so the
# frozen lockfile resolves exactly as it does in the repository. Root
# patchedDependencies are validated even for workspaces that do not use them.
COPY package.json bun.lock ./
COPY patches ./patches
COPY apps/backend/package.json apps/backend/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/web-public/package.json apps/web-public/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/toolchain/package.json packages/toolchain/package.json
COPY bridges/claude-bridge/package.json bridges/claude-bridge/package.json
COPY bridges/codex-bridge/package.json bridges/codex-bridge/package.json
COPY bridges/acp-bridge/package.json bridges/acp-bridge/package.json
COPY bridges/pi-bridge/package.json bridges/pi-bridge/package.json
COPY bridges/cursor-bridge/package.json bridges/cursor-bridge/package.json
RUN bun install --frozen-lockfile --filter claude-bridge --filter codex-bridge \
      --filter acp-bridge --filter pi-bridge --filter cursor-bridge
# Each bridge's sources arrive just before its own build, least-changed first,
# so an edit to one bridge rebuilds only it and the bridges after it.
#
# The vendored SDKs (dist/node_modules) are moved to /opt/bridge-deps, so the
# final stage can ship them in their own layers ahead of the bundles. They
# change only when an SDK does; the bundles change nearly every release.
COPY packages/protocol packages/protocol
# Pi: the SDK compiles extension TypeScript with jiti and reads themes and
# templates from its package files, so `vendor` keeps it in dist/node_modules.
COPY bridges/pi-bridge bridges/pi-bridge
RUN cd bridges/pi-bridge && bun run build && rm -rf node_modules \
 && mkdir -p /opt/bridge-deps && mv dist/node_modules /opt/bridge-deps/pi-bridge
# Cursor: `vendor` stages the SDK's Linux platform package (ripgrep, the
# sandbox helper, tree-sitter grammars) into dist/node_modules.
COPY bridges/cursor-bridge bridges/cursor-bridge
RUN cd bridges/cursor-bridge && bun run build && rm -rf node_modules \
 && mkdir -p /opt/bridge-deps && mv dist/node_modules /opt/bridge-deps/cursor-bridge
# ACP, like Codex below, bundles every dependency into dist/index.js.
COPY bridges/acp-bridge bridges/acp-bridge
RUN cd bridges/acp-bridge && bun run build && rm -rf node_modules
# Claude: the SDK stays external and `vendor` copies it into dist/node_modules.
# The SDK picks its native binary by libc; on this glibc base it resolves the
# gnu variant, so the unused musl variant (~225 MB) is dropped. An Alpine/musl
# base would invert this.
COPY bridges/claude-bridge bridges/claude-bridge
RUN cd bridges/claude-bridge && bun run build \
 && rm -rf node_modules \
 && rm -rf dist/node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl \
 && mkdir -p /opt/bridge-deps && mv dist/node_modules /opt/bridge-deps/claude-bridge
COPY bridges/codex-bridge bridges/codex-bridge
RUN cd bridges/codex-bridge && bun run build && rm -rf node_modules

# ---------------------------------------------------------------------------
# Development runtime image.
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.4-debian@sha256:93d5032fe06d163427822dc1598f420363759bb18155c9cc90eb1be05a64a19e

ARG TZ
ENV TZ="$TZ"

# Install basic development tools and iptables/ipset. curl/wget/xz-utils/
# ca-certificates are not present in the bun base image (the node base bundled
# them) and are needed by the tool installers below. util-linux (setpriv) is
# Essential in Debian and already present; it is named so the privilege drop's
# dependency is explicit and stays in this one apt layer.
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  wget \
  xz-utils \
  openssh-client \
  less \
  git \
  procps \
  sudo \
  fzf \
  zsh \
  man-db \
  unzip \
  gnupg2 \
  gh \
  ripgrep \
  iptables \
  ipset \
  conntrack \
  iproute2 \
  dnsutils \
  aggregate \
  jq \
  nano \
  vim \
  tmux \
  inotify-tools \
  locales \
  util-linux \
  && apt-get clean && rm -rf /var/lib/apt/lists/* \
  && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen

# The bun base image ships a `bun` user (uid/gid 1000). The app hardcodes
# `docker exec -u node` and /home/node paths, so rename it to `node` while
# preserving uid/gid 1000 (keeps workspace bind-mount ownership consistent).
RUN groupmod -n node bun \
  && usermod -l node -d /home/node -m bun

# Install a real Node.js 24 LTS runtime. bun runs our bridge servers, but the agent
# CLIs — especially `claude`, which is a Node app launched directly in container
# terminals — need genuine Node (not bun's node shim). This also provides npm
# for the global CLI installs below. /usr/local/bin precedes the bun-node
# fallback on PATH, so this node takes precedence.
ARG NODE_VERSION=24.22.2
RUN ARCH="$(dpkg --print-architecture)" && \
  case "$ARCH" in \
    amd64) NODE_ARCH=x64 ;; \
    arm64) NODE_ARCH=arm64 ;; \
    *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; \
  esac && \
  NODE_TARBALL="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" && \
  cd /tmp && \
  curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}" && \
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o SHASUMS256.txt && \
  # Verify the tarball against the published checksum before extracting, rather
  # than piping curl straight into tar (a corrupted/MITM'd download would
  # otherwise become the runtime that executes agent code).
  grep " ${NODE_TARBALL}\$" SHASUMS256.txt | sha256sum -c - && \
  tar -xJf "${NODE_TARBALL}" -C /usr/local --strip-components=1 --no-same-owner && \
  rm -f "${NODE_TARBALL}" SHASUMS256.txt

# Global npm installs go to node's own npm-global directory. /usr/local/share
# itself stays root-owned: root's zsh loads completion functions from
# /usr/local/share/zsh/site-functions, so a node-writable parent would let node
# plant code that every root terminal runs (verify-root-boundary.sh).
RUN install -d -o node -g node -m 0755 /usr/local/share/npm-global

ARG USERNAME=node

# Persist node shell history. Root terminals use /root/.zsh_history instead so
# privileged commands are never exposed to the unprivileged node account.
RUN mkdir /commandhistory \
  && touch /commandhistory/.bash_history \
  && chown -R $USERNAME /commandhistory \
  && install -o root -g root -m 0600 /dev/null /root/.zsh_history

# Set `DEVCONTAINER` environment variable to help with orientation
ENV DEVCONTAINER=true

# Create workspace and config directories and set permissions
RUN mkdir -p /workspace /opencode-state /home/node/.claude /home/node/.codex /home/node/.cursor /home/node/.grok /home/node/.pi/agent /home/node/.config/opencode /home/node/.config/grok /home/node/.local/share/opencode /home/node/.local/state/opencode && \
  chown -R node:node /workspace /home/node/.claude /home/node/.codex /home/node/.cursor /home/node/.grok /home/node/.pi /home/node/.config /home/node/.local

WORKDIR /workspace

ARG GIT_DELTA_VERSION=0.20.1
RUN ARCH=$(dpkg --print-architecture) && \
  case "$ARCH" in \
    amd64) GIT_DELTA_SHA=0683067a4cbbcc19b9fd2841253131d1b37ccfa724725098d811d4d0d9fcc25b ;; \
    arm64) GIT_DELTA_SHA=6e08b734d611037eb9eb5db883cab7ac0a089216a9efdc1d2caac44319029c28 ;; \
    *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; \
  esac && \
  wget "https://github.com/dandavison/delta/releases/download/${GIT_DELTA_VERSION}/git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  printf '%s  %s\n' "$GIT_DELTA_SHA" "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" | sha256sum -c - && \
  sudo dpkg -i "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  rm "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb"

# Set up non-root user
USER node

# Install global packages
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin

# Container terminals use Zsh, with Starship owning the prompt rendering.
ENV SHELL=/bin/zsh
ENV LANG=en_US.UTF-8
ENV LANGUAGE=en_US:en
ENV LC_ALL=en_US.UTF-8

# Set the default editor and visual
ENV EDITOR=nano
ENV VISUAL=nano

# Every agent version in the next block must equal PINNED_TOOLCHAIN_VERSIONS in
# packages/toolchain/src/manifest.ts, and the SHA literals further down
# must equal that manifest's linux digests. The image cannot read the manifest,
# so these are a second copy; `every shipped agent, uniformly` in
# tests/unit/version-drift.test.ts is what stops the two drifting.
#   CODEX_CLI_VERSION     ↔ config/codex-version.json and the generated app-server protocol
#   OPENCODE_CLI_VERSION  ↔ @opencode-ai/sdk in apps/backend/package.json
#   OPENCODE2_CLI_VERSION ↔ PINNED_TOOLCHAIN_VERSIONS.opencode2 (OpenCode 2.x, beside 1.x)
#   PI_CLI_VERSION        ↔ the four @earendil-works/pi-* pins in bridges/pi-bridge/package.json
# Claude CLI has its own release train, distinct from
# @anthropic-ai/claude-agent-sdk.
ARG CLAUDE_CLI_VERSION=2.1.319
ARG CODEX_CLI_VERSION=0.167.0
ARG OPENCODE_CLI_VERSION=1.19.5
ARG OPENCODE2_CLI_VERSION=2.2.6
ARG GROK_BUILD_VERSION=1.0.77
ARG PI_CLI_VERSION=1.5.0

# Install Claude Code from the pinned npm package. The package pulls in the
# platform-native binary via optional dependencies. Every global npm install
# clears npm's download cache in the same RUN: otherwise ~/.npm/_cacache keeps a
# second copy of each package (356 MB across the three installs).
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}" \
 && npm cache clean --force
ENV CLAUDE_CLI_PATH=/usr/local/share/npm-global/bin/claude
# Keep the pinned CLI on its pin, as CLAUDE_PINNED_RUNTIME_ENV does on the
# host: otherwise terminal Claude updates the global install in place and the
# container runs a version the manifest does not declare. Plugins still update.
ENV DISABLE_AUTOUPDATER=1 FORCE_AUTOUPDATE_PLUGINS=1

# Install OpenCode from the same pinned, digest-verified release artifacts as
# the packaged desktop toolchain.
# Retry transient release-host failures with bounded attempts and timeouts.
# The binary is root-owned in /opt/opencode, because `orkestrator-bridge-launch
# opencode` starts the container's server from it: a copy in node's home could
# be replaced by the agent before the next start. node's PATH and
# OPENCODE_CLI_PATH keep their old path through a symlink.
USER root
RUN ARCH="$(dpkg --print-architecture)" && \
  case "$ARCH" in \
    amd64) OPENCODE_ARCH=x64; OPENCODE_SHA=588310a336fa3b9df36b3f0225b26f679d453efaad0cf3d66c3651ef3ec1647a ;; \
    arm64) OPENCODE_ARCH=arm64; OPENCODE_SHA=fae5be262d693b7c5e562856cc473e59e741772936db0c0600ac0d5ed5bd088b ;; \
    *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; \
  esac && \
  install -d -o root -g root -m 0755 /opt/opencode /opt/opencode/bin && \
  curl -fsSL --retry 5 --retry-max-time 300 --connect-timeout 30 --max-time 300 \
    "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_CLI_VERSION}/opencode-linux-${OPENCODE_ARCH}.tar.gz" -o /tmp/opencode.tar.gz && \
  printf '%s  %s\n' "$OPENCODE_SHA" /tmp/opencode.tar.gz | sha256sum -c - && \
  tar -xzf /tmp/opencode.tar.gz --no-same-owner -C /opt/opencode/bin opencode && \
  chown root:root /opt/opencode/bin/opencode && \
  chmod 755 /opt/opencode/bin/opencode && \
  rm /tmp/opencode.tar.gz && \
  install -d -o node -g node /home/node/.opencode /home/node/.opencode/bin && \
  ln -s /opt/opencode/bin/opencode /home/node/.opencode/bin/opencode && \
  chown -h node:node /home/node/.opencode/bin/opencode
USER node
ENV OPENCODE_CLI_PATH=/home/node/.opencode/bin/opencode
# Never offer /update: it would replace the pinned binary with OpenCode 2.
ENV OPENCODE_DISABLE_AUTOUPDATE=1

# OpenCode 2.x, installed beside the 1.x binary as `opencode2`: the same npm
# platform tarball and digests as the desktop toolchain's `opencode2` entry
# (glibc build; the image is Debian). Root-owned in /opt/opencode for the same
# reason as 1.x: `orkestrator-bridge-launch opencode2` starts the container's
# 2.x server from it. node's `opencode2` is a symlink to it.
USER root
RUN ARCH="$(dpkg --print-architecture)" && \
  case "$ARCH" in \
    amd64) OPENCODE2_TARGET=linux-x64; OPENCODE2_SHA=dfcd69f1d511ae10ed626768b41d84b8100cc4aa64cecb69da38ba7a29d33551 ;; \
    arm64) OPENCODE2_TARGET=linux-arm64; OPENCODE2_SHA=22352e200630ec61a48a65b9f5c2b627328ae5002658d81c067f67c5fb689898 ;; \
    *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; \
  esac && \
  mkdir -p /tmp/opencode2 && \
  curl -fsSL --retry 5 --retry-max-time 300 --connect-timeout 30 --max-time 300 \
    "https://registry.npmjs.org/@opencode/cli-${OPENCODE2_TARGET}/-/cli-${OPENCODE2_TARGET}-${OPENCODE2_CLI_VERSION}.tgz" -o /tmp/opencode2.tgz && \
  printf '%s  %s\n' "$OPENCODE2_SHA" /tmp/opencode2.tgz | sha256sum -c - && \
  tar -xzf /tmp/opencode2.tgz -C /tmp/opencode2 --no-same-owner package/bin/opencode && \
  mv /tmp/opencode2/package/bin/opencode /opt/opencode/bin/opencode2 && \
  chown root:root /opt/opencode/bin/opencode2 && \
  chmod 755 /opt/opencode/bin/opencode2 && \
  rm -rf /tmp/opencode2 /tmp/opencode2.tgz && \
  ln -s /opt/opencode/bin/opencode2 /home/node/.opencode/bin/opencode2 && \
  chown -h node:node /home/node/.opencode/bin/opencode2
USER node
ENV OPENCODE2_CLI_PATH=/home/node/.opencode/bin/opencode2

# Install Codex CLI
RUN npm install -g "@openai/codex@${CODEX_CLI_VERSION}" \
 && npm cache clean --force
ENV CODEX_CLI_PATH=/usr/local/share/npm-global/bin/codex
ENV PATH="/usr/local/share/npm-global/bin:/home/node/.opencode/bin:$PATH"

# Grok Build is a single native executable. The download is pinned and hash
# verified.
USER root
RUN ARCH="$(dpkg --print-architecture)" && \
  case "$ARCH" in \
    amd64) GROK_ARCH=x86_64; GROK_SHA=b702950aa5827d855e493278ab6215a4e0f5bceb5bba6c6243a9f55cdd143b0a ;; \
    arm64) GROK_ARCH=aarch64; GROK_SHA=b30eee14a656124ef3c9da8577b5e783ef2cffabeb2b679c5c49633e77eed574 ;; \
    *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; \
  esac && \
  curl -fsSL "https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-${GROK_BUILD_VERSION}-linux-${GROK_ARCH}" -o /usr/local/bin/grok && \
  printf '%s  %s\n' "$GROK_SHA" /usr/local/bin/grok | sha256sum -c - && \
  chmod 755 /usr/local/bin/grok

# Pi ships as a self-contained bundle: the launcher loads its themes, docs,
# examples and a native helper module from beside itself, so the tree is kept
# intact rather than reduced to a single binary. Pinned and hash verified like
# the two above; the digests match the ones in
# packages/toolchain/src/manifest.ts for the same version.
RUN ARCH="$(dpkg --print-architecture)" && \
  case "$ARCH" in \
    amd64) PI_ARCH=x64; PI_SHA=df870ba0e344cb7b3358d8d8f19397b8b8d225a8669784736ad68a5c2169d53b ;; \
    arm64) PI_ARCH=arm64; PI_SHA=5d5711b48600756473682e86360b026b11abf7591e5d112eb411d4da2c100d9a ;; \
    *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; \
  esac && \
  curl -fsSL "https://github.com/earendil-works/pi/releases/download/v${PI_CLI_VERSION}/pi-linux-${PI_ARCH}.tar.gz" -o /tmp/pi.tar.gz && \
  printf '%s  %s\n' "$PI_SHA" /tmp/pi.tar.gz | sha256sum -c - && \
  mkdir -p /opt/pi && \
  tar -xzf /tmp/pi.tar.gz -C /opt/pi --strip-components=1 --no-same-owner && \
  ln -s /opt/pi/pi /usr/local/bin/pi && \
  chmod 755 /opt/pi/pi && \
  rm -f /tmp/pi.tar.gz
USER node
ENV PI_CLI_PATH=/usr/local/bin/pi

# Fail the image build immediately if an installer completed without leaving a
# runnable CLI at the path the backend will use.
RUN "$CLAUDE_CLI_PATH" --version \
 && "$CODEX_CLI_PATH" --version \
 && "$OPENCODE_CLI_PATH" --version \
 && "$OPENCODE2_CLI_PATH" --version \
 && grok --version \
 && "$PI_CLI_PATH" --version

# Codex spawns `codex-code-mode-host` from its own directory for every code-mode
# turn, and the models that default to code mode are unusable without it. The
# npm package vendors it next to `codex`; assert that rather than assume it.
# `$CODEX_CLI_PATH` is npm's JS shim, so the host sits beside the vendored
# binary the shim execs, not beside the shim.
RUN find /usr/local/share/npm-global/lib/node_modules/@openai \
      -type f -name codex-code-mode-host | grep -q .

# Playwright, with its browser bundle baked into the image. Agents cannot fetch
# it themselves at runtime: the restricted-network firewall does not allow
# Playwright's CDN, so an unprepared container fails at `playwright install`.
#
# Chromium (Playwright's own build) rather than branded Google Chrome: Google
# publishes no linux/arm64 Chrome package, so `playwright install chrome` cannot
# build this image on Apple Silicon. Chromium is Playwright's default browser and
# `playwright install chromium` also brings the headless shell that
# `channel: "chromium-headless-shell"` and headless runs resolve.
#
# Playwright's default `chromiumSandbox: false` is load-bearing here and must not
# be overridden: the container has neither CAP_SYS_ADMIN nor unprivileged user
# namespaces (the default seccomp profile blocks them), so an explicit
# `chromiumSandbox: true` dies with "Chromium sandboxing failed!". The container
# is the isolation boundary.
ARG PLAYWRIGHT_VERSION=1.65.0
# One shared browser root, readable by `node` and by the uid-0 `orkroot` used for
# root terminals, instead of a per-user ~/.cache/ms-playwright copy.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm install -g "playwright@${PLAYWRIGHT_VERSION}" \
 && npm cache clean --force
USER root
RUN playwright install --with-deps chromium \
  && chown -R node:node /ms-playwright \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Fail the build if the browser cannot actually start — a missing shared library
# is the usual way this install "succeeds" and then fails on first use.
#
# Checked once per container identity rather than once per image. Chromium
# refuses to start as uid 0 unless it is launched with --no-sandbox, which is
# precisely what Playwright's default `chromiumSandbox: false` passes — so "works
# for the `orkroot` root terminal" is a separate claim from "works for `node`",
# and each is proven rather than inferred from the other. `orkroot` is created
# further down but is only uid 0 with HOME=/root, which is what `USER root` is
# here.
COPY docker/verify-playwright.cjs /usr/local/share/verify-playwright.cjs
RUN playwright --version \
  && NODE_PATH=/usr/local/share/npm-global/lib/node_modules \
     node /usr/local/share/verify-playwright.cjs
USER node
RUN NODE_PATH=/usr/local/share/npm-global/lib/node_modules \
    node /usr/local/share/verify-playwright.cjs

# Layer order from here on is by how often a layer changes, rarest first: a
# changed layer re-pulls itself and every layer after it. Starship and mise
# change a few times a year, the vendored bridge SDKs with each SDK bump, the
# bridge bundles nearly every release, so the bundles come last of the large
# layers and the small scripts after them.
USER root

# Starship owns the interactive Zsh prompt. Use the static musl artifacts on
# both supported architectures so the prompt binary has no runtime libc
# dependency, and verify the pinned release before installing it.
ARG STARSHIP_VERSION=1.26.0
RUN ARCH="$(dpkg --print-architecture)" && \
  case "$ARCH" in \
    amd64) STARSHIP_TARGET=x86_64-unknown-linux-musl; STARSHIP_SHA=b7c232b0e8249d8e55a40beb79c5c43a7d370f3f9408bd215deb0170daeaadf3 ;; \
    arm64) STARSHIP_TARGET=aarch64-unknown-linux-musl; STARSHIP_SHA=dc30189378d2f2e287384e8a692d3f95ad1df64cf0e8c36aa9201516028aed6b ;; \
    *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; \
  esac && \
  STARSHIP_TARBALL="starship-${STARSHIP_TARGET}.tar.gz" && \
  curl -fsSL "https://github.com/starship/starship/releases/download/v${STARSHIP_VERSION}/${STARSHIP_TARBALL}" -o "/tmp/${STARSHIP_TARBALL}" && \
  printf '%s  %s\n' "$STARSHIP_SHA" "/tmp/${STARSHIP_TARBALL}" | sha256sum -c - && \
  tar -xzf "/tmp/${STARSHIP_TARBALL}" -C /usr/local/bin starship --no-same-owner && \
  chmod 755 /usr/local/bin/starship && \
  rm -f "/tmp/${STARSHIP_TARBALL}" && \
  starship --version

# Install mise after the expensive CLI and browser layers so a mise-only version
# bump does not invalidate them, and before the bridges so a bridge release
# does not re-pull it. Host installations cannot be reused here: their binaries
# target macOS and the container runs Linux. Keep both supported image
# architectures pinned to config/mise-version.json.
#
# Bun is the base image's own /usr/local/bin/bun, registered in mise's shared
# system tool directory with `mise link` rather than downloaded a second time
# (`mise install --system` would add another 107 MB binary and a 50 MB download
# cache). A repository pinning the same Bun therefore needs no download, and the
# install stays visible if a devcontainer mounts over the node user's home.
ARG MISE_VERSION=2026.10.9
RUN ARCH="$(dpkg --print-architecture)" && \
  case "$ARCH" in \
    amd64) MISE_ARCH=x64; MISE_SHA=7af2e3d798e9ddec142f5a968a18c3f33aa68d19aa8a4111302d4c7d04feb6fa ;; \
    arm64) MISE_ARCH=arm64; MISE_SHA=9a58b5b72e58ed66f38d6d2550c2f6279d8c39884574c389a39a9c441a5580b9 ;; \
    *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; \
  esac && \
  MISE_TARBALL="mise-v${MISE_VERSION}-linux-${MISE_ARCH}.tar.gz" && \
  curl -fsSL "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/${MISE_TARBALL}" -o "/tmp/${MISE_TARBALL}" && \
  printf '%s  %s\n' "$MISE_SHA" "/tmp/${MISE_TARBALL}" | sha256sum -c - && \
  mkdir -p /opt/mise && \
  tar -xzf "/tmp/${MISE_TARBALL}" -C /opt/mise --strip-components=1 --no-same-owner && \
  ln -s /opt/mise/bin/mise /usr/local/bin/mise && \
  chmod 755 /opt/mise/bin/mise && \
  test "$(/usr/local/bin/bun --version)" = "1.4.4" && \
  mkdir -p /opt/bun/bin && \
  ln -s /usr/local/bin/bun /opt/bun/bin/bun && \
  ln -s bun /opt/bun/bin/bunx && \
  MISE_DATA_DIR=/usr/local/share/mise mise link bun@1.4.4 /opt/bun && \
  rm -rf /usr/local/share/mise/shims && \
  BUN_INSTALL_DIR="$(mise where bun@1.4.4)" && \
  test -x "$BUN_INSTALL_DIR/bin/bun" && \
  test "$(readlink -f "$BUN_INSTALL_DIR/bin/bun")" = /usr/local/bin/bun && \
  mise exec bun@1.4.4 -- bun --version && \
  printf '%s\n' 'eval "$(/usr/local/bin/mise activate zsh)"' >> /home/node/.zshrc && \
  chown node:node /home/node/.zshrc && \
  rm -rf "/tmp/${MISE_TARBALL}" /root/.cache/mise && \
  mise --version

# Repository-controlled setup commands already execute inside this isolated
# workspace, so its mise configuration follows the same trust boundary. Disable
# self-update hints because the image pin, not mise, owns binary upgrades.
ENV MISE_TRUSTED_CONFIG_PATHS=/workspace
ENV MISE_SELF_UPDATE_AVAILABLE=false

# Bridge runtime output only (built in the bridge-build stage above), at the
# paths the backend launches: /opt/<name>/dist/index.js. The vendored SDKs go
# first, each in its own layer, so a release that changes only bridge code
# re-pulls the small bundles and not the SDKs. Within each group the bridge
# that changes least comes first.
# Root-owned: code `node` could replace would see every token presented to the
# bridge it next runs as.
COPY --from=bridge-build --chown=root:root /opt/bridge-deps/pi-bridge /opt/pi-bridge/dist/node_modules
COPY --from=bridge-build --chown=root:root /opt/bridge-deps/cursor-bridge /opt/cursor-bridge/dist/node_modules
COPY --from=bridge-build --chown=root:root /opt/bridge-deps/claude-bridge /opt/claude-bridge/dist/node_modules
COPY --from=bridge-build --chown=root:root /opt/bridge-build/bridges/pi-bridge /opt/pi-bridge
COPY --from=bridge-build --chown=root:root /opt/bridge-build/bridges/cursor-bridge /opt/cursor-bridge
COPY --from=bridge-build --chown=root:root /opt/bridge-build/bridges/acp-bridge /opt/acp-bridge
COPY --from=bridge-build --chown=root:root /opt/bridge-build/bridges/claude-bridge /opt/claude-bridge
COPY --from=bridge-build --chown=root:root /opt/bridge-build/bridges/codex-bridge /opt/codex-bridge
# Every bridge entrypoint must exist in the final filesystem.
RUN for bridge in claude codex acp pi cursor; do \
      test -s "/opt/${bridge}-bridge/dist/index.js" || { echo "missing ${bridge} bridge" >&2; exit 1; }; \
      test "$(stat -c %U "/opt/${bridge}-bridge" "/opt/${bridge}-bridge/dist" | sort -u)" = root \
        || { echo "${bridge} bridge directories are not owned by root" >&2; exit 1; }; \
    done \
 && test -d /opt/claude-bridge/dist/node_modules/@anthropic-ai \
 && test -d /opt/pi-bridge/dist/node_modules \
 && test -d /opt/cursor-bridge/dist/node_modules \
 && ! ls -d /opt/claude-bridge/dist/node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl 2>/dev/null

COPY docker/starship.toml /etc/starship.toml
COPY docker/container-git-aliases.zsh /etc/orkestrator/git-aliases.zsh
COPY docker/container-zshrc.zsh /etc/orkestrator/zshrc
ENV STARSHIP_CONFIG=/etc/starship.toml
RUN printf '%s\n' 'source /etc/orkestrator/zshrc' >> /etc/zsh/zshrc \
  && STARSHIP_CONFIG=/etc/starship.toml starship prompt >/dev/null

USER node
WORKDIR /workspace
RUN test "$(/usr/local/bin/bun --version)" = "1.4.4" \
 && test "$(/usr/local/bin/bunx --version)" = "1.4.4" \
 && printf '%s\n' '[env]' 'ORKESTRATOR_MISE_TRUST_SMOKE = "trusted"' > mise.toml \
 && zsh -ic 'command -v mise >/dev/null && typeset -f _mise_hook >/dev/null && test "$ORKESTRATOR_MISE_TRUST_SMOKE" = trusted && mise --version' \
 && rm mise.toml

# Copy and set up firewall scripts
COPY docker/init-firewall.sh docker/update-firewall.sh docker/run-root-setup.sh /usr/local/bin/
COPY docker/orkestrator-egress-gateway.sh /usr/local/bin/orkestrator-egress-gateway
# The gateway's name checks: Perl from the base system (perl-base, already in
# the image for the log writer), so no new package or download to pin.
COPY docker/orkestrator-egress-filter.pl /usr/local/bin/orkestrator-egress-filter
COPY docker/firewall-domains.sh /usr/local/lib/orkestrator/firewall-domains.sh
COPY docker/default-allowed-domains /usr/local/lib/orkestrator/default-allowed-domains
USER root
# The root entrypoint runs the firewall before privileges drop, so node's
# only grants are that entrypoint (which records the policy once) and the
# full-mode root setup. An egress gateway runs the same image as root.
RUN chmod +x /usr/local/bin/init-firewall.sh /usr/local/bin/update-firewall.sh /usr/local/bin/run-root-setup.sh /usr/local/bin/orkestrator-egress-gateway && \
  chown root:root /usr/local/bin/orkestrator-egress-filter && chmod 0755 /usr/local/bin/orkestrator-egress-filter && \
  perl -c /usr/local/bin/orkestrator-egress-filter && \
  chown -R root:root /usr/local/lib/orkestrator && chmod 0755 /usr/local/lib/orkestrator && \
  chmod 0644 /usr/local/lib/orkestrator/firewall-domains.sh /usr/local/lib/orkestrator/default-allowed-domains && \
  printf '%s\n' \
    'Defaults!/usr/local/bin/network-policy-entrypoint.sh env_keep += "NETWORK_MODE ALLOWED_DOMAINS ORKESTRATOR_NETWORK_POLICY ORKESTRATOR_HOST_SERVICE_PORTS ORKESTRATOR_INGRESS_PORTS ORKESTRATOR_EGRESS"' \
    'node ALL=(root) NOPASSWD: /usr/local/bin/network-policy-entrypoint.sh *' \
    'node ALL=(root) NOPASSWD: /usr/local/bin/run-root-setup.sh *' \
    > /etc/sudoers.d/node-firewall && \
  chmod 0440 /etc/sudoers.d/node-firewall

# Create orkroot user with UID 0 (root-equivalent) for root terminal sessions
# -o allows non-unique UID, -u 0 -g 0 makes user root-equivalent
RUN useradd -o -u 0 -g 0 -M -d /root -s /bin/zsh orkroot

# Exercise the shell contract as both terminal identities while the image is
# built. The verifier cleans up its sentinel history before the layer commits.
COPY docker/verify-container-shell.sh /usr/local/share/verify-container-shell.sh
RUN chmod 755 /usr/local/share/verify-container-shell.sh \
  && /usr/local/share/verify-container-shell.sh

# Configure SSH from provider-published host keys committed with the image.
COPY docker/known_hosts /usr/local/share/orkestrator-known-hosts
RUN mkdir -p /home/node/.ssh && \
  install -o node -g node -m 0644 /usr/local/share/orkestrator-known-hosts /home/node/.ssh/known_hosts && \
  chown -R node:node /home/node/.ssh && \
  chmod 700 /home/node/.ssh

# Copy entrypoint and workspace setup scripts
COPY docker/entrypoint.sh docker/network-policy-entrypoint.sh /usr/local/bin/
COPY docker/workspace-setup.sh /usr/local/bin/
COPY docker/orkestrator-drain.sh /usr/local/bin/orkestrator-drain.sh
COPY docker/orkestrator-storage.sh /usr/local/bin/orkestrator-storage.sh
COPY docker/orkestrator-migrate.sh /usr/local/bin/orkestrator-migrate.sh
COPY docker/orkestrator-log-writer.sh /usr/local/bin/orkestrator-log-writer
COPY docker/orkestrator-state-signal.sh /usr/local/bin/orkestrator-state-signal
COPY docker/orkestrator-worktree-signal.sh /usr/local/bin/orkestrator-worktree-signal
COPY docker/orkestrator-git-credential.sh /usr/local/bin/orkestrator-git-credential
COPY docker/orkestrator-bridge-launch.sh /usr/local/bin/orkestrator-bridge-launch
# /run/orkestrator-opencode and /run/orkestrator-opencode2 hold the
# configuration and package cache the backend writes, as root, for the OpenCode
# 1.x and 2.x servers `orkestrator-bridge-launch opencode`/`opencode2` start.
# Per-boot status and process registration. Owned by node because the
# entrypoint runs as node after the network policy is fixed; the records are
# orchestration evidence, not a security boundary against the same user.
RUN install -d -o root -g root -m 0700 /run/orkestrator-bridge \
 && install -d -o root -g root -m 0755 /run/orkestrator-opencode \
 && install -d -o root -g root -m 0755 /run/orkestrator-opencode2 \
 && install -d -o node -g node -m 0755 /run/orkestrator /run/orkestrator/processes \
 && chmod 0755 /usr/local/bin/orkestrator-drain.sh /usr/local/bin/orkestrator-storage.sh /usr/local/bin/orkestrator-migrate.sh /usr/local/bin/orkestrator-log-writer /usr/local/bin/orkestrator-state-signal /usr/local/bin/orkestrator-worktree-signal /usr/local/bin/orkestrator-git-credential /usr/local/bin/orkestrator-bridge-launch \
 && chown root:root /usr/local/bin/orkestrator-bridge-launch
# Exercise the installed writer as its runtime user, including actual Perl
# startup, rotation errors, signals, /dev/full and the no-Perl drain fallback.
COPY docker/tests/log-writer-test.sh /tmp/orkestrator-log-writer-test.sh
RUN su node -s /bin/bash -c 'bash /tmp/orkestrator-log-writer-test.sh /usr/local/bin/orkestrator-log-writer' \
 && rm /tmp/orkestrator-log-writer-test.sh
COPY docker/git-branch-helpers.sh /usr/local/bin/
COPY docker/runtime-env.sh /usr/local/bin/orkestrator-runtime-env.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh /usr/local/bin/network-policy-entrypoint.sh /usr/local/bin/workspace-setup.sh /usr/local/bin/git-branch-helpers.sh /usr/local/bin/orkestrator-runtime-env.sh \
  && command -v setpriv \
  && test "$(setpriv --reuid=node --regid=node --init-groups id -u)" = "$(id -u node)"

# Nothing a root exec, root script or root shell resolves or sources may be
# writable by node. Checked once every script and directory is in place; the
# manifest layer below adds only a root-owned file.
COPY docker/verify-root-boundary.sh /usr/local/share/verify-root-boundary.sh
RUN chmod 755 /usr/local/share/verify-root-boundary.sh \
  && /usr/local/share/verify-root-boundary.sh

# Image manifest: identity, pinned versions and the container contracts this
# image implements. Generated from the ARG pins above and verified against the
# scripts installed in this layer; see docker/image-manifest.ts. The backend
# reads it from a never-started container, so the entrypoint never runs to
# answer "what is this image?".
ARG ORKESTRATOR_SOURCE_REVISION=unknown
ARG ORKESTRATOR_IMAGE_CAPABILITIES=unverified
LABEL org.orkestrator.image.manifest-schema="1" \
      org.orkestrator.image.capabilities="${ORKESTRATOR_IMAGE_CAPABILITIES}"
COPY package.json /tmp/orkestrator-manifest/package.json
COPY packages/protocol/src/image-manifest.ts /tmp/orkestrator-manifest/packages/protocol/src/image-manifest.ts
COPY docker/image-manifest.ts /tmp/orkestrator-manifest/docker/image-manifest.ts
RUN ORKESTRATOR_PACKAGE_JSON=/tmp/orkestrator-manifest/package.json \
    BUN_VERSION="$(bun --version)" \
    bun /tmp/orkestrator-manifest/docker/image-manifest.ts generate \
      --out /usr/local/share/orkestrator/image-manifest.json \
 && chmod 0644 /usr/local/share/orkestrator/image-manifest.json \
 && rm -rf /tmp/orkestrator-manifest

USER node

# Default terminal settings
ENV TERM=xterm-256color

# Entrypoint and default command
ENTRYPOINT ["/usr/bin/sudo", "/usr/local/bin/network-policy-entrypoint.sh"]
CMD ["/bin/zsh"]
