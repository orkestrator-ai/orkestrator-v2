# Bun is the primary runtime: it builds and runs the bridge servers. The
# `-debian` variant is glibc-based (Debian), which keeps the musl-delete logic
# for the Claude Agent SDK below valid. (An Alpine/musl base would invert it.)
FROM oven/bun:1.4.0-debian

ARG TZ
ENV TZ="$TZ"

# Install basic development tools and iptables/ipset. curl/wget/xz-utils/
# ca-certificates are not present in the bun base image (the node base bundled
# them) and are needed by the tool installers below.
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
  iproute2 \
  dnsutils \
  aggregate \
  jq \
  nano \
  vim \
  tmux \
  locales \
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
ARG NODE_VERSION=24.11.0
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

# Ensure default node user has access to /usr/local/share
RUN mkdir -p /usr/local/share/npm-global && \
  chown -R node:node /usr/local/share

ARG USERNAME=node

# Persist bash history.
RUN SNIPPET="export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
  && mkdir /commandhistory \
  && touch /commandhistory/.bash_history \
  && chown -R $USERNAME /commandhistory

# Set `DEVCONTAINER` environment variable to help with orientation
ENV DEVCONTAINER=true

# Create workspace and config directories and set permissions
RUN mkdir -p /workspace /opencode-state /home/node/.claude /home/node/.codex /home/node/.cursor /home/node/.grok /home/node/.pi/agent /home/node/.config/opencode /home/node/.config/grok /home/node/.local/share/opencode /home/node/.local/state/opencode && \
  chown -R node:node /workspace /home/node/.claude /home/node/.codex /home/node/.cursor /home/node/.grok /home/node/.pi /home/node/.config /home/node/.local

WORKDIR /workspace

ARG GIT_DELTA_VERSION=0.18.2
RUN ARCH=$(dpkg --print-architecture) && \
  wget "https://github.com/dandavison/delta/releases/download/${GIT_DELTA_VERSION}/git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  sudo dpkg -i "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  rm "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb"

# Set up non-root user
USER node

# Install global packages
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin

# Set the default shell to zsh rather than sh
ENV SHELL=/bin/zsh

# Set the default editor and visual
ENV EDITOR=nano
ENV VISUAL=nano

# Default powerline10k theme
ARG ZSH_IN_DOCKER_VERSION=1.2.0
RUN sh -c "$(wget -O- https://github.com/deluan/zsh-in-docker/releases/download/v${ZSH_IN_DOCKER_VERSION}/zsh-in-docker.sh)" -- \
  -p git \
  -p fzf \
  -a "source /usr/share/doc/fzf/examples/key-bindings.zsh" \
  -a "source /usr/share/doc/fzf/examples/completion.zsh" \
  -a "export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
  -x

# Every version below must equal PINNED_TOOLCHAIN_VERSIONS in
# apps/desktop/electron/toolchain-manifest.ts, and the SHA literals further down
# must equal that manifest's linux digests. The image cannot read the manifest,
# so these are a second copy; `every shipped agent, uniformly` in
# tests/unit/version-drift.test.ts is what stops the two drifting.
#   CODEX_CLI_VERSION     ↔ config/codex-version.json and the generated app-server protocol
#   OPENCODE_CLI_VERSION  ↔ @opencode-ai/sdk in apps/web/package.json and apps/backend/package.json
#   PI_CLI_VERSION        ↔ the four @earendil-works/pi-* pins in bridges/pi-bridge/package.json
# Claude CLI has its own release train, distinct from
# @anthropic-ai/claude-agent-sdk.
ARG CLAUDE_CLI_VERSION=2.1.261
ARG CODEX_CLI_VERSION=0.153.3
ARG OPENCODE_CLI_VERSION=1.18.28
ARG GROK_BUILD_VERSION=1.0.13
ARG PI_CLI_VERSION=0.85.0

# Install Claude Code from the pinned npm package. The package pulls in the
# platform-native binary via optional dependencies.
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}"
ENV CLAUDE_CLI_PATH=/usr/local/share/npm-global/bin/claude

# Install OpenCode
RUN curl -fsSL https://opencode.ai/install | bash -s -- --version "$OPENCODE_CLI_VERSION"
ENV OPENCODE_CLI_PATH=/home/node/.opencode/bin/opencode

# Install Codex CLI
RUN npm install -g "@openai/codex@${CODEX_CLI_VERSION}"
ENV CODEX_CLI_PATH=/usr/local/share/npm-global/bin/codex
ENV PATH="/usr/local/share/npm-global/bin:/home/node/.opencode/bin:$PATH"

# Grok Build is a single native executable. The download is pinned and hash
# verified.
USER root
RUN ARCH="$(dpkg --print-architecture)" && \
  case "$ARCH" in \
    amd64) GROK_ARCH=x86_64; GROK_SHA=edf79521581bb5e6b95abef848491a6a742e860da3e237ebe86a280d30dce4c1 ;; \
    arm64) GROK_ARCH=aarch64; GROK_SHA=b926fc5308374396e260e7efbd6107231a8dae13c084ddaf0fe89b7ebb3edd25 ;; \
    *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; \
  esac && \
  curl -fsSL "https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-${GROK_BUILD_VERSION}-linux-${GROK_ARCH}" -o /usr/local/bin/grok && \
  printf '%s  %s\n' "$GROK_SHA" /usr/local/bin/grok | sha256sum -c - && \
  chmod 755 /usr/local/bin/grok

