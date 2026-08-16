#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/../git-branch-helpers.sh"

TEST_ROOT=""

fail() {
    echo "FAIL: $1" >&2
    exit 1
}

assert_eq() {
    local expected="$1"
    local actual="$2"
    local message="$3"

    if [ "$expected" != "$actual" ]; then
        fail "$message (expected: '$expected', actual: '$actual')"
    fi
}

assert_same_named_origin_push_config() {
    assert_eq "current" "$(git config --get push.default || true)" "push.default should target the current branch"
    assert_eq "true" "$(git config --get push.autoSetupRemote || true)" \
        "push.autoSetupRemote should let the first push record the upstream"
}

# A branch whose remote counterpart does not exist yet must not claim one: an
# upstream pointing at a missing ref makes `git status` report "the upstream is
# gone" and makes `git pull` fail.
assert_no_upstream_before_first_push() {
    local branch="$1"
    assert_eq "" "$(git config --get "branch.${branch}.merge" || true)" \
        "a new branch must not claim an upstream that does not exist yet"
    assert_eq "" "$(git config --get "branch.${branch}.remote" || true)" \
        "a new branch must not claim a remote for an upstream that does not exist yet"
    git status >/dev/null 2>&1 || fail "git status should succeed on $branch"
    if git status -sb | head -n 1 | grep -q '\[gone\]'; then
        fail "git status should not report a gone upstream for $branch"
    fi
}

assert_plain_push_publishes_branch() {
    local branch="$1"
    git push >/dev/null 2>&1 || fail "plain git push should publish $branch"
    git ls-remote --exit-code --heads origin "refs/heads/${branch}" >/dev/null 2>&1 ||
        fail "plain git push should create origin/$branch"
    assert_eq "origin" "$(git config --get "branch.${branch}.remote" || true)" \
        "the first push should record origin as the branch remote"
    assert_eq "refs/heads/${branch}" "$(git config --get "branch.${branch}.merge" || true)" \
        "the first push should record the same-named upstream"
}

assert_new_branch_pushes_to_same_named_origin() {
    local branch="$1"
    assert_same_named_origin_push_config
    assert_no_upstream_before_first_push "$branch"
    assert_plain_push_publishes_branch "$branch"
}

setup_remote_repo() {
    local test_root="$1"
    local remote_repo="$test_root/remote.git"
    local seed_repo="$test_root/seed"

    git init --bare "$remote_repo" >/dev/null 2>&1
    git init "$seed_repo" >/dev/null 2>&1

    git -C "$seed_repo" config user.email "test@example.com"
    git -C "$seed_repo" config user.name "Test User"

    printf "initial\n" > "$seed_repo/README.md"
    git -C "$seed_repo" add README.md
    git -C "$seed_repo" commit -m "initial commit" >/dev/null 2>&1

    git -C "$seed_repo" branch -M trunk
    git -C "$seed_repo" remote add origin "$remote_repo"
    git -C "$seed_repo" push -u origin trunk >/dev/null 2>&1

    git -C "$seed_repo" checkout -b develop >/dev/null 2>&1
    printf "develop\n" >> "$seed_repo/README.md"
    git -C "$seed_repo" commit -am "develop commit" >/dev/null 2>&1
    git -C "$seed_repo" push -u origin develop >/dev/null 2>&1

    git -C "$seed_repo" checkout trunk >/dev/null 2>&1
    git -C "$seed_repo" checkout -b main >/dev/null 2>&1
    printf "main\n" >> "$seed_repo/README.md"
    git -C "$seed_repo" commit -am "main commit" >/dev/null 2>&1
    git -C "$seed_repo" push -u origin main >/dev/null 2>&1

    git --git-dir "$remote_repo" symbolic-ref HEAD refs/heads/trunk
}

