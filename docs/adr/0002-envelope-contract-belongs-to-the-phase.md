# The envelope contract belongs to the phase, not the agent

**Status**: accepted

The original spec said "each agent definition includes their envelope," and an early sketch declared the schema inside `defineAgent`. That made the agent un-reusable: an agent is a doer (context, model, prompt, tools), and its output contract is set by whoever uses it. The envelope schema therefore lives on the phase — the phase declares the zod schema (extending the shared `EnvelopeBase`) that the agent's final JSON is parsed against, and the daemon renders that schema into the agent's prompt so it knows what to return. This is a direct consequence of ADR-0001's reusability principle: an agent has no output contract of its own.
