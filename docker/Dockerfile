FROM node:20

ARG TZ
ENV TZ="$TZ"

# Install basic development tools and iptables/ipset
RUN apt-get update && apt-get install -y --no-install-recommends \
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
  locales \
  && apt-get clean && rm -rf /var/lib/apt/lists/* \
  && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen

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
# Claude CLI has its own release train distinct from @anthropic-ai/claude-agent-sdk, so it tracks a tag.
ARG CLAUDE_CLI_VERSION=latest
ARG CODEX_CLI_VERSION=0.124.0
ARG OPENCODE_CLI_VERSION=1.14.22

# Install Claude using native installer
RUN curl -fsSL https://claude.ai/install.sh | bash -s "$CLAUDE_CLI_VERSION"
ENV PATH="/home/node/.local/bin:$PATH"
RUN claude install

# Install OpenCode
RUN curl -fsSL https://opencode.ai/install | bash -s -- --version "$OPENCODE_CLI_VERSION"

# Install Codex CLI
RUN npm install -g "@openai/codex@${CODEX_CLI_VERSION}"

# Copy and build Claude Bridge Server
COPY --chown=node:node bridges/claude-bridge /opt/claude-bridge
WORKDIR /opt/claude-bridge
# Delete musl variants so the SDK picks the glibc binary matching our Debian base.
# The SDK prefers musl first on Linux, but node:20 is glibc — without this, spawns fail
# with "Claude Code native binary not found". If switching to an Alpine/musl base, invert.
# The rm MUST come after `npm prune --production`: prune reconciles against the lockfile
# and re-installs deleted optional deps, undoing an earlier rm.
RUN npm install \
 && npm run build \
 && npm prune --production \
 && rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl

# Copy and build Codex Bridge Server
COPY --chown=node:node bridges/codex-bridge /opt/codex-bridge
WORKDIR /opt/codex-bridge
RUN npm install \
 && npm run build \
 && npm prune --production
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
