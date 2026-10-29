# Hostile tmux row observation exceeds its timing bound

- **ID:** 0231
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `tmux observations > bounds hostile padded rows and unterminated terminal controls`
- **File:** `packages/protocol/src/tmux-observation.test.ts:326`
- **Original command:** the testing guide's GNU-tool PATH with `mise run test:logged -- --name merge-latest-full-suite -- mise run test`.
- **Worker configuration:** workspace four slots (two package tasks, two Bun workers each), root one, bridges two, protocol check one. The component browser suite also ran on the host.
- **Failure:** elapsed observation time was 120.176 ms against a strict 100 ms bound; test duration 120.78 ms.
- **Suite counts:** protocol 1,467 total, 1,466 passed, one failed. Turbo stopped the remaining workspace tasks after this failure, leaving workspace coverage incomplete.
- **Isolated rerun:** `mise run test:logged -- --name merge-tmux-isolated -- bun test --cwd packages/protocol --preload ../../tests/setup-node.ts ./src/tmux-observation.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, wrapper duration below 0.1 seconds.
- **Evidence:** `workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` in `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.uJ6Ien/`.
- **Hypothesis:** the strict elapsed-time assertion is sensitive to aggregate host load. Passing alone does not establish which operation or scheduling delay consumed the additional time. No assertion or timeout was changed.


## Scheduling switch review — 2026-10-29

Preparation's `mise run test` repeated the hostile-row elapsed-time failure:
171.8835 ms against the 100 ms bound. The complete unchanged owner passed
alone (exit 0, 0.1 s):

```sh
mise run test:logged -- --name preparation-tmux-owner -- bun test --cwd packages/protocol --preload ../../tests/setup-node.ts ./src/tmux-observation.test.ts --parallel=1 --only-failures
```

Preparation evidence: `validation-04.stdout.txt` in
`.orkestrator/review-artifacts/review-validation-ad2356ce-9b58-4c2c-9646-2ee2f31dec55/`.
No implementation, assertion, deadline or skip changed in this owner.
