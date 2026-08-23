# Context is strings; file paths are inlined as strings, not references

**Status**: accepted

A phase's agent needs context: repo facts, conventions, prior output. The two
candidate designs were (a) context-as-files — the agent is handed file paths
and reads what it needs, and (b) context-as-strings — the composed prompt
carries the content itself. Showrunner uses (b): every `context` entry is a
string; an entry that resolves to a readable file (exact path, no globs —
resolved against the run's cwd, then the agent module's dir) is inlined into
the prompt's `[Context]` section verbatim; anything else stays literal. The
§9.3 handoff does the same: the predecessor's accepted envelope and every file
it listed in `artifacts` are materialized into the next phase's `inputs/`, and
the prompt inlines each input file's path *and* contents.

Why strings:

- **The prompt is self-contained and replayable.** The raw record holds every
  prompt the agent saw; a file-path reference would make the record depend on
  the workspace's later state.
- **Fresh sessions rebuild the same context.** On resume (§12.3), pi rebuilds
  context from the session JSONL — inlined content is already there.
- **No path-resolution drift.** The agent never hunts for files; the harness
  resolved them at compose time.

The known cost — the **literal-vs-path collision** (§19) — is accepted
explicitly: a literal string that happens to match a real filepath is read as
a file, and there is no escape syntax. The rationale is that context entries
are authored by the blueprint, not by end users, so a mis-hit is a blueprint
bug caught in review, and an escape syntax would be a second language for a
rare case. Per-phase inlining also keeps prompt size proportional to what the
phase needs, and `readHandoffInputs` walks the materialized inputs sorted and
deterministic (§9.3).
