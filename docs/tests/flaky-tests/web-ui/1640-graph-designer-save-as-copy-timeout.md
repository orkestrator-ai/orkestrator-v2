# Graph designer "Save as copy" test hit the 5000 ms timeout in a parallel subset

- **ID:** 1640
- **Status:** open
- **Date observed:** 2026-11-01
- **Test:** `GraphDesignerTab editing > saves with compare-and-swap; a lost race keeps the draft and offers Save as copy`
- **File:** `apps/web/src/components/graph-designer/GraphDesignerEditing.test.tsx`
- **Original command:** `mise run test:logged -- --name web-launch -- bun --cwd=apps/web test src/components/review src/components/build src/components/environments src/components/launch src/components/graph-launch src/components/graph-designer src/components/settings src/components/layout src/components/kanban src/hooks/useBuildPipeline.test.tsx src/hooks/useBuildLaunchOptions.test.ts src/lib/agent-launch.test.ts src/lib/review-launch-options.test.ts src/lib/build-pipeline-persistence.test.ts src/lib/feature-build-launch.test.ts src/lib/create-environment-agent-defaults.test.ts src/components/build-pipeline --parallel=2 --only-failures`. Host load at the time was not measured.
- **Failure:** timed out after 5000 ms (5230.48 ms). The unhandled error between tests was at line 294, `TypeError: undefined is not an object (evaluating 'imported[1]')`: no `graph_template_import` call had been recorded when the late assertion ran. Suite counts: 2781 pass, 10 skip, 2 fail, 1 error, across 173 files. The other failure was an unrelated stale assertion, fixed in the same change.
- **Isolated rerun:** `bun --cwd=apps/web test src/components/graph-designer/GraphDesignerEditing.test.tsx --only-failures` passed: 5 pass, 42 expect() calls, 10.56 s.
- **Hypothesis:** load, unproven. The whole file takes over 10 s alone across five tests, so a single case may have little margin under a 5000 ms limit. The change under test edited no file in `graph-designer/`, though it did change `lib/agent-launch.ts`, which other components in that folder import. Next recurrence: time this case alone and in parallel.
