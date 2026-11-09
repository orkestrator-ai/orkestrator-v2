# Log writer regression script: marker-and-data case split by bash's printf

- **ID:** 9915
- **Status:** resolved
- **Date observed:** 2026-11-09
- **Test:** the marker-and-data failure case of `docker/tests/log-writer-test.sh`
  (run by the image build, `docker/tests/final-image-smoke.sh` and
  `the writer handles rotation failures, output errors, signals and fallback`)
- **File:** `docker/tests/log-writer-test.sh:153`, owning test
  `apps/backend/tests/container-log-service.test.ts`

## Observation (2026-11-09)

- **Run:** `docker build $(bun scripts/docker-image-build-args.ts) -t orkestrator-v2:q5510-c6de4733c -f docker/Dockerfile .`
  on a disposable rootless daemon (`mise run docker:disposable`) on beelink2
  (Arch Linux, kernel 7.2.15, x86_64, 16 cores, load average about 50), for
  to-do 5510. Branch `20261109-224629-a4b698fad8f5`, base `c6de4733c`.
- **Failure:** Dockerfile step `RUN su node -s /bin/bash -c 'bash /tmp/orkestrator-log-writer-test.sh …'`
  exited 1 with `FAIL: expected content in …/marker-data-failure.log: [orkestrator-log-writer] dropped 1 lines`,
  `kept`, `par`.
- **Rerun:** the same build passed on the next attempt (cached layers up to
  that step).
- **On the host:** `bash docker/tests/log-writer-test.sh docker/orkestrator-log-writer.sh`
  passed 6 of 20 (bash 5.3.20); every failure was this case. With the file
  content printed on failure, it held the marker and `kept\n` but not `par`.

## Resolution (2026-11-09)

- **Root cause:** the case injects a failure by counting the writer's
  `syswrite` calls and assumes `printf 'kept\npartial\n' >&3` reaches the
  writer as one read. Into a FIFO, bash's `printf` builtin flushes each line
  with its own `write(2)`. A perl reader on a FIFO fed that `printf` 300 times
  read 259 pairs as `5` + `8` bytes and only 41 as one 13-byte read. When the
  writer wakes between the two writes it writes `kept\n` alone (call 2) and
  `partial\n` takes the injected failure (call 3), so `kept\npar` never
  appears. The writer behaves correctly; the test's premise was wrong.
- **Fix:** the case sends both lines with one `perl -e 'syswrite(STDOUT, …)'`,
  a single 13-byte write, atomic on a pipe (below `PIPE_BUF`).
- **Reproduced:** yes. Before the fix the script passed 6 of 20 on the
  loaded host above, and the image build failed once. After it, the script
  passed 40 of 40 on the same host under the same load (load average about 60).
- **Stress:** `mise run test:logged -- --name container-log-service -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/container-log-service.test.ts --parallel=1 --rerun-each=5`
  passed. The image build that followed the fix is not separately recorded.
