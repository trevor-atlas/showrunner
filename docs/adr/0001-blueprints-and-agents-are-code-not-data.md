# Blueprints and agents are code, not data

**Status**: accepted

The original spec said "one YAML file sets the core four for every agent." During design this was reversed: blueprints and agents are TypeScript modules (`defineBlueprint` / `defineAgent`), validated at runtime with zod, and gates are plain functions in the same module. The trade-off: declarative, hand-editable data files are replaced by type-checked code — correctness verification falls out of the compiler, shared logic is importable, and the whole system has exactly one language and one validation story. The cost: editing a blueprint is editing code, not editing a file; non-developers lose the ability to tweak config by hand.

**Considered**: YAML agent definitions + a declarative blueprint DSL (the original spec). Rejected because custom gates and `on_fail` wiring would force a mini-language and un-type-safe indirection.
