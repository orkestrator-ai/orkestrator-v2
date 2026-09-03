#!/bin/sh
# Shared runtime environment helpers for Orkestrator containers.
#
# User setup scripts often install tools into per-user directories and update
# shell startup files. Native agent servers are launched later by non-interactive
# docker exec commands, so they need a persisted PATH snapshot from setup time.

ORKESTRATOR_RUNTIME_ENV_FILE="${ORKESTRATOR_RUNTIME_ENV_FILE:-/tmp/orkestrator-ai/runtime-env.sh}"
ORKESTRATOR_BASH_ENV_FILE="${ORKESTRATOR_BASH_ENV_FILE:-/tmp/orkestrator-ai/bash-env.sh}"
ORKESTRATOR_GITHUB_CREDENTIAL_FILE="${ORKESTRATOR_GITHUB_CREDENTIAL_FILE:-/tmp/orkestrator-ai/github-token}"

orkestrator_prepend_path() {
    if [ -z "${1:-}" ] || [ ! -d "$1" ]; then
        return 0
    fi

    case ":${PATH:-}:" in
        *":$1:"*) ;;
        *) PATH="$1${PATH:+:$PATH}" ;;
    esac
}

orkestrator_append_path() {
    if [ -z "${1:-}" ] || [ ! -d "$1" ]; then
        return 0
    fi

    case ":${PATH:-}:" in
        *":$1:"*) ;;
        *) PATH="${PATH:+$PATH:}$1" ;;
    esac
}

orkestrator_mise_shims_dir() {
    if [ -n "${MISE_SHIMS_DIR:-}" ]; then
        printf "%s" "$MISE_SHIMS_DIR"
    elif [ -n "${MISE_DATA_DIR:-}" ]; then
        printf "%s" "$MISE_DATA_DIR/shims"
    elif [ -n "${HOME:-}" ]; then
        printf "%s" "$HOME/.local/share/mise/shims"
    fi
}

# Project-local caller paths (for example node_modules/.bin) keep their
# precedence, but mise shims must resolve before image-owned system binaries.
orkestrator_promote_path_before_system() {
    orkestrator_promote_target="${1:-}"
    if [ -z "$orkestrator_promote_target" ] || [ ! -d "$orkestrator_promote_target" ]; then
        return 0
    fi

    orkestrator_promote_snapshot="${PATH:-}"
    orkestrator_promote_result=""
    orkestrator_promote_inserted=false
    orkestrator_promote_old_ifs="$IFS"
    IFS=":"
    for orkestrator_promote_entry in $orkestrator_promote_snapshot; do
        [ -z "$orkestrator_promote_entry" ] && continue
        [ "$orkestrator_promote_entry" = "$orkestrator_promote_target" ] && continue
        if [ "$orkestrator_promote_inserted" = false ]; then
            case "$orkestrator_promote_entry" in
                /usr/local/bin|/usr/local/sbin|/usr/bin|/usr/sbin|/bin|/sbin)
                    orkestrator_promote_result="${orkestrator_promote_result:+$orkestrator_promote_result:}$orkestrator_promote_target"
                    orkestrator_promote_inserted=true
                    ;;
            esac
        fi
        orkestrator_promote_result="${orkestrator_promote_result:+$orkestrator_promote_result:}$orkestrator_promote_entry"
    done
    IFS="$orkestrator_promote_old_ifs"

    if [ "$orkestrator_promote_inserted" = false ]; then
        orkestrator_promote_result="${orkestrator_promote_result:+$orkestrator_promote_result:}$orkestrator_promote_target"
    fi
    PATH="$orkestrator_promote_result"
    export PATH
    unset orkestrator_promote_target orkestrator_promote_snapshot orkestrator_promote_result
    unset orkestrator_promote_inserted orkestrator_promote_old_ifs orkestrator_promote_entry
}

orkestrator_promote_mise_shims() {
    orkestrator_mise_shims="$(orkestrator_mise_shims_dir)"
    orkestrator_promote_path_before_system "$orkestrator_mise_shims"
    unset orkestrator_mise_shims
}

