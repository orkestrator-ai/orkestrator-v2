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

# Install a real Node.js 20 runtime. bun runs our bridge servers, but the agent
# CLIs — especially `claude`, which is a Node app launched directly in container
# terminals — need genuine Node (not bun's node shim). This also provides npm
# for the global CLI installs below. /usr/local/bin precedes the bun-node
# fallback on PATH, so this node takes precedence.
ARG NODE_VERSION=20.18.0
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
RUN mkdir -p /workspace /home/node/.claude /home/node/.codex /home/node/.config/opencode /home/node/.local/share/opencode /home/node/.local/state/opencode && \
  chown -R node:node /workspace /home/node/.claude /home/node/.codex /home/node/.config /home/node/.local

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

# Keep these in sync with the pinned SDK versions. tests/unit/version-drift.test.ts enforces Codex/OpenCode.
#   CODEX_CLI_VERSION     ↔ @openai/codex-sdk in bridges/codex-bridge/package.json (and scripts/download-codex.sh)
#   OPENCODE_CLI_VERSION  ↔ @opencode-ai/sdk in package.json (and scripts/download-opencode.sh)
# Claude CLI has its own release train distinct from @anthropic-ai/claude-agent-sdk.
ARG CLAUDE_CLI_VERSION=2.1.207
ARG CODEX_CLI_VERSION=0.144.1
ARG OPENCODE_CLI_VERSION=1.17.18

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

# Copy and build Claude Bridge Server
COPY --chown=node:node bridges/claude-bridge /opt/claude-bridge
WORKDIR /opt/claude-bridge
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
RUN bun install \
 && bun run build \
 && rm -rf node_modules \
 && rm -rf dist/node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl

# Copy and build Codex Bridge Server. Its build bundles every dependency into
# dist/index.js (nothing is kept external), so node_modules is build-only and is
# removed entirely after the build.
COPY --chown=node:node bridges/codex-bridge /opt/codex-bridge
WORKDIR /opt/codex-bridge
RUN bun install \
 && bun run build \
 && rm -rf node_modules
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
