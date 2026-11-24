# Preflight prompt: the row's image was asserted before it had resolved

- **ID:** 10033
- **Status:** resolved
- **Date observed:** 2026-11-24
- **Base:** `38d560c0f` (pull request #2556, CI run 45436546941, job
  138595798066 `Tests (workspace)`).
- **Test:** `a prompt shown while its preflight runs > is withdrawn with its
  whole draft back when the preflight declines`
  (`apps/web/src/components/native-agent/AgentNativeTab.commands.test.tsx`).
- **Failure:** `expect(received).toBeTruthy()`, received `null`, for
  `img[src^="data:image/png"]` at line 1014 after 48.47 ms.
- **Original command:** the CI `Tests (workspace)` shard of the complete
  non-iOS suite (the web package's `test:workspace`).
- **Isolated rerun:** the runner's lone rerun of the file passed (3.1 s).

## Resolution (2026-11-24)

- **Root cause:** a test race. The test waited for `beforeSend` to be called,
  then read the image at once. `FilePart`
  (`apps/web/src/components/chat/NativeMessage.file-parts.tsx`) starts its
  read in an effect and sets the source when it answers.
- **Fix:** the test waits for the image; the text and the empty composer are
  still asserted at once.
- **Reproduced:** yes — delaying `FilePart`'s read by 100 ms (temporary,
  reverted) failed the old test and passed the new one.
- **Stress:** the file with `--rerun-each=3`: 126 pass, 0 fail.
