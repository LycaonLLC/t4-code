# Performance measurements

T4 uses deterministic fixtures for regression measurements. Performance claims must record the
source commit, dirty state, platform, Flutter and Node versions, fixture, repetition count, and raw
report path.

## Current commands

| Command | Measurement | Intended use |
|---|---|---|
| `pnpm perf:core` | 10k snapshot ingestion and bounded event projection | Host and TypeScript compatibility regressions |
| `pnpm perf:ui` | Flutter widget and integration coverage | Canonical client regression gate |
| `pnpm perf:compare -- <baseline> <current>` | Median change for matching JSON metrics | Fails when a median regresses by more than 10% |
| `pnpm perf:vps` | Core and Flutter gates on the configured VPS | Repeatable same-host comparison |

Reports are written to `test-results/perf/`. They include a non-identifying machine label, Git
commit, dirty state, tool versions, operating system, CPU, and memory. Use
`T4_PERF_MACHINE_LABEL` when several machines must be distinguished. Raw samples are retained;
comparisons are meaningful only when the scenario, configuration, and cache state match.

The host-service transcript-page tests remain the cold-history performance guard below the UI.
They create a transcript larger than 64 MiB and verify newest-page reads stay bounded rather than
loading the entire file.

Before a release or after a major client change, run the Flutter integration smoke on the affected
desktop platform and manually check scrolling with the 10k fixture. Linux/VPS results are not a
substitute for Apple Silicon launch, GPU, signing, or packaging evidence.
