#!/usr/bin/env bash
set -euo pipefail

# The release this script runs: the newest Stable release when the site was last
# deployed. `mise run release:pin-installer` stamps it after each Stable release.
PINNED_RELEASE="2.36.1"

# Beta and Unstable users pick their own, as an npm tag or a version:
#   curl -fsSL https://orkestrator.dev/install.sh | ORKESTRATOR_INSTALL_VERSION=alpha bash
PACKAGE="orkestrator@${ORKESTRATOR_INSTALL_VERSION:-${PINNED_RELEASE}}"

case "$(uname -s)" in
  Darwin|Linux) ;;
  *)
    printf 'Orkestrator supports macOS and Linux only.\n' >&2
    exit 1
    ;;
esac

if command -v bunx >/dev/null 2>&1; then
  exec "$(command -v bunx)" "${PACKAGE}" "$@"
fi

if command -v bun >/dev/null 2>&1; then
  exec "$(command -v bun)" x "${PACKAGE}" "$@"
fi

printf 'Bun was not found; installing it now.\n' >&2
curl -fsSL https://bun.com/install | bash

BUN_DIRECTORY="${BUN_INSTALL:-${HOME}/.bun}/bin"
if [ -x "${BUN_DIRECTORY}/bunx" ]; then
  exec "${BUN_DIRECTORY}/bunx" "${PACKAGE}" "$@"
fi
if [ -x "${BUN_DIRECTORY}/bun" ]; then
  exec "${BUN_DIRECTORY}/bun" x "${PACKAGE}" "$@"
fi

printf 'Bun installation completed, but its executable was not found in %s.\n' "${BUN_DIRECTORY}" >&2
exit 1
