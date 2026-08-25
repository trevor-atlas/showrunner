/**
 * Render smoke tests for the browser-safe phase cards (issue #37) — mount each
 * card with remix/ui/test `render()` under the happy-dom harness and assert the
 * labels/rows it renders and that the verbose regions (prompt, raw JSON,
 * sessions, FINDINGS.md, input contents) are collapsed by default via native
 * `<details>`. Structure mirrors components.test.tsx (#36).
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";

import { ensureDom, teardownDom } from "./dom-harness.ts";

ensureDom();
afterAll(teardownDom);

import { render, type RenderResult } from "remix/ui/test";

import type { AgentSessionRow, EnvelopeRow, GateResultWithOverride } from "../../src/server/repository/db.ts";
import type { TimelinePhase } from "../../src/server/contract.ts";
import type { SnapshotPhase } from "../../src/server/lib/blueprint-snapshot.ts";
import type { ContextEntry } from "../../src/server/lib/phase-data.ts";

import { AgentCard } from "../../src/server/ui/public/agent-card.tsx";
import { PhaseConfigCard } from "../../src/server/ui/public/phase-config-card.tsx";
import { InputsCard } from "../../src/server/ui/public/inputs-card.tsx";
import { OutputsCard } from "../../src/server/ui/public/outputs-card.tsx";
import { EnvelopeCard } from "../../src/server/ui/public/envelope-card.tsx";
import { GatesCard } from "../../src/server/ui/public/gates-card.tsx";
import { SpendCard } from "../../src/server/ui/public/spend-card.tsx";
import { SessionsCard } from "../../src/server/ui/public/sessions-card.tsx";
import { VisitHistoryCard } from "../../src/server/ui/public/visit-history-card.tsx";

let active: RenderResult | null = null;
function mount(node: Parameters<typeof render>[0]): RenderResult {
  active = render(node);
  return active;
}
afterEach(() => {
  active?.cleanup();
  active = null;
});

// ── fixtures ─────────────────────────────────────────────────────────────────

function snapshotPhase(over: Partial<SnapshotPhase> = {}): SnapshotPhase {
  return {
    name: "build",
    agent: { name: "builder", model: "fake-pi", prompt: "build the thing", tools: ["read", "write"], context: ["README.md", "be concise"] },
    budget: 3,
    require_approval: false,
    on_fail: "review",
    gates: ["lint", "tests"],
    envelope: "{\n  summary: string — what you did\n}",
    ...over,
  };
}

function contextEntries(): ContextEntry[] {
  return [
    { raw: "README.md", kind: "inlined-file", entry: "README.md (inlined)" },
    { raw: "be concise", kind: "literal", entry: '"be concise"' },
  ];
}

function envelope(over: Partial<EnvelopeRow> = {}): EnvelopeRow {
  return {
    id: "e1",
    run_id: "r1",
    phase_id: "p1",
    visit: 1,
    attempt: 0,
    json: JSON.stringify({ summary: "did it", notes_for_next_agent: "carry on", artifacts: ["out.md"] }),
    source: "outputs/envelope.json",
    validated_at: "2024-01-01T14:02:11.000Z",
    valid: 1,
    violations: "[]",
    correction: null,
    ...over,
  };
}

function session(over: Partial<AgentSessionRow> = {}): AgentSessionRow {
  return {
    id: "s1",
    run_id: "r1",
    phase_id: "p1",
    pi_session_id: "pi-abc",
    visit: 1,
    pid: 4242,
    started_at: "2024-01-01T14:00:00.000Z",
    ended_at: "2024-01-01T14:05:00.000Z",
    ...over,
  };
}

function timelinePhase(over: Partial<TimelinePhase> = {}): TimelinePhase {
  return {
    phase_id: "p1",
    name: "build",
    agent: "builder",
    status: "success",
    visits: 2,
    budget: 3,
    spend_usd: 0.1,
    estimated_spend_usd: 0,
    segments: [
      {
        visit: 1,
        started_at: "2024-01-01T14:00:00.000Z",
        ended_at: "2024-01-01T14:04:00.000Z",
        outcome: "failed",
        corrections: 1,
        envelope_attempts: 2,
        cause: { kind: "flow" },
      },
      {
        visit: 2,
        started_at: "2024-01-01T14:05:00.000Z",
        ended_at: "2024-01-01T14:09:00.000Z",
        outcome: "success",
        corrections: 0,
        envelope_attempts: 1,
        cause: { kind: "on_fail", from_phase: "review", from_visit: 1 },
      },
    ],
    ...over,
  };
}

// ── AGENT ────────────────────────────────────────────────────────────────────

describe("AgentCard", () => {
  it("renders name/model summary, tools, context entries, and a collapsed prompt", () => {
    const r = mount(<AgentCard phase={snapshotPhase()} context={contextEntries()} />);
    expect(r.$("h2")?.textContent).toBe("AGENT");
    expect(r.container.textContent).toContain("agent: builder");
    expect(r.container.textContent).toContain("model: fake-pi");
    expect(r.$("[data-agent-tools]")?.textContent).toBe("read, write");
    const context = r.$$("[data-agent-context] li");
    expect(context.length).toBe(2);
    expect(context[0]?.getAttribute("data-context-kind")).toBe("inlined-file");
    expect(context[0]?.textContent).toBe("README.md (inlined)");
    // prompt is collapsed by default, but its text is still in the markup
    // (the inner collapsible, not the section shell which is also a <details>)
    const details = r.$("details:not([data-component='card'])") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("prompt");
    expect(r.$("pre")?.textContent).toBe("build the thing");
  });

  it("renders the no-snapshot state when phase is null", () => {
    const r = mount(<AgentCard phase={null} context={[]} />);
    expect(r.$("[data-agent-empty]")).not.toBeNull();
  });
});

// ── PHASE CONFIG ───────────────────────────────────────────────────────────

describe("PhaseConfigCard", () => {
  it("renders policy rows and a collapsed envelope contract string", () => {
    const r = mount(<PhaseConfigCard phase={snapshotPhase()} />);
    expect(r.$("h2")?.textContent).toBe("PHASE CONFIG");
    expect(r.$("[data-config-budget]")?.textContent).toBe("3");
    expect(r.$("[data-config-approval]")?.textContent).toBe("not required");
    expect(r.$("[data-config-onfail]")?.textContent).toBe("review");
    expect(r.$("[data-config-gates]")?.textContent).toBe("lint, tests");
    const details = r.$("details:not([data-component='card'])") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("envelope contract");
    expect(r.$("pre")?.textContent).toContain("summary: string");
  });

  it("renders the no-snapshot state when phase is null", () => {
    const r = mount(<PhaseConfigCard phase={null} />);
    expect(r.$("[data-config-empty]")).not.toBeNull();
  });
});

// ── INPUTS ───────────────────────────────────────────────────────────────────

describe("InputsCard", () => {
  it("lists input files with collapsed contents and the truncated affordance", () => {
    const r = mount(
      <InputsCard
        files={[
          { rel: "a.txt", contents: "hello", truncated: false },
          { rel: "big.txt", contents: "clipped…", truncated: true },
        ]}
        isFirst={false}
      />,
    );
    const files = r.$$("[data-input-file]");
    expect(files.length).toBe(2);
    expect(r.$$("[data-input-rel]")[0]?.textContent).toBe("a.txt");
    expect(r.$("[data-input-truncated]")).not.toBeNull();
    // each file's contents live inside a collapsed <details> (the inner
    // collapsibles, not the section shell which is also a <details>)
    const details = r.$$("details:not([data-component='card'])") as unknown as HTMLDetailsElement[];
    expect(details[0]?.open).toBe(false);
    expect(r.container.textContent).toContain("hello");
  });

  it("renders the first-phase none state", () => {
    const r = mount(<InputsCard files={[]} isFirst={true} />);
    expect(r.$("[data-inputs-none]")).not.toBeNull();
  });
});

// ── OUTPUTS ──────────────────────────────────────────────────────────────────

describe("OutputsCard", () => {
  it("lists files, reconciles artifacts (present/missing), and collapses FINDINGS.md", () => {
    const r = mount(
      <OutputsCard
        files={["out.md"]}
        findingsMd={"# findings\nall good"}
        envelopes={[envelope({ json: JSON.stringify({ artifacts: ["out.md", "ghost.md"] }) })]}
      />,
    );
    expect(r.$("h2")?.textContent).toBe("OUTPUTS");
    expect(r.$$("[data-outputs-files] li")[0]?.textContent).toBe("out.md");
    const present = r.$("[data-artifact='out.md']");
    const missing = r.$("[data-artifact='ghost.md']");
    expect(present?.getAttribute("data-artifact-present")).toBe("1");
    expect(missing?.getAttribute("data-artifact-present")).toBe("0");
    const details = r.$("details:not([data-component='card'])") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("FINDINGS.md");
  });

  it("omits the FINDINGS.md region when none was written", () => {
    const r = mount(<OutputsCard files={[]} findingsMd={null} envelopes={[]} />);
    // no inner collapsible (the section shell is a <details>, so scope past it)
    expect(r.$("details:not([data-component='card'])")).toBeNull();
    expect(r.$("[data-outputs-empty]")).not.toBeNull();
  });
});

// ── ENVELOPE ─────────────────────────────────────────────────────────────────

describe("EnvelopeCard", () => {
  it("renders attempt rows, the accepted surface, and a collapsed raw JSON view", () => {
    const r = mount(<EnvelopeCard envelopes={[envelope()]} />);
    expect(r.$("h2")?.textContent).toBe("ENVELOPE");
    expect(r.$$("[data-envelope-attempt]").length).toBe(1);
    expect(r.$("[data-envelope-summary]")?.textContent).toBe("did it");
    expect(r.$("[data-envelope-handoff]")?.textContent).toBe("carry on");
    // the accepted surface never renders artifact rows (OUTPUTS owns those);
    // "artifacts" only appears inside the collapsed raw JSON, not the surface
    expect(r.$("[data-envelope-surface]")?.textContent).not.toContain("artifacts");
    const details = r.$("details:not([data-component='card'])") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("view JSON");
  });

  it("renders the empty state with no attempts", () => {
    const r = mount(<EnvelopeCard envelopes={[]} />);
    expect(r.$("[data-envelope-empty]")).not.toBeNull();
  });
});

// ── GATES ────────────────────────────────────────────────────────────────────

function gate(over: Partial<GateResultWithOverride> = {}): GateResultWithOverride {
  return {
    id: "g1",
    envelope_id: "e1",
    gate: "lint",
    pass: 1,
    violations: "[]",
    ran_at: "2024-01-01T14:03:00.000Z",
    overridden: 0,
    override_by: null,
    override_reason: null,
    overridden_at: null,
    ...over,
  };
}

describe("GatesCard", () => {
  it("renders pass/fail rows, violations, and an override badge", () => {
    const r = mount(
      <GatesCard
        gates={[
          gate(),
          gate({
            id: "g2",
            gate: "tests",
            pass: 0,
            violations: '["a test failed"]',
            overridden: 1,
            override_by: "alice",
            override_reason: "flaky",
            overridden_at: "2024-01-01T14:06:00.000Z",
          }),
        ]}
      />,
    );
    expect(r.$$("[data-gate-row]").length).toBe(2);
    expect(r.$("[data-gate='tests']")?.getAttribute("data-gate-pass")).toBe("0");
    expect(r.$("[data-gate-violations]")?.textContent).toBe("a test failed");
    const override = r.$("[data-gate-overridden]");
    expect(override?.textContent).toContain("alice");
    expect(override?.textContent).toContain("flaky");
  });
});

// ── SPEND ────────────────────────────────────────────────────────────────────

describe("SpendCard", () => {
  it("renders usd + tokens and NO truncated affordance", () => {
    const r = mount(
      <SpendCard tokensIn={12480} tokensOut={900} cacheRead={10} cacheWrite={5} spendUsd={0.42} estimatedUsd={0.1} />,
    );
    expect(r.$("h2")?.textContent).toBe("SPEND");
    expect(r.container.textContent).toContain("tokens in 12,480");
    expect(r.$("[data-spend-usd]")?.textContent).toBe("usd $0.42");
    expect(r.$("[data-spend-est]")?.textContent).toContain("$0.10");
    // #29 removed the sweep — there is no spend-truncated flag
    expect(r.$("[data-spend-truncated]")).toBeNull();
  });

  it("omits the estimate marker when there is none", () => {
    const r = mount(<SpendCard tokensIn={1} tokensOut={0} cacheRead={0} cacheWrite={0} spendUsd={0.01} estimatedUsd={0} />);
    expect(r.$("[data-spend-est]")).toBeNull();
  });
});

// ── SESSIONS ─────────────────────────────────────────────────────────────────

describe("SessionsCard", () => {
  it("is collapsed by default and renders the pid column per visit", () => {
    const r = mount(<SessionsCard sessions={[session(), session({ id: "s2", visit: 2, pid: 5151, pi_session_id: "pi-def" })]} />);
    // SESSIONS is now a flat collapsible section (the shared card shell)
    const details = r.$("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(r.$("h2")?.textContent).toBe("SESSIONS");
    expect(details.textContent).toContain("2 sessions");
    const rows = r.$$("[data-session-row]");
    expect(rows.length).toBe(2);
    // sorted by visit; the pid column the panel lacks is present
    expect(r.$$("[data-session-pid]")[0]?.textContent).toBe("pid 4242");
    expect(r.$$("[data-session-pid]")[1]?.textContent).toBe("pid 5151");
  });

  it("renders the empty state with no sessions", () => {
    const r = mount(<SessionsCard sessions={[]} />);
    expect(r.$("[data-sessions-empty]")).not.toBeNull();
  });
});

// ── VISIT HISTORY ────────────────────────────────────────────────────────────

describe("VisitHistoryCard", () => {
  it("renders visits newest-first with cause narratives", () => {
    const r = mount(<VisitHistoryCard phase={timelinePhase()} />);
    expect(r.$("h2")?.textContent).toBe("VISIT HISTORY");
    const blocks = r.$$("[data-visit-block]");
    expect(blocks.length).toBe(2);
    // newest first: visit 2 (on_fail) leads
    expect(blocks[0]?.getAttribute("data-visit")).toBe("2");
    expect(r.$("[data-cause='on_fail']")?.textContent).toContain("failed its gates");
    expect(r.$("[data-cause-phase='review']")?.getAttribute("href")).toBe("?phase=review");
  });

  it("renders the empty state with no visits", () => {
    const r = mount(<VisitHistoryCard phase={timelinePhase({ segments: [] })} />);
    expect(r.$("[data-visits-empty]")).not.toBeNull();
  });
});
