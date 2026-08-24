# harness-home

> GitHub-issue-ready. Title: **Fold the fake-pi harness out of test/ — production stops importing test infrastructure**

## Goal

Relocate the scripted-pi harness (registry, entry scripts, session builder,
fixture data) out of `test/` into `src/daemon/pi/harness/`, so production code
never imports from `test/` and a renamed fixture touches only `src/`.

## Blockers

- **None** — independent of all other tickets; safe to run at any time.

## Files

**Move (`git mv`):**
- `test/core/fixtures.ts` → `src/daemon/pi/harness/fixtures.ts` (registry:
  `FIXTURE_NAMES`, `FixtureName`, `FIXTURE_SCENARIOS`, `fixturePath`,
  `fakePiEntryPath`, `fakeSessionEntryPath`, `isFixtureName`)
- `test/core/fake-pi.ts` → `src/daemon/pi/harness/fake-pi.ts`
- `test/core/fake-session.ts` → `src/daemon/pi/harness/fake-session.ts`
- `test/core/fixtures/{happy,gate-fail,crash}.jsonl` →
  `src/daemon/pi/harness/fixtures/`
- `test/core/fixtures.test.ts` → `test/daemon/pi/harness.test.ts`
- `test/starter-kit/session-builder.ts` →
  `src/daemon/pi/harness/session-builder.ts`

**Production import rewrites:**
- `src/cli/index.ts:4` → `from "../daemon/pi/harness/fixtures.ts"` (uses
  `FIXTURE_NAMES`, `isFixtureName` at lines 78, 119, 154)
- `src/daemon/driver.ts:9–15` → `from "./pi/harness/fixtures.ts"`
  (`FIXTURE_SCENARIOS`, `fakePiEntryPath`, `fixturePath`, `isFixtureName`,
  type `FixtureName`)
- `src/daemon/server.ts:4` → `from "./pi/harness/fixtures.ts"` (`isFixtureName`
  at :162)
- `src/daemon/pi/fake-session-driver.ts:6` → `from "./harness/fixtures.ts"`
  (`fakeSessionEntryPath`); also fix the stale comment at :39 (still names
  `packages/core/test/fake-session.ts`)

**Test/script import rewrites:**
- `test/daemon/driver.test.ts:6` → `from "../../src/daemon/pi/harness/fixtures.ts"`
  (reads `fixturePath("happy")` at :120)
- `test/cli/e2e.test.ts:9` → `from "../../src/daemon/pi/harness/fixtures.ts"`
  (reads it at :124)
- `test/starter-kit/fixtures.test.ts:18` → `from
  "../../src/daemon/pi/harness/session-builder.ts"`
- `scripts/generate-fake-pi-sessions.ts:26` → `from
  "../src/daemon/pi/harness/session-builder.ts"`; fix the header comment (:3)

## Steps

1. **Create `src/daemon/pi/harness/`** and `git mv` the six files above.
   `fake-pi.ts`/`fake-session.ts` are self-contained entry scripts (arg-driven,
   no repo imports) — zero internal edits. `fixtures.ts` resolves `HERE` via
   `dirname(fileURLToPath(import.meta.url))`, so `fixturePath`/entry paths
   re-resolve automatically after the move.

2. **Why `src/daemon/pi/harness/` and not `src/harness/`**: ADR-0003 makes the
   daemon the sole owner of spawn. Both fake entry points are spawned by daemon
   code (`driver.ts:178` spawns `fake-pi.ts` for the T01a fixture path;
   `runner.ts:802` → `FakeSessionDriver` spawns `fake-session.ts`), and
   `FakeSessionDriver` already lives at `src/daemon/pi/`. Nesting under `pi/`
   keeps the fake next to its driver, and makes the daemon runtime-complete
   without `test/` (a bundled daemon can still `showrunner run happy`).

3. **Rewrite the four production importers** (`cli/index.ts`, `driver.ts`,
   `server.ts`, `fake-session-driver.ts`).

4. **Rewrite the three test/script importers** (`driver.test.ts`,
   `e2e.test.ts`, `fixtures.test.ts`, `generate-fake-pi-sessions.ts`).

5. **Fix the moved harness test** — `test/daemon/pi/harness.test.ts` line 169
   asserts `HERE.endsWith("/test/core/")`; change to the new home (e.g.
   `toEndWith("/src/daemon/pi/harness/")`). The other path assertions
   (`"/fixtures/happy.jsonl"`, `"/fake-pi.ts"`) pass unchanged.

6. **Move the fixture DATA, not just the registry.** The daemon reads the JSONL
   at runtime (`driver.ts:178`), so leaving it in `test/` preserves the inverted
   edge through `fixturePath()` path resolution — a data-only edge is still a
   runtime edge; killing it is the ticket's point.

7. **Regenerate the on-disk sessions**: `bun run gen:fixtures`; builders'
   output is logic-unchanged, so `src/starter-kit/blueprints/fake-pi/*.json`
   must show zero diff.

## Tests

```sh
bun test test/daemon/pi/harness.test.ts          # moved harness suite
bun test test/daemon/driver.test.ts test/cli/e2e.test.ts test/starter-kit/fixtures.test.ts   # re-pointed importers
bun test test/                                    # full suite (~315), must stay green
```

## Verification

- `tsc --noEmit` (tsconfig includes `src`, `test`, `scripts`; no path aliases,
  so the relative rewrites are type-checked).
- `bun test test/`.
- `bun run gen:fixtures` + `git diff --stat src/starter-kit/blueprints/fake-pi`
  → expect empty.
- `grep -rn "test/core\|test/starter-kit" src/ scripts/` → zero hits.

## Open decisions / risks

- **FIXTURE_NAMES sync**: the `as const` array stays the single source of
  truth; after the move a rename touches only `src/daemon/pi/harness/` (registry
  + JSONL) — no `test/` ripple. (`driver.ts:79`'s hardcoded error string
  "happy, gate-fail, crash" is pre-existing drift, not new — leave it.)
- **SHOWRUNNER_FAKE**: unaffected — `session-driver.ts` only selects driver
  kind; entry paths resolve via the moved registry's `import.meta.url`. No env
  changes.
- **Comment drift** in `fake-session-driver.ts:39` and the generate-script
  header — fix while touching.
- **`bun test test/` discovery**: the moved harness test stays under `test/`;
  `src/daemon/pi/harness/*.ts` are plain scripts, never test-globbed.
