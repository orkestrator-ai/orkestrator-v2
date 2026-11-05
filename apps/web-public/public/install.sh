#!/usr/bin/env bash
set -euo pipefail

# The release this script runs: the newest Stable release when the site was last
# deployed. `mise run release:pin-installer` stamps it after each Stable release.
PINNED_RELEASE="2.36.1"

# Beta and Unstable users pick their own, as an npm tag or a version:
#   curl -fsSL https://orkestrator.dev/install.sh | ORKESTRATOR_INSTALL_VERSION=alpha bash
SPEC="${ORKESTRATOR_INSTALL_VERSION:-${PINNED_RELEASE}}"
PACKAGE="orkestrator@${SPEC}"

# The Bun this script installs when the host has none: the version `mise.toml`
# pins, and the SHA-256 of each archive that Bun release publishes (its
# SHASUMS256.txt). tests/unit/version-drift.test.ts keeps them in step with
# mise.toml and scripts/download-bun.sh.
PINNED_BUN="1.4.4"
BUN_SHA256_DARWIN_AARCH64="c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510"
BUN_SHA256_DARWIN_X64="50a3491f73abc2fe81673171a85762d3bc2cc1680ccecadd983de99adf77977e"
BUN_SHA256_DARWIN_X64_BASELINE="d4a155adfbfd09155eb3ba05c9e3a544f39297d7a68616d3c7759f67ab5c47dc"
BUN_SHA256_LINUX_AARCH64="baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e"
BUN_SHA256_LINUX_AARCH64_MUSL="57f01b02ac7113c61c935f28f38c2eab849e3c970dab21f8b640a87b1ef65009"
BUN_SHA256_LINUX_X64="bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c"
BUN_SHA256_LINUX_X64_BASELINE="e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76"
BUN_SHA256_LINUX_X64_MUSL="a5a8ccc5e74dcb883fe974f125a7bdb3b41e5195ed1b870e73f17effd3eb2b2d"
BUN_SHA256_LINUX_X64_MUSL_BASELINE="6e9c37098b293920aed28bfb51ab240e26d23bfdd9bbfecb3ad428ac166549bc"

# Everything below runs from `main` on the last line, so a download cut short
# runs nothing. Keep it to bash 3.2, the bash macOS ships.

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

# The archive Bun's own installer would choose for this host.
bun_target() {
  local target cpu
  case "$(uname -s) $(uname -m)" in
    "Darwin x86_64")
      target="darwin-x64"
      # A shell under Rosetta 2 reports x86_64 on Apple Silicon.
      if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = "1" ]; then
        target="darwin-aarch64"
      fi
      ;;
    "Darwin arm64" | "Darwin aarch64") target="darwin-aarch64" ;;
    "Linux aarch64" | "Linux arm64") target="linux-aarch64" ;;
    "Linux x86_64" | "Linux amd64") target="linux-x64" ;;
    *) return 1 ;;
  esac
  case "${target}" in
    linux-*)
      if [ -f /etc/alpine-release ]; then
        target="${target}-musl"
      fi
      ;;
  esac
  # Without AVX2 the default x64 build stops on an illegal instruction.
  case "${target}" in
    darwin-x64)
      cpu="$(sysctl -n machdep.cpu.features machdep.cpu.leaf7_features 2>/dev/null || true)"
      case "${cpu}" in
        *AVX2*) ;;
        *) target="${target}-baseline" ;;
      esac
      ;;
    linux-x64*)
      cpu=""
      if [ -r /proc/cpuinfo ]; then
        cpu="$(< /proc/cpuinfo)"
      fi
      case "${cpu}" in
        *avx2*) ;;
        *) target="${target}-baseline" ;;
      esac
      ;;
  esac
  printf '%s\n' "${target}"
}