test_prefers_configured_base_branch() {
    local test_root="$1"
    local clone_dir="$test_root/clone-configured"

    git clone "$test_root/remote.git" "$clone_dir" >/dev/null 2>&1
    cd "$clone_dir"

    local remote_head_ref
    remote_head_ref=$(git symbolic-ref --short refs/remotes/origin/HEAD)
    local remote_default_branch="${remote_head_ref#origin/}"

    local created_from
    created_from=$(create_branch_from_preferred_bases "feature/configured" "develop" "$remote_default_branch")

    assert_eq "develop" "$created_from" "configured base branch should be preferred"
    assert_eq "feature/configured" "$(git branch --show-current)" "should check out requested branch"
    assert_eq "$(git rev-parse origin/develop)" "$(git rev-parse HEAD)" "branch should start from origin/develop"
    assert_new_branch_pushes_to_same_named_origin "feature/configured"
}

test_falls_back_to_remote_default_branch() {
    local test_root="$1"
    local clone_dir="$test_root/clone-remote-default"

    git clone "$test_root/remote.git" "$clone_dir" >/dev/null 2>&1
    cd "$clone_dir"

    local remote_head_ref
    remote_head_ref=$(git symbolic-ref --short refs/remotes/origin/HEAD)
    local remote_default_branch="${remote_head_ref#origin/}"

    local created_from
    created_from=$(create_branch_from_preferred_bases "feature/remote-default" "missing-base" "$remote_default_branch")

    assert_eq "trunk" "$created_from" "should fall back to remote default branch"
    assert_eq "$(git rev-parse origin/trunk)" "$(git rev-parse HEAD)" "branch should start from origin/trunk"
    assert_new_branch_pushes_to_same_named_origin "feature/remote-default"
}

test_falls_back_to_main_when_remote_default_missing() {
    local test_root="$1"
    local clone_dir="$test_root/clone-main-fallback"

    git clone "$test_root/remote.git" "$clone_dir" >/dev/null 2>&1
    cd "$clone_dir"

    local created_from
    created_from=$(create_branch_from_preferred_bases "feature/main-fallback" "missing-base" "")

    assert_eq "main" "$created_from" "should fall back to main when remote default is unavailable"
    assert_eq "$(git rev-parse origin/main)" "$(git rev-parse HEAD)" "branch should start from origin/main"
    assert_new_branch_pushes_to_same_named_origin "feature/main-fallback"
}

test_does_not_inherit_the_base_branch_upstream() {
    local test_root="$1"
    local clone_dir="$test_root/clone-no-inherit"

    git clone "$test_root/remote.git" "$clone_dir" >/dev/null 2>&1
    cd "$clone_dir"

    local base_before
    base_before=$(git ls-remote origin refs/heads/develop | cut -f1)

    create_branch_from_preferred_bases "feature/no-inherit" "develop" "trunk" >/dev/null

    assert_eq "" "$(git config --get "branch.feature/no-inherit.merge" || true)" \
        "a new branch must not inherit its base branch as an upstream"

    printf "no-inherit\n" >> README.md
    git -c user.email="test@example.com" -c user.name="Test User" commit -am "no-inherit commit" >/dev/null 2>&1 ||
        fail "should be able to commit on feature/no-inherit"
    git push >/dev/null 2>&1 || fail "plain git push should publish feature/no-inherit"

    assert_eq "refs/heads/feature/no-inherit" "$(git config --get "branch.feature/no-inherit.merge" || true)" \
        "the first push should record the same-named upstream, not the base branch"
    assert_eq "$(git rev-parse HEAD)" "$(git ls-remote origin refs/heads/feature/no-inherit | cut -f1)" \
        "the environment commit should land on the environment branch"
    assert_eq "$base_before" "$(git ls-remote origin refs/heads/develop | cut -f1)" \
        "pushing the environment branch must not move the base branch"
}

