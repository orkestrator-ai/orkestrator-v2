#!/usr/bin/env bash
set -euo pipefail

case "$(uname -s)" in
  Darwin|Linux) ;;
  *)
    printf 'Orkestrator supports macOS and Linux only.\n' >&2
    exit 1
    ;;
esac

if command -v bunx >/dev/null 2>&1; then
  exec "$(command -v bunx)" orkestrator "$@"
fi

if command -v bun >/dev/null 2>&1; then
  exec "$(command -v bun)" x orkestrator "$@"
fi

printf 'Bun was not found; installing it now.\n' >&2
curl -fsSL https://bun.com/install | bash

BUN_DIRECTORY="${BUN_INSTALL:-${HOME}/.bun}/bin"
if [ -x "${BUN_DIRECTORY}/bunx" ]; then
  exec "${BUN_DIRECTORY}/bunx" orkestrator "$@"
fi
if [ -x "${BUN_DIRECTORY}/bun" ]; then
  exec "${BUN_DIRECTORY}/bun" x orkestrator "$@"
fi

printf 'Bun installation completed, but its executable was not found in %s.\n' "${BUN_DIRECTORY}" >&2
exit 1
