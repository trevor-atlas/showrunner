# envelope-parse

> GitHub-issue-ready. Title: **One envelope-parsing adapter in the UI — parseEnvelope/parseViolations deduplicated**

## Goal

Extract the three duplicated JSON-column→shape adapters into ONE shared UI
module (`src/ui/app/ui/lib/envelope-parse.ts`), the UI's single adapter to the
daemon's storage format.

## Blockers

- **None** — independent; safe to run at any time.

## Files

- `src/ui/app/ui/lib/envelope-parse.ts` — **new** shared module (new `lib/` dir
  under `src/ui/app/ui/`).
- `src/ui/app/ui/public/timeline-panel.tsx` — shed local copies.
- `src/ui/app/ui/phase-drill-in/envelope-card.tsx` — shed local copies.
- `src/ui/app/ui/phase-drill-in/gates-card.tsx` — shed local copy.
- `test/ui/envelope-parse.test.ts` — **new** unit suite.

## Steps

1. **Create `src/ui/app/ui/lib/envelope-parse.ts`.** Export `interface
   ParsedEnvelope { summary; notes; artifacts; blocked; blockedReason }`,
   `parseEnvelope(text: string): ParsedEnvelope | null`, and `parseViolations(
   violations: string): string[]`, copying bodies **verbatim** from
   `timeline-panel.tsx:321-362` (incl. the private `str` helper). Keep the module
   **import-free** (no daemon types) so it stays valid in the browser module
   graph (the constraint timeline-panel's header comment describes). Document the
   input contract in a header comment: `violations` is a JSON-array-of-strings
   TEXT column, default `'[]'` (`db.ts:83,108,195-196`; written via
   `JSON.stringify` at `envelope-runner.ts:115,170,217`); `text` is the raw
   envelope JSON string. Server passes columns through untouched
   (`apiPhaseEnvelopes`/`apiPhaseGates`, `server.ts:624-647`).

2. **timeline-panel.tsx** — delete local `parseViolations` (:321),
   `ParsedEnvelope` (:330), `parseEnvelope` (:339), `str` (:360); add `import {
   parseEnvelope, parseViolations, type ParsedEnvelope } from
   "../lib/envelope-parse.ts";`. Call sites (:255,257,269,282,291,381,383) are
   unchanged.

3. **envelope-card.tsx** — delete local `parseViolations` (:120),
   `parseEnvelope` (:139), `ParsedEnvelope` (:156), `str` (:164); import from
   `../lib/envelope-parse.ts`. Call sites (:34,61,63,87,109,169) unchanged; keep
   `prettyJson` and `acceptedEnvelope` local.

4. **gates-card.tsx** — delete local `parseViolations` (:61); import from
   `../lib/envelope-parse.ts`.

5. **Test suite** — `test/ui/envelope-parse.test.ts` following the pure-module
   convention of `test/ui/timeline-model.test.ts` (bun:test, no DOM).

## Tests

- `bun test test/ui/envelope-parse.test.ts` — cover: `[]`/empty/valid arrays;
  non-string entries filtered; malformed JSON → `[]`; non-array JSON → `[]`;
  parseEnvelope happy path (summary, notes_for_next_agent, artifacts,
  blocked/blocked_reason); missing/typed-wrong fields → defaults;
  non-object/unparseable → `null`.
- Integration safety net (asserts violations/envelope text through SSR):
  `bun test test/ui/run-detail.test.ts test/ui/phase-drill-in.test.ts`
  (run-detail.test.ts:567–574; phase-drill-in.test.ts:130–152).

```sh
bun test test/ui/envelope-parse.test.ts
bun test test/ui/run-detail.test.ts test/ui/phase-drill-in.test.ts
bun test test/ui/
```

## Verification

1. `tsc --noEmit`
2. `bun test test/ui/envelope-parse.test.ts`
3. `bun test test/ui/run-detail.test.ts test/ui/phase-drill-in.test.ts`
4. `bun test test/ui/` (whole UI suite)

## Open decisions / risks

- **No format divergence:** all copies are byte-identical (verified; only the
  `export` keyword differs) — pure dedup, no behavior reconciliation. Existing
  exports (`timeline-panel.tsx:321,339`, `envelope-card.tsx:120`) have **zero
  external importers** (grep confirms), so dropping them is safe.
- **Out-of-scope render asymmetry (do NOT change):** timeline-panel.tsx:255
  gates envelope violations on `e.valid === 0`, envelope-card.tsx:61 on `e.valid
  === 1` — the daemon writes violations only on valid=1 gate-rejected rows
  (`envelope-runner.ts:114-115`) and `'[]'` on valid=0 (:170), yet
  run-detail.test.ts:229 seeds valid=0+violations. gates-card.tsx:38 pre-checks
  `g.violations !== "[]"` string-compare; timeline-panel.tsx:381 uses
  `parseViolations(...).length > 0`. Consolidation makes these divergences
  visible in one place; fixing them is a separate ticket.
- **Path choice:** `ui/lib/` is new (only `ui/format.ts` and
  `ui/public/format.ts` exist flat); alternative `src/ui/app/ui/envelope-parse.ts`
  avoids a new dir — either works since the module is import-free.