test_creates_directly_from_a_remote_branch() {
    local test_root="$1"
    local clone_dir="$test_root/clone-direct-remote"

    git clone "$test_root/remote.git" "$clone_dir" >/dev/null 2>&1
    cd "$clone_dir"

    local checkout_result
    checkout_result=$(checkout_requested_branch "develop" "missing-base" "trunk")

    assert_eq "existing" "$checkout_result" "same-named remote branch should use Git's direct checkout"
    assert_eq "develop" "$(git branch --show-current)" "should check out the direct remote branch"
    assert_eq "$(git rev-parse origin/develop)" "$(git rev-parse HEAD)" "direct branch should use the requested remote start point"
    assert_same_named_origin_push_config
    # Git's DWIM checkout tracks the remote branch it created this one from, and
    # that branch really exists, so the upstream is correct as it stands.
    assert_eq "refs/heads/develop" "$(git config --get "branch.develop.merge" || true)" \
        "a checked-out remote branch should keep its real same-named upstream"
    assert_plain_push_publishes_branch "develop"
}

test_creates_from_current_head_without_a_start_point() {
    local test_root="$1"
    local clone_dir="$test_root/clone-head-fallback"

    git clone "$test_root/remote.git" "$clone_dir" >/dev/null 2>&1
    cd "$clone_dir"
    git branch -dr origin/main >/dev/null 2>&1
    local previous_commit
    previous_commit=$(git rev-parse HEAD)
    local checkout_result
    checkout_result=$(checkout_requested_branch "feature/head-fallback" "missing-base" "missing-default")

    assert_eq "head" "$checkout_result" "missing base branches should use the HEAD fallback"
    assert_eq "feature/head-fallback" "$(git branch --show-current)" "should check out the HEAD fallback branch"
    assert_eq "$previous_commit" "$(git rev-parse HEAD)" "HEAD fallback should preserve the current commit"
    assert_new_branch_pushes_to_same_named_origin "feature/head-fallback"
}

test_rolls_back_when_push_configuration_fails() {
    local test_root="$1"
    local clone_dir="$test_root/clone-config-failure"

    git clone "$test_root/remote.git" "$clone_dir" >/dev/null 2>&1
    cd "$clone_dir"

    # Restore the real helper afterwards. Bash function definitions are global,
    # so leaving the stub installed would silently make every later test pass
    # against a configuration step that always fails.
    local real_configure
    real_configure=$(declare -f configure_same_named_origin_push)
    # shellcheck disable=SC2329  # invoked indirectly, through the helper under test.
    configure_same_named_origin_push() {
        return 1
    }

    local created_from=""
    local create_status=0
    if created_from=$(checkout_requested_branch "feature/config-failure" "develop" "trunk"); then
        eval "$real_configure"
        fail "branch creation should fail when push configuration fails"
    else
        create_status=$?
    fi
    eval "$real_configure"

    assert_eq "2" "$create_status" "configuration failure should have a distinct status"
    assert_eq "" "$created_from" "configuration failure should not report a selected base"
    assert_eq "trunk" "$(git branch --show-current)" "configuration failure should restore the previous checkout"
    assert_eq "" "$(git branch --list "feature/config-failure")" "configuration failure should remove the partial branch"
}

test_environment_checkout_reports_the_created_base() {
    local test_root="$1"
    local clone_dir="$test_root/clone-env-base"

    git clone "$test_root/remote.git" "$clone_dir" >/dev/null 2>&1
    cd "$clone_dir"

    local output=""
    local status=0
    output=$(checkout_environment_branch "feature/env-base" "develop" "trunk") || status=$?

    assert_eq "0" "$status" "creating the branch from a base should be a success"
    assert_eq "Created new branch: feature/env-base (from develop)" "$output" "should report the base it created from"
    assert_eq "feature/env-base" "$(git branch --show-current)" "should check out the environment branch"
    assert_new_branch_pushes_to_same_named_origin "feature/env-base"
}

