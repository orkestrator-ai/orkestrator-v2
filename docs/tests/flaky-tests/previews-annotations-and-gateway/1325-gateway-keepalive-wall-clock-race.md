# Gateway keepalive test races the host scheduler

- **ID:** 1325
- **Status:** resolved
- **Date observed:** 2026-10-31
- **Test:** `a link that drops without an answer > a same-origin stream that stops its keepalives counts as lost, and is replaced`
- **File:** `apps/web/src/lib/native/web-gateway-reconnect.test.ts`
- **Original command:** `mise run test:logged -- --name reconnect-web -- bun test --cwd apps/web ./src/lib/native/web-gateway-reconnect.test.ts ./src/lib/native/web-gateway-silent-recovery.test.ts ./src/lib/native/terminal-websocket-client.test.ts --parallel=1 --only-failures`
- **Worker configuration:** one isolated Bun worker; browser and Electron validation were also running on the shared host.
- **Failure:** expected `connected`, received `disconnected`, after the keepalive loop (205.93 ms).
- **Suite counts:** 75 passed, one failed across three files; 313 expectations; 4.99 s.
- **Isolated rerun:** `mise run test:logged -- --name reconnect-web-owner -- bun test --cwd apps/web ./src/lib/native/web-gateway-reconnect.test.ts --parallel=1 --only-failures` passed unchanged (1.9 s).
- **Root cause:** keepalives used real 20 ms timers against a real 40 ms silence deadline. A delayed keepalive could legitimately lose to the watchdog while the test still expected a healthy stream.
- **Fix:** the same-origin and direct keepalive tests now inject the gateway's existing clock override. It advances between keepalives and explicitly reaches the silence deadline after the healthy-state assertions. The actual watchdog and abort/reconnect paths still run; host scheduling cannot manufacture an earlier deadline.
- **Verification:** the exact original three-file command passed after the fix (76 passed, zero failed, 5.4 s). The new direct recovery tests separately drive watchdog and retry timers with a controlled clock, including consecutive unanswered attempts.