orkestrator_add_common_runtime_paths_with() {
    path_writer="$1"

    "$path_writer" "/usr/local/share/npm-global/bin"

    orkestrator_common_mise_shims="$(orkestrator_mise_shims_dir)"
    if [ -n "$orkestrator_common_mise_shims" ]; then
        "$path_writer" "$orkestrator_common_mise_shims"
    fi
    unset orkestrator_common_mise_shims

    if [ -n "${BUN_INSTALL:-}" ]; then
        "$path_writer" "$BUN_INSTALL/bin"
    fi
    if [ -n "${CARGO_HOME:-}" ]; then
        "$path_writer" "$CARGO_HOME/bin"
    fi
    if [ -n "${GOPATH:-}" ]; then
        "$path_writer" "$GOPATH/bin"
    fi
    if [ -n "${PNPM_HOME:-}" ]; then
        "$path_writer" "$PNPM_HOME"
    fi
    if [ -n "${DENO_INSTALL:-}" ]; then
        "$path_writer" "$DENO_INSTALL/bin"
    fi
    if [ -n "${PYENV_ROOT:-}" ]; then
        "$path_writer" "$PYENV_ROOT/shims"
        "$path_writer" "$PYENV_ROOT/bin"
    fi
    if [ -n "${RYE_HOME:-}" ]; then
        "$path_writer" "$RYE_HOME/shims"
    fi
    if [ -n "${UV_TOOL_BIN_DIR:-}" ]; then
        "$path_writer" "$UV_TOOL_BIN_DIR"
    fi
    if [ -n "${VOLTA_HOME:-}" ]; then
        "$path_writer" "$VOLTA_HOME/bin"
    fi

    if [ -n "${HOME:-}" ]; then
        "$path_writer" "$HOME/.local/bin"
        "$path_writer" "$HOME/bin"
        "$path_writer" "$HOME/.bun/bin"
        "$path_writer" "$HOME/.cargo/bin"
        "$path_writer" "$HOME/go/bin"
        "$path_writer" "$HOME/.deno/bin"
        "$path_writer" "$HOME/.npm-global/bin"
        "$path_writer" "$HOME/.yarn/bin"
        "$path_writer" "$HOME/.config/yarn/global/node_modules/.bin"
        "$path_writer" "$HOME/.opencode/bin"
        "$path_writer" "$HOME/.claude/local"
    fi

    export PATH
}

orkestrator_add_common_runtime_paths() {
    orkestrator_add_common_runtime_paths_with orkestrator_prepend_path
}

orkestrator_add_common_runtime_paths_floor() {
    orkestrator_add_common_runtime_paths_with orkestrator_append_path
}

orkestrator_ensure_bash_env() {
    mkdir -p "$(dirname "$ORKESTRATOR_BASH_ENV_FILE")"

    if [ ! -f "$ORKESTRATOR_BASH_ENV_FILE" ]; then
        {
            printf "# Generated by Orkestrator. Do not edit.\n"
            printf "if [ -f /usr/local/bin/orkestrator-runtime-env.sh ]; then\n"
            printf "    . /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true\n"
            printf "    orkestrator_source_runtime_env 2>/dev/null || true\n"
            printf "fi\n"
        } > "$ORKESTRATOR_BASH_ENV_FILE"
        chmod 644 "$ORKESTRATOR_BASH_ENV_FILE"
    fi

    export BASH_ENV="$ORKESTRATOR_BASH_ENV_FILE"
}

orkestrator_shell_quote() {
    if [ -z "${1:-}" ]; then
        printf "''"
        return 0
    fi

    printf "%s" "$1" | sed "s/'/'\\\\''/g; 1s/^/'/; \$s/\$/'/"
}

orkestrator_write_soft_export() {
    name="$1"
    value="$2"
    file="$3"

    printf "if [ -z \"\${%s:-}\" ]; then\n" "$name" >> "$file"
    printf "    %s=" "$name" >> "$file"
    orkestrator_shell_quote "$value" >> "$file"
    printf "\n" >> "$file"
    printf "    export %s\n" "$name" >> "$file"
    printf "fi\n" >> "$file"
}

orkestrator_write_path_merge_helpers() {
    file="$1"

    {
        printf "if ! command -v orkestrator_append_path >/dev/null 2>&1; then\n"
        printf "    orkestrator_append_path() {\n"
        printf "        if [ -z \"\${1:-}\" ] || [ ! -d \"\$1\" ]; then\n"
        printf "            return 0\n"
        printf "        fi\n"
        printf "        case \":\${PATH:-}:\" in\n"
        printf "            *\":\$1:\"*) ;;\n"
        printf "            *) PATH=\"\${PATH:+\$PATH:}\$1\" ;;\n"
        printf "        esac\n"
        printf "    }\n"
        printf "fi\n"
    } >> "$file"
}

orkestrator_write_path_merge() {
    file="$1"
    snapshot="${PATH:-}"

    if [ -z "$snapshot" ]; then
        return 0
    fi

    old_ifs="$IFS"
    IFS=":"
    for entry in $snapshot; do
        [ -z "$entry" ] && continue
        printf "orkestrator_append_path " >> "$file"
        orkestrator_shell_quote "$entry" >> "$file"
        printf "\n" >> "$file"
    done
    IFS="$old_ifs"
    printf "export PATH\n" >> "$file"
}