test_environment_checkout_reports_an_existing_branch() {
    local test_root="$1"
    local clone_dir="$test_root/clone-env-existing"

    git clone "$test_root/remote.git" "$clone_dir" >/dev/null 2>&1
    cd "$clone_dir"

    local output=""
    local status=0
    output=$(checkout_environment_branch "develop" "missing-base" "trunk") || status=$?

    assert_eq "0" "$status" "checking out an existing remote branch should be a success"
    assert_eq "Checked out: develop" "$output" "should report the direct checkout"
    assert_same_named_origin_push_config
}

test_environment_checkout_fails_when_push_configuration_fails() {
    local test_root="$1"
    local clone_dir="$test_root/clone-env-config-failure"

    git clone "$test_root/remote.git" "$clone_dir" >/dev/null 2>&1
    cd "$clone_dir"

    local real_configure
    real_configure=$(declare -f configure_same_named_origin_push)
    # shellcheck disable=SC2329  # invoked indirectly, through the helper under test.
    configure_same_named_origin_push() {
        return 1
    }

    local output=""
    local status=0
    output=$(checkout_environment_branch "feature/env-config-failure" "develop" "trunk") || status=$?
    eval "$real_configure"

    assert_eq "1" "$status" "an unconfigurable branch must stop the caller"
    assert_eq "Failed to configure same-named origin pushes for branch feature/env-config-failure" "$output" \
        "should report the configuration failure"
    assert_eq "trunk" "$(git branch --show-current)" "should restore the previous checkout"
    assert_eq "" "$(git branch --list "feature/env-config-failure")" "should remove the partial branch"
}

test_environment_checkout_keeps_the_clone_when_no_base_exists() {
    local test_root="$1"
    local clone_dir="$test_root/clone-env-no-base"

    git clone "$test_root/remote.git" "$clone_dir" >/dev/null 2>&1
    cd "$clone_dir"

    # With no start point available anywhere, only the HEAD fallback is left; make
    # that fail too so the caller sees the "could not create" path.
    local real_create
    real_create=$(declare -f create_branch_with_same_named_origin_push)
    # shellcheck disable=SC2329  # invoked indirectly, through the helper under test.
    create_branch_with_same_named_origin_push() {
        return 1
    }

    local output=""
    local status=0
    output=$(checkout_environment_branch "feature/env-no-base" "missing-base" "trunk") || status=$?
    eval "$real_create"

    assert_eq "0" "$status" "an uncreatable branch should leave the workspace usable"
    assert_eq "trunk" "$(git branch --show-current)" "should stay on the cloned branch"
    case "$output" in
        *"Failed to create branch: feature/env-no-base"*"Staying on current branch: trunk"*) ;;
        *) fail "should report the fallback (actual: '$output')" ;;
    esac
}

main() {
    TEST_ROOT="$(mktemp -d)"
    trap 'rm -rf "${TEST_ROOT:-}"' EXIT

    setup_remote_repo "$TEST_ROOT"

    test_prefers_configured_base_branch "$TEST_ROOT"
    test_falls_back_to_remote_default_branch "$TEST_ROOT"
    test_falls_back_to_main_when_remote_default_missing "$TEST_ROOT"
    test_does_not_inherit_the_base_branch_upstream "$TEST_ROOT"
    test_creates_directly_from_a_remote_branch "$TEST_ROOT"
    # The rollback cases install failing stubs, so a normal case runs after them
    # to prove the real helpers were restored.
    test_rolls_back_when_push_configuration_fails "$TEST_ROOT"
    test_environment_checkout_fails_when_push_configuration_fails "$TEST_ROOT"
    test_environment_checkout_keeps_the_clone_when_no_base_exists "$TEST_ROOT"
    test_creates_from_current_head_without_a_start_point "$TEST_ROOT"
    test_environment_checkout_reports_the_created_base "$TEST_ROOT"
    test_environment_checkout_reports_an_existing_branch "$TEST_ROOT"

    echo "PASS: git branch helper tests"
}

main
