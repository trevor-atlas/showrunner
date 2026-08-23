# Showrunner

Showrunner is an agent orchestration tool: it runs blueprints — plays of phases, each executing a configured agent against a local pi harness — records every event into SQLite for a live dashboard, and corrects or pauses agents based on typed envelopes and gates. Its identity is observability: if you cannot measure your agents, you cannot improve them.

## Language

**Blueprint**:
A TypeScript module defining a play of phases for a task, including their gates, budgets, and wiring.
_Avoid_: workflow, pipeline, playbook

**Agent**:
A named TypeScript definition of context, model, prompt, and tools. A reusable doer, purpose-built for one kind of job, with no output contract of its own.
_Avoid_: worker, actor

**Phase**:
One step in a blueprint: which agent runs, what envelope contract it must satisfy, which gates must pass, the retry budget, and the optional `on_fail` wiring.
_Avoid_: step, stage

**Visit**:
One execution of a phase within a run. Corrections happen inside a visit; the loop guard counts visits, not corrections.
_Avoid_: attempt, iteration

**Gate**:
A function that checks an Envelope (and the workspace) and returns pass or violations. Rejection triggers a Correction; an exhausted budget triggers `on_fail` or a pause for human intervention.
_Avoid_: check, validator

**Envelope**:
The typed JSON output of one agent invocation: a flexible base (summary, artifacts, notes, optional blocked) extended by a zod schema the phase declares. The same agent can serve phases with different output contracts. Envelopes pass information between phases; context transfers in files. Whether the work succeeded is determined by the gates, never by the agent's claim.
_Avoid_: result, response

**Context**:
The briefing material given to an agent: an array of strings, each either literal content or an exact filepath the harness reads and inlines into the prompt at runtime. Distinct from context_handoff, which carries the output handoff between phases.
_Avoid_: inputs, attachments

**Correction**:
One re-prompt of the same agent session, naming exactly what was wrong. Nothing restarts; a correction costs one message.
_Avoid_: retry

**Steering**:
Human intervention in a live agent session (pi's rpc `steer`), delivered between the agent's turns. Distinct from a Correction, which the harness issues automatically.
_Avoid_: nudge, interrupt

**Run**:
One execution of a blueprint; the entity the dashboard lists. "Session" is reserved for pi's session concept, so the schema's top-level table is `runs`.
_Avoid_: session, execution

**Agent Session**:
One pi invocation of one agent within a phase, keyed by a pi session id that can be continued.
_Avoid_: —

**context_handoff**:
The filesystem channel between phases: reference files agents write, and the inputs the harness materializes for them to read. Context transfers in code, not in conversation.
_Avoid_: scratch space

**on_fail**:
The phase a gate's exhausted budget branches to, letting blueprints loop by configuration rather than syntax.
_Avoid_: fallback, error handler