bun_sha256() {
  case "$1" in
    darwin-aarch64) printf '%s\n' "${BUN_SHA256_DARWIN_AARCH64}" ;;
    darwin-x64) printf '%s\n' "${BUN_SHA256_DARWIN_X64}" ;;
    darwin-x64-baseline) printf '%s\n' "${BUN_SHA256_DARWIN_X64_BASELINE}" ;;
    linux-aarch64) printf '%s\n' "${BUN_SHA256_LINUX_AARCH64}" ;;
    linux-aarch64-musl) printf '%s\n' "${BUN_SHA256_LINUX_AARCH64_MUSL}" ;;
    linux-x64) printf '%s\n' "${BUN_SHA256_LINUX_X64}" ;;
    linux-x64-baseline) printf '%s\n' "${BUN_SHA256_LINUX_X64_BASELINE}" ;;
    linux-x64-musl) printf '%s\n' "${BUN_SHA256_LINUX_X64_MUSL}" ;;
    linux-x64-musl-baseline) printf '%s\n' "${BUN_SHA256_LINUX_X64_MUSL_BASELINE}" ;;
    *) return 1 ;;
  esac
}

sha256_of() {
  local output
  if command -v sha256sum >/dev/null 2>&1; then
    output="$(sha256sum "$1")"
  elif command -v shasum >/dev/null 2>&1; then
    output="$(shasum -a 256 "$1")"
  else
    return 1
  fi
  printf '%s\n' "${output%% *}"
}

# Installs the pinned Bun into $1 from its release archive, refusing any archive
# whose SHA-256 is not the one stated above. Nothing reaches $1 unless it matched
# and reports the pinned version.
install_bun() {
  local directory="$1" target expected archive actual unpacked staged version url
  target="$(bun_target)" || fail "Bun publishes no build for $(uname -s) $(uname -m)."
  expected="$(bun_sha256 "${target}")" || fail "No SHA-256 is stated for bun-${target}."
  command -v unzip >/dev/null 2>&1 || fail "unzip is required to install Bun."

  url="https://github.com/oven-sh/bun/releases/download/bun-v${PINNED_BUN}/bun-${target}.zip"
  archive="${WORK}/bun-${target}.zip"
  printf 'Bun was not found; installing Bun %s (bun-%s) into %s.\n' \
    "${PINNED_BUN}" "${target}" "${directory}" >&2
  curl -fsSL --proto '=https' --tlsv1.2 -o "${archive}" "${url}" ||
    fail "Could not download ${url}."
  actual="$(sha256_of "${archive}")" ||
    fail "sha256sum or shasum is required to check the Bun download."
  if [ "${actual}" != "${expected}" ]; then
    fail "The Bun download does not match its stated SHA-256 (expected ${expected}, got ${actual}); nothing was installed."
  fi

  unpacked="${WORK}/bun-archive"
  unzip -oq "${archive}" -d "${unpacked}"
  [ -f "${unpacked}/bun-${target}/bun" ] || fail "The Bun archive has no bun-${target}/bun."
  mkdir -p "${directory}"
  staged="${directory}/.bun-install.$$"
  cp "${unpacked}/bun-${target}/bun" "${staged}"
  chmod 755 "${staged}"
  version="$("${staged}" --version 2>/dev/null || true)"
  if [ "${version}" != "${PINNED_BUN}" ]; then
    rm -f "${staged}"
    fail "The downloaded Bun reports version '${version}', not ${PINNED_BUN}; nothing was installed."
  fi
  mv -f "${staged}" "${directory}/bun"
  ln -sf bun "${directory}/bunx"
  printf 'Installed Bun %s. Add %s to PATH to run bun yourself.\n' "${PINNED_BUN}" "${directory}" >&2
}

# Removes $2 once process $1 has exited. The CLI replaces this script's process,
# so nothing else is left to clean up after it.
remove_after_exit() {
  (
    trap '' HUP INT TERM
    while kill -0 "$1" 2>/dev/null; do
      sleep 1
    done
    rm -rf "$2"
  ) </dev/null >/dev/null 2>&1 &
}

