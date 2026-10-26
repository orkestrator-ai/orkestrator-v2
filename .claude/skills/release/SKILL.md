---
name: release
description: Cut an Orkestrator desktop release - bump the version through a PR, build and upload macOS on this Mac and Linux on omarchy-hp in parallel to the draft GitHub release, then publish to GitHub and npm. Use when asked to cut a release, bump/roll the version, build release packages, or publish a release, including from a worker under an Orkestrator coordinator.
---

# Orkestrator release

The version in `package.json` decides everything: the tag is `v<version>` and the
suffix picks the update channel - none = Stable, `-beta` = Beta, `-alpha` = Unstable
(optionally numbered, `-alpha.2`). Scripts: `scripts/set-version.ts`,
`scripts/release-desktop.ts`.

Never push to or merge into `main`. The version bump goes through a PR that a
human merges; the release is built from `main` after that.

## Running under an Orkestrator coordinator

Run the whole release from one local (not containerized) worker environment on the
Mac. End to end:

1. Open the version-bump PR, then ask to merge it. No CI wait.
2. Once merged, start the macOS build in the background. When it has pushed the tag
   and created the draft, start the Linux build on omarchy-hp. Both run in parallel.
3. When both have uploaded, publish (GitHub + npm).

Every step that needs the user goes to the coordinator, which tells the user in the
coordinator session: merging the PR, Tailscale SSH auth URLs, `npm login`, npm
2FA/web-auth URLs, publish confirmation, SSH passphrases or host-key prompts, Apple
or `gh` sign-in. Never just wait for these.

Mail a worker sends mid-turn is held until its turn ends. So: `send_message` to
`toEnvironmentId: "coordinator"`, then end the turn straight away. Run long work
(builds, publish) as background tasks so it keeps going and re-invokes you when it
exits. You resume on the coordinator's reply or the task's exit.

When a user runs this directly (no coordinator), ask them in the session instead.

## 1. Set the version (Mac)

Pick the version with the user (e.g. minor alpha from `2.23.0` -> `2.24.0-alpha`).
It must be newer than the current one.

```bash
git switch main && git pull
git switch -c release/v<version>
mise run release:version -- <version>   # writes all manifests, regenerates lockfiles, runs drift test
git add -A && git commit -m "chore(release): bump version to <version>"
git push -u origin release/v<version>
gh pr create --base main --title "chore(release): bump version to <version>" --body "..."
```

Do not wait on CI for this PR: no `gh pr checks --watch` or any other open-ended
wait. Ask the user to merge it (coordinator: send the PR URL and end the turn).
Once it is merged, carry on right away. Any wait loop must be bounded and poll the
merge state, not checks:

```bash
gh pr view <n> --json state,mergeCommit
```

`release:desktop` refuses to tag a HEAD that is not on `origin/main`.

## 2. Build + upload macOS (this Mac)

```bash
git switch main && git pull     # HEAD must be the merged bump; tree must be clean
mise run release:desktop > mac-release.log 2>&1; echo "EXIT=$?" >> mac-release.log
```

- Start it as a background task. The first platform run creates and pushes the tag
  and the draft GitHub release.
- Notarization uses the `orkestrator-notary` keychain profile automatically.
  (Bare `mise run package:release` does NOT - it needs
  `APPLE_KEYCHAIN_PROFILE=orkestrator-notary` exported.)
- It takes a long time (build + sign + notarize). Keep the real exit status:
  redirect to a log and `echo "EXIT=$?"`. Do not pipe through `tail`, which hides
  the exit code.
- Do NOT wrap release builds in `mise run test:logged`: its 300 s no-output
  watchdog kills electron-builder during the silent signing/notarization step.

## 3. Build + upload Linux (omarchy-hp, from the Mac)

Same worker, in parallel with the Mac build. Start it only after the Mac run has
pushed the tag and created the draft (`gh release view v<version>` shows a draft):
`claimDraftRelease` fails if two drafts exist, so don't start both at the same
instant.

Repo path there is `~/project/apps/orkestrator-v2` (singular `project`). Its git
needs the forwarded agent to reach GitHub, so always use `ssh -A`.
`scripts/download-bun.sh` needs `shasum`, which on Arch lives in
`/usr/bin/core_perl` and is not on PATH.

```bash
ssh -A -o BatchMode=yes omarchy-hp 'cd ~/project/apps/orkestrator-v2 \
  && git status --short && git switch main && git pull --ff-only && grep "\"version\"" package.json'
```

Start this as a local background task. The remote side runs under `nohup` with a
remote log and `EXIT=`, so a dropped connection doesn't kill the build; keeping the
ssh session open keeps the forwarded agent alive for the build's git steps:

```bash
ssh -A -o BatchMode=yes omarchy-hp 'cd ~/project/apps/orkestrator-v2 \
  && PATH="$PATH:/usr/bin/core_perl" nohup sh -c "mise run release:desktop; echo EXIT=\$?" \
     > ~/linux-release.log 2>&1 < /dev/null'
```

(tmux works too: `tmux new -d -s release '...; echo EXIT=$? >> ~/linux-release.log'`,
but a fully detached job loses the forwarded agent once ssh exits.)

Watch both logs with bounded polls, e.g. a few minutes at a time:

```bash
for i in $(seq 1 60); do grep -q 'EXIT=' mac-release.log && break; sleep 5; done; tail -5 mac-release.log
ssh -o BatchMode=yes omarchy-hp 'tail -5 ~/linux-release.log'
```

If ssh prints a Tailscale SSH login/auth URL, send it to the coordinator and end
the turn (directly: give it to the user to approve).

## 4. Publish

Only after both platforms uploaded successfully (both logs end `EXIT=0`). Confirm
with the user before publishing - it is outward-facing (coordinator: ask, end the
turn).

It checks every platform's artifacts are on the draft, publishes the `orkestrator`
npm package at the same version under the channel's dist-tag, and makes the release
public. Prereleases stay off "Latest"; publishing an alpha re-drafts older published
alphas. The release stays a draft until npm succeeds, and installed apps that see
the pushed tag get a 404 on update checks until then. Pass `--skip-npm`
(`bun scripts/release-desktop.ts publish --skip-npm`) only if the user asks to leave
npm out.

1. Check npm auth with `bunx npm whoami` first (a 401 there shows up as a
   misleading 404 on publish). If logged out, ask the user to run
   `! bunx npm login` (coordinator: send the request, end the turn).
2. Start publish as a background task writing to a log:

   ```bash
   F=publish.log; mise run release:publish > "$F" 2>&1; echo "EXIT=$?" >> "$F"
   ```

3. Poll every ~3 s for at most ~4 min for the npm web-auth URL or `EXIT=`:

   ```bash
   for i in $(seq 1 80); do grep -qE 'npmjs.com/auth|EXIT=' "$F" && break; sleep 3; done
   ```

4. As soon as the `https://www.npmjs.com/auth/cli/...` URL appears, send it to the
   coordinator (directly: the user) and end the turn immediately - approval times
   out after about 5 minutes (`404 Not Found: .../-/v1/done`, nothing published).
   Leave the background publish running.
5. When it exits, report the result.

Don't pipe input into publish (e.g. `sleep 900 | mise run release:publish`): `EXIT=`
then waits for the input command.

## Dry runs

`mise run release:desktop -- --no-publish` builds on either machine without tagging
or touching GitHub - useful for checking signing/packaging before the PR merges.
