#!/bin/bash

# Make a plain `git push` publish the current branch as a same-named branch on
# origin, and let that first push record the real upstream.
#
# `push.default=current` targets `origin/<current branch>` whatever the upstream
# says, so an environment branch can never update the base branch it was created
# from, and `push.autoSetupRemote=true` makes the first push behave like
# `git push -u`. Writing `branch.<name>.merge` up front instead would point the
# upstream at a ref that does not exist yet, which makes every `git status`
# report "the upstream is gone" and every `git pull` fail until the first push.
#
# Both settings are repository-scoped, so this is idempotent and safe to call for
# each branch that gets created.
configure_same_named_origin_push() {
    git config --local push.default current &&
        git config --local push.autoSetupRemote true
}

# Create and check out a branch without inheriting its start point's upstream,
# then configure same-named origin pushes. If configuration fails, restore the
# previous checkout and remove the new branch so callers never mistake a
# partially completed mutation for a normal "branch could not be created" case.
#
# Returns 2 when checkout succeeded but push configuration failed.
create_branch_with_same_named_origin_push() {
    local branch="$1"
    local start_point="${2:-}"
    local previous_branch=""
    local previous_commit=""

    previous_branch=$(git branch --show-current 2>/dev/null || true)
    previous_commit=$(git rev-parse --verify HEAD 2>/dev/null || true)

    if [ -n "$start_point" ]; then
        git checkout --no-track -b "$branch" "$start_point" >/dev/null 2>&1 || return 1
    else
        git checkout --no-track -b "$branch" >/dev/null 2>&1 || return 1
    fi

    if configure_same_named_origin_push; then
        return 0
    fi

    if [ -n "$previous_branch" ]; then
        git checkout "$previous_branch" >/dev/null 2>&1 || return 2
    elif [ -n "$previous_commit" ]; then
        git checkout --detach "$previous_commit" >/dev/null 2>&1 || return 2
    else
        return 2
    fi
    git branch -D "$branch" >/dev/null 2>&1 || return 2
    return 2
}

# Try creating a branch from preferred base branches.
#
# Args:
#   1: target branch name
#   2: configured base branch override (optional)
#   3: remote default branch (optional)
#
# Prints the selected base branch on success.
create_branch_from_preferred_bases() {
    local branch="$1"
    local configured_base="$2"
    local remote_default="$3"
    local candidate=""
    local create_status=0
    local tried_branches=""

    for candidate in "$configured_base" "$remote_default" "main" "master"; do
        if [ -z "$candidate" ]; then
            continue
        fi

        if [[ " $tried_branches " == *" $candidate "* ]]; then
            continue
        fi

        tried_branches="$tried_branches $candidate"

        if create_branch_with_same_named_origin_push "$branch" "origin/$candidate"; then
            printf "%s" "$candidate"
            return 0
        else
            create_status=$?
            if [ "$create_status" -eq 2 ]; then
                return 2
            fi
        fi
    done

    return 1
}

# Check out the requested branch, trying the same-named remote branch, preferred
# base branches, and finally the current HEAD. Prints a result token for the
# caller's status message. Propagates status 2 for push configuration errors.
checkout_requested_branch() {
    local branch="$1"
    local configured_base="$2"
    local remote_default="$3"
    local create_status=0
    local created_from=""

    if git checkout "$branch" >/dev/null 2>&1; then
        # Git's own DWIM checkout already tracks the same-named remote branch, so
        # only the repository-wide push behaviour is left to configure.
        configure_same_named_origin_push || return 2
        printf "existing"
        return 0
    fi

    if create_branch_with_same_named_origin_push "$branch" "origin/$branch"; then
        printf "remote"
        return 0
    else
        create_status=$?
        if [ "$create_status" -eq 2 ]; then
            return 2
        fi
    fi

    if created_from=$(create_branch_from_preferred_bases "$branch" "$configured_base" "$remote_default"); then
        printf "base:%s" "$created_from"
        return 0
    else
        create_status=$?
        if [ "$create_status" -eq 2 ]; then
            return 2
        fi
    fi

    if create_branch_with_same_named_origin_push "$branch"; then
        printf "head"
        return 0
    else
        create_status=$?
        return "$create_status"
    fi
}

# Check out the environment branch inside an already-cloned workspace and report
# the outcome on stdout.
#
# Args:
#   1: target branch name
#   2: configured base branch override (optional)
#   3: branch the clone is currently on, for the fallback message
#
# Returns 1 when the workspace was left in a state the caller must not continue
# from, and 0 when it is safe to proceed - including the case where the branch
# could not be created at all and the clone simply stays where it is.
checkout_environment_branch() {
    local branch="$1"
    local configured_base="$2"
    local current_branch="$3"
    local green="${GREEN:-}"
    local red="${RED:-}"
    local yellow="${YELLOW:-}"
    local nc="${NC:-}"
    local remote_head_ref=""
    local remote_default=""
    local checkout_result=""
    local checkout_status=0

    remote_head_ref=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)
    remote_default="${remote_head_ref#origin/}"

    if checkout_result=$(checkout_requested_branch "$branch" "$configured_base" "$remote_default"); then
        case "$checkout_result" in
            existing)
                echo "${green}Checked out: ${branch}${nc}"
                ;;
            remote)
                echo "${green}Checked out remote: origin/${branch}${nc}"
                ;;
            base:*)
                echo "${green}Created new branch: ${branch} (from ${checkout_result#base:})${nc}"
                ;;
            head)
                echo "${green}Created new branch: ${branch} (from HEAD)${nc}"
                ;;
            *)
                echo "${red}Unexpected branch checkout result for ${branch}${nc}"
                return 1
                ;;
        esac
        return 0
    else
        checkout_status=$?
    fi

    if [ "$checkout_status" -eq 2 ]; then
        echo "${red}Failed to configure same-named origin pushes for branch ${branch}${nc}"
        return 1
    fi

    echo "${red}Failed to create branch: ${branch}${nc}"
    echo "${yellow}Staying on current branch: ${current_branch}${nc}"
    return 0
}
