#!/bin/sh
# QA stand-in for `gh` inside a disposable fixture container (todo 0048,
# task 4). It answers the calls the PR monitor and the merge make for the one
# pull request named in $dir/url, and merges it with plain Git into the
# fixture's bind-mounted bare origin, as GitHub would. The spec installs it
# in /usr/local/bin, ahead of the image's /usr/bin/gh, and removes it after.
dir=/tmp/orkestrator-qa-fake-gh
url=$(cat "$dir/url")
branch=$(cat "$dir/branch")
printf '%s\n' "$*" >> "$dir/calls"
state=OPEN
[ -f "$dir/merged" ] && state=MERGED
jq_filter=""
fields=""
previous=""
for argument in "$@"; do
  [ "$previous" = "--jq" ] && jq_filter=$argument
  [ "$previous" = "--json" ] && fields=$argument
  previous=$argument
done
head_sha=$(git -C /workspace rev-parse HEAD)
case "$1 $2" in
  "pr view")
    case "$jq_filter" in
      .url) echo "$url" ;;
      .isDraft) echo false ;;
      .state) echo "$state" ;;
      "")
        case "$fields" in
          *statusCheckRollup*) printf '{"statusCheckRollup":[],"headRefOid":"%s"}\n' "$head_sha" ;;
          *) printf '{"url":"%s","state":"%s","headRefOid":"%s","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","isDraft":false,"baseRefName":"main"}\n' "$url" "$state" "$head_sha" ;;
        esac ;;
      *) echo "fake gh: unsupported --jq $jq_filter" >&2; exit 1 ;;
    esac ;;
  "pr list") echo "[]" ;;
  "pr merge")
    work=$(mktemp -d)
    git clone -q --branch main /orkestrator-agent-test-origin.git "$work/repo" || exit 1
    cd "$work/repo" || exit 1
    git -c user.name=QA -c user.email=qa@invalid.local merge -q --squash "origin/$branch" || exit 1
    git -c user.name=QA -c user.email=qa@invalid.local commit -q -m "QA squash merge of $branch" || exit 1
    git push -q origin HEAD:main || exit 1
    case " $* " in *" --delete-branch "*) git push -q origin ":$branch" || exit 1 ;; esac
    rm -rf "$work"
    touch "$dir/merged" ;;
  "api --hostname")
    case "$jq_filter" in
      .permissions) echo '{"push":true}' ;;
      *) echo "fake gh: unsupported api call" >&2; exit 1 ;;
    esac ;;
  *) echo "fake gh: unsupported command: $*" >&2; exit 1 ;;
esac
