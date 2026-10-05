# Changelog

Notable changes, newest first. Versions are tagged in git; the plan behind them is in
[docs/roadmap](docs/roadmap/README.md).

## Unreleased

- The server has ordered, run-once migrations and a job runner for post-upload work,
  proven to converge under crashes across 200 simulated seeds.
- The roadmap: an assessment, research, a target architecture and a four-week plan,
  with ADRs 0007–0010 proposed.
- `pnpm verify` is green again: Expo's generated `expo-env.d.ts` is no longer
  format-checked.
