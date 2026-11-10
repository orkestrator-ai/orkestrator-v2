# Input-stamp tests lose every stamp when macOS bash crashes

- **ID:** 4841
- **Status:** resolved
- **Date observed:** 2026-11-04
- **Test/file:** `what the home holds decides as much as what the stamp says > a damaged stamp falls back to the copy` and `import ownership failures > failed removal retries (whole tree missing=true)`, apps/backend/tests/portable-inputs-stamps.test.ts. Every test in the file that expects a stamp to be recorded can hit it.
- **Original command:** `mise run test` (aggregate) during review preparation of the list_nodes version branch (commit e02ea330a), macOS arm64.
- **Failure:** `damaged stamp`: `expect((await f.boot()).copied).toBe(0)` received 9. `whole tree missing=true`: progress lacked "will retry" and reported `Agent inputs: 8 unchanged, 8 copied`.
- **Isolated rerun:** this is not a load flake. The owning file failed on its own too: 1 of 2 plain `bun test tests/portable-inputs-stamps.test.ts` runs failed, and 1 of 6 runs of the two tests by name failed.
- **Root cause:** the fixture runs the entrypoint with Homebrew's bash 5.3.15 (first on `gnuToolPath`) and passes no locale variables. In the ownership-recording subshell of `import_agent_input` (`docker/entrypoint.sh`), bash restores the locale after `LC_ALL=C comm`/`LC_ALL=C sort`. With `LANG` unset, Homebrew's libintl asks CoreFoundation for the user's preferred languages, and CoreFoundation is not safe to call in a forked child. In about one boot in ten every such subshell died with SIGSEGV, so that boot recorded no tree stamp and the next boot copied every tree again. All 29 bash crash reports in `~/Library/Logs/DiagnosticReports` on 2026-11-04 have the same stack: `dispose_temporary_env → sv_locale → set_locale_var → reset_locale_vars → libintl_setlocale → CFLocaleCopyPreferredLanguages → … _os_log_preferences_refresh`. The image sets `LANG`/`LC_ALL` and uses Linux bash without CoreFoundation, so containers are not affected.
- **Fix:** the fixture's boot environment sets `LANG=C.UTF-8`, so bash restores a named locale and never consults CoreFoundation. The entrypoint and the assertions are unchanged.
- **Verification:** a throwaway 40-test harness, each test running two boots from a fresh home: without `LANG`, 2 of 40 failed with 27 segfaults (an earlier run: 4 of 40); with `LANG=C.UTF-8`, 40 of 40 passed with no segfaults, twice. The whole owning file then passed twice through `mise run test:logged` (118.2 s and 116.0 s).


## Owner moved to the slow tier and consolidated (2026-11-10)

`apps/backend/tests/portable-inputs-stamps.test.ts` now runs only in the slow tier (`scripts/test-tiers.ts`; `mise run test:slow`, and CI's `test:full` on every pull request), so the default `mise run test` no longer runs it. The file was also consolidated: one fixture build per file restored per test, the per-provider `logins` tests merged into two scenarios covering all five providers, and the `import ownership failures` matrix reduced from 15 tests to 5. Entrypoint boots went from 129 to 59 and the file alone from about 115 s to about 55 s. Some test names cited above no longer exist; search the file for the scenario rather than the old name.
