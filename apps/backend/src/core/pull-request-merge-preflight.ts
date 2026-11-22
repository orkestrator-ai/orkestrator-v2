// Run merge-tree in a temporary bare gitdir. Only the source object database
// is shared, so attributes in the commits still apply, but checkout-local
// merge drivers and config cannot influence the result.
const HOST_MERGE_SCRIPT = [
  "objects=$(git rev-parse --path-format=absolute --git-path objects) || exit 2",
  "format=$(git rev-parse --show-object-format) || exit 2",
  "tmp=$(mktemp -d) || exit 2",
  "trap 'rm -rf -- \"$tmp\"' EXIT",
  "unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG GIT_CONFIG_PARAMETERS GIT_CONFIG_SYSTEM GIT_ATTR_SOURCE GIT_NAMESPACE",
  "export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_COUNT=0 GIT_ATTR_NOSYSTEM=1",
  'git init --quiet --bare --template= --object-format="$format" "$tmp" || exit 2',
  'printf "%s\\n" "$objects" >"$tmp/objects/info/alternates" || exit 2',
  'git --git-dir="$tmp" merge-tree --write-tree "$1" "$2" >/dev/null',
  'case $? in 0) printf "clean\\n";; 1) printf "conflict\\n";; *) exit 2;; esac',
].join("\n");

const ALIAS = "orkestrator-pr-merge-check";
const ALIAS_CONFIG = `alias.${ALIAS}=!check() {\n${HOST_MERGE_SCRIPT}\n}; check`;

export const prMergeCheckArgs = (base: string, head: string): string[] => [
  "-c",
  ALIAS_CONFIG,
  ALIAS,
  base,
  head,
];

// The agent and system publisher use the same preflight and result semantics.
const shellQuote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
export const PR_MERGE_CHECK_SHELL = `git -c ${shellQuote(ALIAS_CONFIG)} ${ALIAS} "$base_sha" "$head_sha"`;
