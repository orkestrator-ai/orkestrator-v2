# Graph branch test depends on which builder submits first

- **ID:** 10007
- **Status:** resolved
- **Date observed:** 2026-11-19
- **Test:** `competing implementations > a branch that submits with uncommitted work is refused and corrects itself`
- **File:** `apps/backend/src/core/graph-isolated-branches.test.ts`
- **Branch base:** `fb2c01e830f497e51745bebd8d73a093fb4af90a`
- **Original command:** `mise run test:logged -- --name merge-suite -- mise run test`
- **Worker configuration:** Bun 1.4.4 with six granted worker slots for the workspace group, alongside the other default-tier groups.
- **Failure:** At 296.79 ms, the supposed refusal was an accepted workflow result. The backend package reported 19,784 passed, two failed and 152 skipped.
- **Isolated rerun:** The aggregate runner's isolated rerun of the owning file passed. A separate `bun test --cwd apps/backend ./src/core/graph-isolated-branches.test.ts --parallel=1 --rerun-each=12 --only-failures` run through `test:logged` reproduced the mismatch seven times, with 53 passes.

## Resolution

The fixture gave `sample.1` an uncommitted file only when no builder had
submitted yet. Another builder could submit first and prevent the fixture
from creating its dirty worktree. It also checked the obsolete `accepted`
field, which classified an accepted response carrying `ok: true` as a
refusal. The test now seeds the dirty worktree based on the branch and
classifies submission results by `ok`. The owning file passed all 20
repetitions, covering 100 tests, when rerun with `--rerun-each=20` and the
same worker configuration through `test:logged`.
