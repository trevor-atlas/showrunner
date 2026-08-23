/**
 * An agent is a pure doer - no output contract of its own (ADR-0001, ADR-0002).
 * The output contract is declared by the phase that uses it.
 */
export interface Agent {
  name: string;
  /** from the replaceable model roster */
  model: string;
  prompt: string;
  /** bash, edit, read, grep, find, poll... */
  tools: string[];
  /** literal content or exact filepaths (spec §9) */
  context: string[];
}

/** Pass-through helper so agents read as definitions in a module. */
export function defineAgent(a: Agent): Agent {
  return a;
}