orkestrator_get_runtime_var() {
    case "$1" in
        PATH) printf "%s" "${PATH:-}" ;;
        BUN_INSTALL) printf "%s" "${BUN_INSTALL:-}" ;;
        CARGO_HOME) printf "%s" "${CARGO_HOME:-}" ;;
        GOPATH) printf "%s" "${GOPATH:-}" ;;
        PNPM_HOME) printf "%s" "${PNPM_HOME:-}" ;;
        DENO_INSTALL) printf "%s" "${DENO_INSTALL:-}" ;;
        PYENV_ROOT) printf "%s" "${PYENV_ROOT:-}" ;;
        RYE_HOME) printf "%s" "${RYE_HOME:-}" ;;
        UV_TOOL_BIN_DIR) printf "%s" "${UV_TOOL_BIN_DIR:-}" ;;
        VOLTA_HOME) printf "%s" "${VOLTA_HOME:-}" ;;
        MISE_DATA_DIR) printf "%s" "${MISE_DATA_DIR:-}" ;;
        MISE_SHIMS_DIR) printf "%s" "${MISE_SHIMS_DIR:-}" ;;
        NVM_DIR) printf "%s" "${NVM_DIR:-}" ;;
        FNM_DIR) printf "%s" "${FNM_DIR:-}" ;;
        BASH_ENV) printf "%s" "${BASH_ENV:-}" ;;
        *) return 1 ;;
    esac
}

orkestrator_capture_runtime_env() {
    mkdir -p "$(dirname "$ORKESTRATOR_RUNTIME_ENV_FILE")"
    orkestrator_add_common_runtime_paths
    orkestrator_ensure_bash_env

    tmp_file="${ORKESTRATOR_RUNTIME_ENV_FILE}.$$"
    {
        printf "# Generated by Orkestrator. Do not edit.\n"
        printf "# orkestrator-runtime-env: v3\n"
        printf "# Contains only whitelisted runtime path variables.\n"
    } > "$tmp_file"
    orkestrator_write_path_merge_helpers "$tmp_file"

    for name in PATH BUN_INSTALL CARGO_HOME GOPATH PNPM_HOME DENO_INSTALL PYENV_ROOT RYE_HOME UV_TOOL_BIN_DIR VOLTA_HOME MISE_DATA_DIR MISE_SHIMS_DIR NVM_DIR FNM_DIR BASH_ENV; do
        if [ "$name" = "PATH" ]; then
            orkestrator_write_path_merge "$tmp_file"
            continue
        fi

        value="$(orkestrator_get_runtime_var "$name")"
        if [ -n "$value" ]; then
            orkestrator_write_soft_export "$name" "$value" "$tmp_file"
        fi
    done

    chmod 600 "$tmp_file"
    mv "$tmp_file" "$ORKESTRATOR_RUNTIME_ENV_FILE"
}

orkestrator_runtime_env_is_current() {
    [ -f "$ORKESTRATOR_RUNTIME_ENV_FILE" ] &&
        grep -q "^# orkestrator-runtime-env: v3$" "$ORKESTRATOR_RUNTIME_ENV_FILE"
}

orkestrator_migrate_runtime_env() {
    old_runtime_env_file="$ORKESTRATOR_RUNTIME_ENV_FILE"

    (
        # shellcheck source=/dev/null
        . "$old_runtime_env_file" || exit 1
        ORKESTRATOR_RUNTIME_ENV_FILE="$old_runtime_env_file"
        orkestrator_capture_runtime_env
    )
}

orkestrator_source_runtime_env() {
    orkestrator_add_common_runtime_paths_floor

    if [ -f "$ORKESTRATOR_RUNTIME_ENV_FILE" ]; then
        if ! orkestrator_runtime_env_is_current; then
            orkestrator_migrate_runtime_env 2>/dev/null || true
        fi

        if orkestrator_runtime_env_is_current; then
            # shellcheck source=/dev/null
            . "$ORKESTRATOR_RUNTIME_ENV_FILE"
        fi
    fi

    # The backend refreshes this owner-only file whenever a container starts.
    # Its presence is authoritative even when empty, so switching credential
    # modes can override immutable environment variables from container creation.
    if [ -f "$ORKESTRATOR_GITHUB_CREDENTIAL_FILE" ]; then
        github_token="$(cat "$ORKESTRATOR_GITHUB_CREDENTIAL_FILE" 2>/dev/null || true)"
        if [ -n "$github_token" ]; then
            GITHUB_TOKEN="$github_token"
            GH_TOKEN="$github_token"
            export GITHUB_TOKEN GH_TOKEN
        else
            unset GITHUB_TOKEN GH_TOKEN
        fi
        unset github_token
    fi

    orkestrator_add_common_runtime_paths_floor
    orkestrator_promote_mise_shims
    orkestrator_ensure_bash_env
}
