# Preview forwarding times out waiting to register a held connection

- **ID:** 10081
- **Status:** open
- **Date observed:** 2026-11-26
- **Test:** `PreviewExternalForward > reports idle only once no connection is open, then closes cleanly`
- **File:** `apps/desktop/tests/preview-external-forward.test.ts`
- **Host:** Linux, Bun 1.4.4.
- **Observing head:** `211ed17ef`.
- **Observing branch base:** `625bfca0cc7470260e60372339fa4c23fa5cefd9`.

## Observation

`mise run test:logged -- --name review-default-tests -- mise run test`
failed this test in the desktop workspace suite with two Bun workers. The
desktop suite reported 2,295 passes, 1 failure and 14 skips across 151 files.
The test failed after 2,896.72 ms with `Condition was not reached.` at
`preview-external-forward.test.ts:358`. The TCP client had connected, but
the test's polling helper never observed the forward cancel the idle timer
while the client socket was held open.

The unchanged owning file passed in isolation (2.48 s, exit 0):

```bash
env -u NODE_ENV mise run test:logged -- --name preview-external-forward-alone -- \
  bun test --cwd apps/desktop --preload ../../tests/setup-node.ts \
  ./tests/preview-external-forward.test.ts --parallel=1 --only-failures
```

## Assessment

The failure was at the first idle timer transition, before the test destroyed
the socket. The cause remains unconfirmed. A client-side connect callback does
not establish when the server's connection handler ran or whether the timer
transition was visible to the poll. Capture the server-side connection event
and timer bookkeeping under contention to distinguish those possibilities.
