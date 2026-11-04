#!/bin/sh
# ORKESTRATOR_CAPABILITY github-git-credential=1
#
# Git credential helper for the backend-managed GitHub token. Reading the file
# per request keeps the token out of ~/.gitconfig and origin, and a rotated or
# cleared token applies at once. Never stores anything: Git calls this with
# get, store or erase as $1, and only get is answered. As in runtime-env.sh, the
# file is authoritative whenever it exists, even when empty.

[ "${1:-}" = get ] || exit 0

protocol=
host=
while IFS= read -r line && [ -n "$line" ]; do
    case "$line" in
        protocol=*) protocol=${line#protocol=} ;;
        host=*) host=${line#host=} ;;
    esac
done

# The Git config scopes this to github.com, but that is not a secret boundary:
# check the request too, so nothing else can be handed the token.
[ "$protocol" = https ] && [ "$host" = github.com ] || exit 0

credential_file="${ORKESTRATOR_GITHUB_CREDENTIAL_FILE:-/tmp/orkestrator-ai/github-token}"
if [ -f "$credential_file" ]; then
    token="$(cat "$credential_file" 2>/dev/null || true)"
else
    token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
fi
[ -n "$token" ] || exit 0

printf 'username=x-access-token\npassword=%s\n' "$token"
