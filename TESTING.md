# Testing Guide — ottochain-monitoring

## Test Runner

**Vitest** with TypeScript support. Tests live in `src/**/*.test.ts`.

```bash
npm test            # Run all alert tests
npm run test:watch  # Watch mode for development
```

## Flaky Test Strategy

`vitest.config.ts` sets `retry: 2`. Any test that fails will be retried up to 2
additional times before being reported as a failure.

Alert rule tests can be timing-sensitive on loaded CI runners (e.g. threshold
boundary tests where CPU readings fluctuate). The retry covers transient assertion
failures without hiding genuine bugs.

## Known Flaky Patterns

| Suite | Potential Cause | Mitigation |
|-------|----------------|------------|
| `resource-alerts.test.ts` | CPU % boundary assertions on loaded runners | `retry: 2` |
| `tessellation-alerts.test.ts` | Async state accumulation timing | `retry: 2` |

## Test Coverage

Alert modules (`src/alerts/`):
- `resource-alerts.ts` — 32 tests (RAM/Swap/Disk/CPU thresholds + process-absent)
- `tessellation-alerts.ts` — 37 tests (ML0 zero-updates, DL1 download-only, GL0 peer drop, CL1 container down, Ember filter)

Total: **69 tests**

## CI

Tests run automatically on push/PR via `.github/workflows/ci.yml`. On failure,
test artifacts are uploaded for 7 days.

## Debugging

```bash
# Run a specific suite
npx vitest run src/alerts/resource-alerts.test.ts

# Run with verbose output
npx vitest run --reporter=verbose

# Reproduce intermittent failures
for i in {1..10}; do npx vitest run; done
```
