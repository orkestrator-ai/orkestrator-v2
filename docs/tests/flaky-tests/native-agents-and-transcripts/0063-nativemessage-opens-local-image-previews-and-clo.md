# `NativeMessage > opens local image previews and closes the overlay with Escape` (`tests/unit/components/NativeMessage.test.tsx`)

- **ID:** 0063
- **Status:** resolved
- **Date observed:** 2026-08-16
- **Original command:** `bun run test:logged -- --name full-suite -- bun run test`
- **Worker configuration:** the root and agent-support group ran with six Bun
  workers while the workspace, bridge, and protocol-lockfile groups ran
  concurrently.
- **Failure:** the Escape assertion failed only in the aggregate run after the
  image had opened; the root group reported 3,697 passed, 1 skipped, and 3
  failed across 147 files. The owning file and the six-worker root group both
  passed when rerun alone.
- **Isolated rerun:** `bun run test:logged -- --name native-message-fixed -- bun
  test ./tests/unit/components/NativeMessage.test.tsx` passed in 2.7 s; the
  six-worker root group passed 3,701 tests in 122.7 s after the fix.
- **Root cause:** The overlay installed its Escape listener in a passive
  `useEffect`, leaving a scheduler-dependent window after the overlay became
  visible in which the test's key event could arrive before the listener was
  attached. The file-part close callback was also recreated during renders.
- **Fix:** Install the overlay's keyboard listener in `useLayoutEffect` and use
  a stable close callback for the overlay. Escape is now wired before the
  visible overlay can be interacted with, including under aggregate renderer
  load.
- **Verification:** The focused file and the six-worker root group passed. The
  final `bun run test:logged -- --name full-suite-final -- bun run test` passed
  all four concurrent groups in 99.2 s.
