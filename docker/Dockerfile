# Bun is the primary runtime: it builds and runs the bridge servers. The
# `-debian` variant is glibc-based (Debian), which keeps the musl-delete logic
# for the Claude Agent SDK below valid. (An Alpine/musl base would invert it.)
FROM oven/bun:1.3.14-debian

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

# Keep these in sync with the repository pins. tests/unit/version-drift.test.ts enforces Codex/OpenCode.
#   CODEX_CLI_VERSION     ↔ config/codex-version.json and the generated app-server protocol (and scripts/download-codex.sh)
#   OPENCODE_CLI_VERSION  ↔ @opencode-ai/sdk in apps/web/package.json and apps/backend/package.json (and scripts/download-opencode.sh)
# Claude CLI has its own release train distinct from @anthropic-ai/claude-agent-sdk.
ARG CLAUDE_CLI_VERSION=2.1.228
ARG CODEX_CLI_VERSION=0.147.0
ARG OPENCODE_CLI_VERSION=1.18.16
ARG CURSOR_AGENT_VERSION=2026.08.11-e8db854
ARG GROK_BUILD_VERSION=1.0.3
ARG PI_CLI_VERSION=0.84.3

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

# Cursor Agent ships as a self-contained bundle; its launcher expects the
# adjacent Node runtime and JS payload, so retain the bundle intact. Grok Build
# is a single native executable. Both downloads are pinned and hash verified.
USER root
RUN ARCH="$(dpkg --print-architecture)" && \
  case "$ARCH" in \
    amd64) CURSOR_ARCH=x64; CURSOR_SHA=bfff4bf6f4e9dd30c1d0ef0a70b6077b074015dd2948e4c50685d53afdcfce5a; GROK_ARCH=x86_64; GROK_SHA=2a7d46dea3fbed067e4072258b835d401e017d6848dc996279f0fb3d668a0961 ;; \
    arm64) CURSOR_ARCH=arm64; CURSOR_SHA=ea13f92e295f523a99ce8d8f57d6894d21e5d1e2d030ffad718ccd5955ca2eed; GROK_ARCH=aarch64; GROK_SHA=ed44950eab90573b6f475191f5791713a56943939b3b9a62e3f4e95edd14acd9 ;; \
    *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; \
  esac && \
  curl -fsSL "https://downloads.cursor.com/lab/${CURSOR_AGENT_VERSION}/linux/${CURSOR_ARCH}/agent-cli-package.tar.gz" -o /tmp/cursor-agent.tar.gz && \
  printf '%s  %s\n' "$CURSOR_SHA" /tmp/cursor-agent.tar.gz | sha256sum -c - && \
  mkdir -p /opt/cursor-agent && \
  tar -xzf /tmp/cursor-agent.tar.gz -C /opt/cursor-agent --strip-components=1 --no-same-owner && \
  ln -s /opt/cursor-agent/cursor-agent /usr/local/bin/cursor && \
  ln -s /opt/cursor-agent/cursor-agent /usr/local/bin/cursor-agent && \
  curl -fsSL "https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-${GROK_BUILD_VERSION}-linux-${GROK_ARCH}" -o /usr/local/bin/grok && \
  printf '%s  %s\n' "$GROK_SHA" /usr/local/bin/grok | sha256sum -c - && \
  chmod 755 /usr/local/bin/grok /opt/cursor-agent/cursor-agent && \
  rm -f /tmp/cursor-agent.tar.gz

# Pi ships as a self-contained bundle: the launcher loads its themes, docs,
# examples and a native helper module from beside itself, so the tree is kept
# intact rather than reduced to a single binary. Pinned and hash verified like
# the two above; the digests match the ones in
# apps/desktop/electron/toolchain-manifest.ts for the same version.
RUN ARCH="$(dpkg --print-architecture)" && \
  case "$ARCH" in \
    amd64) PI_ARCH=x64; PI_SHA=6f8bb67c21bc6b8a8a106d354f56d7fd4a190a3cd8ad3a32db45f6d281a5d008 ;; \
    arm64) PI_ARCH=arm64; PI_SHA=e7cd48cd6f64b708e8459a890882b1007332f6e6b876fe1fd5c5203abd0addb7 ;; \
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
 && cursor-agent --version \
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
WORKDIR /opt/bridge-build
RUN bun install --filter claude-bridge --filter codex-bridge --filter acp-bridge --filter pi-bridge

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
# Verified in oven/bun:1.3.14-debian: bridge boots and /global/health returns 200,
# resolving the gnu binary.
RUN bun run build \
 && rm -rf node_modules \
 && rm -rf dist/node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl

# Build Codex Bridge Server. Its build bundles every dependency into
# dist/index.js (nothing is kept external), so node_modules is build-only and is
# removed entirely after the build.
WORKDIR /opt/bridge-build/bridges/codex-bridge
RUN bun run build \
 && rm -rf node_modules

# Build the shared ACP HTTP bridge used by Cursor Agent and Grok Build.
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

# Preserve the runtime paths expected by the backend, then remove the temporary
# workspace metadata and shared install.
USER root
RUN mv /opt/bridge-build/bridges/claude-bridge /opt/claude-bridge \
 && mv /opt/bridge-build/bridges/codex-bridge /opt/codex-bridge \
 && mv /opt/bridge-build/bridges/acp-bridge /opt/acp-bridge \
 && mv /opt/bridge-build/bridges/pi-bridge /opt/pi-bridge \
 && rm -rf /opt/bridge-build
USER node
WORKDIR /workspace

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
