# Drop persisted credentials from the image publish checkout

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Set `persist-credentials: false`**: on the checkout in the job with `packages: write`. Status: open.

### 1. Set `persist-credentials: false`

**Problem.** The job's `GITHUB_TOKEN`, which can write packages, stays in `.git/config` while later steps run repository scripts.

**Context.** `.dockerignore:1` excludes `.git`, so the image build context does not receive it.

**Investigation.** Of the workflows, `packages: write` appears only in `.github/workflows/publish-container.yml`, at `:54` and `:142`. The job at `:142` has no checkout. The job at `:54` checks out at `:68`, and then runs `mise exec -- bun docker/image-manifest.ts` from the tree. No later step in that job pushes with git; it logs in to GHCR with an explicit password (`:74-78`). `persist-credentials` appears in no workflow.

**Decisions.** None: a one-line change, since no later step uses the stored credential.

## Related

- [Security report, §6 Informational](../2-26-10-27-security.md#6-informational) (I6)