# Pi ships as a self-contained bundle: the launcher loads its themes, docs,
# examples and a native helper module from beside itself, so the tree is kept
# intact rather than reduced to a single binary. Pinned and hash verified like
# the two above; the digests match the ones in
# apps/desktop/electron/toolchain-manifest.ts for the same version.
RUN ARCH="$(dpkg --print-architecture)" && \
  case "$ARCH" in \
    amd64) PI_ARCH=x64; PI_SHA=a7e7c65f1dc528d2e17e7d946ad2b61df0e2b0f9952faee77807c2484b464d6e ;; \
    arm64) PI_ARCH=arm64; PI_SHA=821750e0ac6bf6e10c35b93ddab88a44f2d0ef8411af9ea4e8ffe620f62130df ;; \
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
ARG PLAYWRIGHT_VERSION=1.61.1
# One shared browser root, readable by `node` and by the uid-0 `orkroot` used for
# root terminals, instead of a per-user ~/.cache/ms-playwright copy.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm install -g "playwright@${PLAYWRIGHT_VERSION}"
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

# Build both bridge servers from a filtered monorepo install. They import the
# shared @orkestrator/protocol workspace package, so copying either bridge as a
# standalone package leaves its `workspace:*` dependency impossible to resolve.
COPY --chown=node:node package.json bun.lock /opt/bridge-build/
COPY --chown=node:node packages/protocol /opt/bridge-build/packages/protocol
COPY --chown=node:node bridges/claude-bridge /opt/bridge-build/bridges/claude-bridge
COPY --chown=node:node bridges/codex-bridge /opt/bridge-build/bridges/codex-bridge
COPY --chown=node:node bridges/acp-bridge /opt/bridge-build/bridges/acp-bridge
COPY --chown=node:node bridges/pi-bridge /opt/bridge-build/bridges/pi-bridge
COPY --chown=node:node bridges/cursor-bridge /opt/bridge-build/bridges/cursor-bridge
WORKDIR /opt/bridge-build
RUN bun install --filter claude-bridge --filter codex-bridge --filter acp-bridge \
      --filter pi-bridge --filter cursor-bridge

# Build Claude Bridge Server.
WORKDIR /opt/bridge-build/bridges/claude-bridge
# The build bundles src into dist/index.js and the `vendor` step copies the
# Claude Agent SDK (which is kept external) into dist/node_modules — so the top-
# level node_modules is build-only and is discarded afterward. The SDK selects
# its native binary at runtime by libc: on this glibc base bun reports
# glibcVersionRuntime, so the SDK tries the `-linux-<arch>` (gnu) variant first.
# We strip the unused `-musl` variant from the vendored tree (the path actually
# resolved at runtime — the old top-level rm never touched it) to make resolution
# unambiguous and drop ~225MB of dead weight. If switching to an Alpine/musl
# base, keep musl and strip gnu instead.
# Verified in oven/bun:1.4.0-debian (linux/arm64): the bridge boots, /global/health
# returns 200, and the SDK resolves the gnu binary from dist/node_modules with no
# musl variant and no top-level node_modules left behind.
RUN bun run build \
 && rm -rf node_modules \
 && rm -rf dist/node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl

# Build Codex Bridge Server. Its build bundles every dependency into
# dist/index.js (nothing is kept external), so node_modules is build-only and is
# removed entirely after the build.
WORKDIR /opt/bridge-build/bridges/codex-bridge
RUN bun run build \
 && rm -rf node_modules

# Build the ACP HTTP bridge used by Grok Build.
WORKDIR /opt/bridge-build/bridges/acp-bridge
RUN bun run build \
 && rm -rf node_modules

# Build the Pi bridge. Like the Claude bridge, its `vendor` step copies the SDK
# into dist/node_modules because the SDK compiles extension TypeScript with jiti
# and reads its themes and templates from files inside the package — neither of
# which a bundler can follow. The top-level node_modules is build-only.
WORKDIR /opt/bridge-build/bridges/pi-bridge
RUN bun run build \
 && rm -rf node_modules

# Build the Cursor SDK bridge. Its build bundles @cursor/sdk's JavaScript into
# dist/index.js and
# the `vendor` step stages the SDK's Linux platform package — ripgrep, the
# sandbox helper and the tree-sitter grammars, which cannot be bundled — into
# dist/node_modules, where the SDK's runtime lookup walks up from dist/index.js
# to find it. The top-level node_modules is therefore build-only.
WORKDIR /opt/bridge-build/bridges/cursor-bridge
RUN bun run build \
 && rm -rf node_modules