main() {
  case "$(uname -s)" in
    Darwin | Linux) ;;
    *) fail "Orkestrator supports macOS and Linux only." ;;
  esac

  case "${SPEC}" in
    "" | [!A-Za-z0-9]* | *[!A-Za-z0-9._+-]*)
      fail "ORKESTRATOR_INSTALL_VERSION must be an npm tag or a version, not '${SPEC}'."
      ;;
  esac

  WORK="$(mktemp -d "${TMPDIR:-/tmp}/orkestrator-install.XXXXXX")"
  trap 'rm -rf "${WORK}"' EXIT

  local bun_directory="${BUN_INSTALL:-${HOME}/.bun}/bin" bun
  if bun="$(command -v bun 2>/dev/null)"; then
    :
  elif [ -x "${bun_directory}/bun" ]; then
    bun="${bun_directory}/bun"
  else
    install_bun "${bun_directory}"
    bun="${bun_directory}/bun"
  fi
  if [ "${bun}" = "${bun_directory}/bun" ]; then
    # So the CLI, and anything it starts by name, finds the same Bun.
    PATH="${bun_directory}:${PATH}"
    export PATH
  fi

  # What the standalone service does for an update (`installRelease`): the first
  # install exists only to fetch the package. It resolves dependencies afresh,
  # so it runs no scripts and everything but the package is discarded. A frozen
  # install of the lockfile the release publishes then supplies the
  # dependencies. Each install has its own fresh cache.
  local fetch="${WORK}/fetch" release="${WORK}/release" package runtime entry
  mkdir -p "${fetch}"
  printf '{"name":"orkestrator-install","private":true,"dependencies":{"orkestrator":"%s"}}\n' \
    "${SPEC}" >"${fetch}/package.json"
  printf 'Fetching %s…\n' "${PACKAGE}" >&2
  (
    cd "${fetch}"
    BUN_INSTALL_CACHE_DIR="${fetch}/.cache" "${bun}" install --production --linker=hoisted \
      --ignore-scripts --cache-dir "${fetch}/.cache" --no-progress
  ) >&2 || fail "Could not fetch ${PACKAGE}."
  package="${fetch}/node_modules/orkestrator"
  runtime="${package}/resources/release-runtime"
  [ -f "${package}/package.json" ] || fail "Fetching ${PACKAGE} produced no package."

  if [ ! -d "${runtime}" ]; then
    # A release older than the published lockfile runs as it always did.
    rm -rf "${WORK}"
    trap - EXIT
    exec "${bun}" x "${PACKAGE}" "$@"
  fi

  # `--frozen-lockfile` only freezes a lockfile that exists; without one Bun
  # would resolve afresh, so a runtime that lost it is refused.
  [ -f "${runtime}/bun.lock" ] || fail "${PACKAGE} publishes no bun.lock; refusing to resolve its dependencies afresh."
  mkdir -p "${release}"
  cp "${runtime}/package.json" "${runtime}/bun.lock" "${release}/"
  printf 'Installing the dependencies %s was published with…\n' "${PACKAGE}" >&2
  (
    cd "${release}"
    BUN_INSTALL_CACHE_DIR="${release}/.cache" "${bun}" install --frozen-lockfile \
      --cache-dir "${release}/.cache" --production --linker=hoisted --ignore-scripts --no-progress
  ) >&2 || fail "Could not install the locked dependencies of ${PACKAGE}."
  rm -rf "${package}/node_modules"
  mkdir -p "${release}/node_modules"
  mv "${package}" "${release}/node_modules/orkestrator"
  rm -rf "${fetch}" "${release}/.cache"
  entry="${release}/node_modules/orkestrator/bin/orkestrator.js"
  [ -f "${entry}" ] || fail "${PACKAGE} has no bin/orkestrator.js."

  # The CLI takes over this process, keeping its signals and terminal.
  trap - EXIT
  remove_after_exit "$$" "${WORK}"
  exec "${bun}" "${entry}" "$@"
}

main "$@"
