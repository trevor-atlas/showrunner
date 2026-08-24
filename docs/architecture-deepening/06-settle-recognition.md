# settle-recognition

> GitHub-issue-ready. Title: **One owner for "what is an agent_settled" — the raw-line classifier**

## Goal

Extract the duplicated `JSON.parse` + `type === "agent_settled"` recognition
(runner.ts:763, tracer.ts:134, pi-session.ts:269, fake-session-driver.ts:262 —
plus a fifth consumer, driver.ts:222 reading `tracer.hasSettled`) into one
module; every site becomes a caller, and the two settle latches keep their
semantics by construction.

## Blockers

- **None** — independent; safe to run at any time.

## Files

- `src/daemon/pi/raw-lines.ts` — **new**: the classifier.
- `src/daemon/pi/index.ts` — re-export the classifier (runner.ts already imports
  from `./pi/index.ts`).
- `src/daemon/pi/pi-session.ts` — `handleLine` (:255–276).
- `src/daemon/pi/fake-session-driver.ts` — `handleLine` (:250–267).
- `src/daemon/tracer.ts` — `onLine` (:112–140); `hasSettled` (:104) stays.
- `src/daemon/runner.ts` — (:762–776, :936).
- `test/daemon/raw-lines.test.ts` — **new**.

## Steps

1. **Create `src/daemon/pi/raw-lines.ts`.** Type-string classifier (NOT
   zod-payload validation — keeps behavior byte-identical; payload validation
   stays in the tracer handlers, so the classifier's acceptance can't drift from
   the tracer's). Import `MACHINERY_EVENT_TYPES` from `../../core/index.ts` so
   the vocabulary table is single-sourced:

   ```ts
   export type RawLineKind =
     | "agent_start" | "agent_end" | "agent_settled"
     | "turn_start" | "turn_end"
     | "message_start" | "message_update" | "message_end"
     | "tool_execution_start" | "tool_execution_update" | "tool_execution_end"
     | "response" | "machinery" | "unknown";
   export interface ClassifiedLine { kind: RawLineKind; evt?: Record<string, unknown>; }
   export function classifyLine(line: string): ClassifiedLine; // "unknown" for non-JSON / non-object / unrecognized
   export function isSettledLine(line: string): boolean; // classifyLine(line).kind === "agent_settled"
   ```

   The literal `"agent_settled"` appears exactly once (in the kind table). No
   throw on malformed input.

2. **pi-session.ts**: in `handleLine`, keep `this.onLine(line, final)` first,
   then `const c = classifyLine(line); if (c.kind === "response")
   this.handleResponse(c.evt!); else if (c.kind === "agent_settled") {
   this.settleSeq += 1; ... }` — the G1 latch logic and comment unchanged.

3. **fake-session-driver.ts**: same, minus response (only `agent_settled`
   latches `settleSeq`).

4. **tracer.ts `onLine`**: replace `JSON.parse` + `switch (evt.type)` with
   `const { kind, evt } = classifyLine(raw); if (kind === "unknown") return;`
   then `switch (kind)` over the same six cases (tool start/update/end,
   `agent_settled` → `this.settled = true`, message_update/message_end/turn_end
   → `snapshotUsage`). Handlers untouched; `rawAppend` stays first.

5. **runner.ts**: delete local `isSettledLine` (:763–770); keep `settleCount`
   incremented via imported `isSettledLine` in `feedLine` (:773–776); :936 stays
   `outcome.kind !== "crash" && settleCount > 0`.

6. **The two latches stay separate** — different lifecycles, same recognition:
   `tracer.settled`/`hasSettled` answers "did this stream ever settle"
   (consumed by driver.ts:222 and as onEnd's default); runner's `settleCount`
   answers "was the last awaited settle a real line" — the `outcome.kind !==
   "crash"` conjunction is load-bearing (a correction settles turn N, stream
   dies before turn N+1: tracer's latch would be true, visit is a crash). Both
   now derive recognition from the classifier, so semantics can't diverge.
   (`settleCount > 0` is implied by non-crash today — redundant-but-defensive;
   do not remove, it's the G1 belt.)

**Boundary decision:** move the whole classifier, not settle-only — the tracer's
onLine switch is the vocabulary's second owner; extracting settle alone leaves
tool/usage/response recognition duplicated. The refactor is mechanical and
test-pinned; payload folding stays put.

## Tests

- **New `test/daemon/raw-lines.test.ts`**: settle positives (`{"type":
  "agent_settled"}` and the real shape `{"type":"agent_settled","sessionId":
  "x","messageCount":4}`);  negatives (`agent_end` with/without `willRetry`
  — never settle); junk (`"not json"`, `42`, `null`, `[]`, `""` → unknown,
  false); every vocabulary type → its kind (minimal payloads, incl. delta-only
  `tool_execution_update`/`message_update`); a machinery type (`auto_retry`) →
  `machinery`; unknown type → `unknown`; recognized kinds carry `evt`.
- **No existing suite edits** — existing suites are the regression net, must
  pass unchanged.

```sh
bun test test/daemon/raw-lines.test.ts
bun test test/daemon/tracer.test.ts test/daemon/pi-session.test.ts test/daemon/runner.test.ts test/daemon/driver.test.ts
bun test test/
```

## Verification

1. `tsc --noEmit` clean.
2. The four owner suites green (esp. tracer.test.ts:150–171 settle cases,
   runner.test.ts:337 two-settles-one-stream, runner.test.ts:1443
   dies-before-settle, pi-session.test.ts:234 EOF-rejects-waiter — the G1
   window).
3. Full `bun test test/` green.

## Open decisions / risks

- **Delta-only updates**: the classifier is type-string-only, so partial-payload
  updates classify correctly; handler zod leniency is untouched
  (`RawToolExecutionUpdate` still requires `partialResult` — same skip as
  today).
- ** willRetry**: do not "improve" — `agent_end` never counts as done; pin
  with tests.
- **G1 regression**: driver latch logic untouched; only recognition swapped. The
  ack→register window tests are the net.
- **Double-parse**: none — `classifyLine` returns `evt`, callers drop their own
  `JSON.parse`.
- **Machinery tag**: imports `MACHINERY_EVENT_TYPES`, making it live; fallback
  is collapsing machinery into `unknown` if reviewers want a slimmer diff.