# Preserve the runtime paths expected by the backend, then remove the temporary
# workspace metadata and shared install.
USER root
RUN mv /opt/bridge-build/bridges/claude-bridge /opt/claude-bridge \
 && mv /opt/bridge-build/bridges/codex-bridge /opt/codex-bridge \
 && mv /opt/bridge-build/bridges/acp-bridge /opt/acp-bridge \
 && mv /opt/bridge-build/bridges/pi-bridge /opt/pi-bridge \
 && mv /opt/bridge-build/bridges/cursor-bridge /opt/cursor-bridge \
 && rm -rf /opt/bridge-build

# Install mise after the expensive CLI, browser and bridge-build layers so a
# mise-only version bump does not invalidate them. Host installations cannot be
# reused here: their binaries target macOS and the container runs Linux. Keep
# both supported image architectures pinned to config/mise-version.json.
ARG MISE_VERSION=2026.9.1
RUN ARCH="$(dpkg --print-architecture)" && \
  case "$ARCH" in \
    amd64) MISE_ARCH=x64; MISE_SHA=063dda9149ab6be53da877c2d176afe0eac68e64cf8ca295bd0528720701c65d ;; \
    arm64) MISE_ARCH=arm64; MISE_SHA=98d2ea7b82dd966afdb8a9f4e9edbca771acf2a30d2842bfc0efdb7b61c886a3 ;; \
    *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; \
  esac && \
  MISE_TARBALL="mise-v${MISE_VERSION}-linux-${MISE_ARCH}.tar.gz" && \
  curl -fsSL "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/${MISE_TARBALL}" -o "/tmp/${MISE_TARBALL}" && \
  printf '%s  %s\n' "$MISE_SHA" "/tmp/${MISE_TARBALL}" | sha256sum -c - && \
  mkdir -p /opt/mise && \
  tar -xzf "/tmp/${MISE_TARBALL}" -C /opt/mise --strip-components=1 --no-same-owner && \
  ln -s /opt/mise/bin/mise /usr/local/bin/mise && \
  chmod 755 /opt/mise/bin/mise && \
  printf '%s\n' 'eval "$(/usr/local/bin/mise activate zsh)"' >> /home/node/.zshrc && \
  chown node:node /home/node/.zshrc && \
  rm -f "/tmp/${MISE_TARBALL}" && \
  mise --version

# Repository-controlled setup commands already execute inside this isolated
# workspace, so its mise configuration follows the same trust boundary. Disable
# self-update hints because the image pin, not mise, owns binary upgrades.
ENV MISE_TRUSTED_CONFIG_PATHS=/workspace
ENV MISE_SELF_UPDATE_AVAILABLE=false
USER node
WORKDIR /workspace
RUN printf '%s\n' '[env]' 'ORKESTRATOR_MISE_TRUST_SMOKE = "trusted"' > mise.toml \
 && zsh -ic 'command -v mise >/dev/null && typeset -f _mise_hook >/dev/null && test "$ORKESTRATOR_MISE_TRUST_SMOKE" = trusted && mise --version' \
 && rm mise.toml

# Copy and set up firewall scripts
COPY docker/init-firewall.sh docker/update-firewall.sh /usr/local/bin/
USER root
RUN chmod +x /usr/local/bin/init-firewall.sh /usr/local/bin/update-firewall.sh && \
  echo "node ALL=(root) NOPASSWD:SETENV: /usr/local/bin/init-firewall.sh, /usr/local/bin/update-firewall.sh" > /etc/sudoers.d/node-firewall && \
  chmod 0440 /etc/sudoers.d/node-firewall

# Create orkroot user with UID 0 (root-equivalent) for root terminal sessions
# -o allows non-unique UID, -u 0 -g 0 makes user root-equivalent
RUN useradd -o -u 0 -g 0 -M -d /root -s /bin/zsh orkroot && \
  echo "node ALL=(orkroot) NOPASSWD:SETENV: ALL" > /etc/sudoers.d/node-orkroot && \
  chmod 0440 /etc/sudoers.d/node-orkroot

# Configure SSH for GitHub/GitLab/Bitbucket
RUN mkdir -p /home/node/.ssh && \
  ssh-keyscan github.com >> /home/node/.ssh/known_hosts && \
  ssh-keyscan gitlab.com >> /home/node/.ssh/known_hosts && \
  ssh-keyscan bitbucket.org >> /home/node/.ssh/known_hosts && \
  chown -R node:node /home/node/.ssh && \
  chmod 700 /home/node/.ssh

# Copy entrypoint and workspace setup scripts
COPY docker/entrypoint.sh /usr/local/bin/
COPY docker/workspace-setup.sh /usr/local/bin/
COPY docker/git-branch-helpers.sh /usr/local/bin/
COPY docker/runtime-env.sh /usr/local/bin/orkestrator-runtime-env.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh /usr/local/bin/workspace-setup.sh /usr/local/bin/git-branch-helpers.sh /usr/local/bin/orkestrator-runtime-env.sh

USER node

# Default terminal settings
ENV TERM=xterm-256color

# Entrypoint and default command
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["/bin/zsh"]
