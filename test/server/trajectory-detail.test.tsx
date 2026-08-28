/**
 * #86: the Trajectory tab's drill-in DETAIL SIDEBAR, driven through its PUBLIC
 * seams under happy-dom. Two seams:
 *
 *   - the pure <TrajectoryDetail entry onClose> — its `kind · Turn N · Step M`
 *     header and the four switchable sub-tabs (Summary / Payload / Result /
 *     Timing), where a tool surfaces args / result / ts+duration and a message
 *     surfaces its text with an n/a result and "not available" timing;
 *   - the <TrajectoryPanel> that owns selection — clicking a feed row opens the
 *     sidebar for THAT entry (row marked), selecting another row updates it,
 *     and the close control returns to the feed-only view.
 *
 * Structure mirrors trajectory-swimlane.test.tsx (the house DOM style).
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";

import { ensureDom, teardownDom } from "./dom-harness.ts";

ensureDom();
afterAll(teardownDom);

import { render, type RenderResult } from "remix/ui/test";

import type { TrajectoryEntry, TrajectoryView } from "../../src/server/contract.ts";
import { TrajectoryDetail } from "../../src/server/ui/public/trajectory/trajectory-detail.tsx";
import { TrajectoryPanel } from "../../src/server/ui/public/trajectory/trajectory-panel.tsx";

function msg(seq: number, role: "user" | "assistant", text = "hello"): TrajectoryEntry {
  return { seq, lane: role === "user" ? "input" : "model", turn: 1, step: seq, role, text };
}

function tool(seq: number, over: Partial<Extract<TrajectoryEntry, { lane: "tools" }>> = {}): TrajectoryEntry {
  return {
    seq,
    lane: "tools",
    turn: 2,
    step: seq,
    tool: "bash",
    tool_call_id: "call-1",
    args: { path: "src/x.ts" },
    result: "exit 0",
    ok: true,
    ts: "2024-01-02T03:04:05.000Z",
    duration_ms: 1234,
    ...over,
  };
}

function view(entries: TrajectoryEntry[]): TrajectoryView {
  return { run_id: "r1", phase: "alpha", phase_id: "p-alpha", entries, truncated: false };
}

let active: RenderResult | null = null;
function mount(node: Parameters<typeof render>[0]): RenderResult {
  active = render(node);
  return active;
}
afterEach(() => {
  active?.cleanup();
  active = null;
});

const subtabBtn = (r: RenderResult, name: string): HTMLElement =>
  r.$(`[data-testid='trajectory-detail-subtab'][data-subtab='${name}']`) as HTMLElement;

const panel = (r: RenderResult): Element | null => r.$("[data-testid='trajectory-detail-panel']");

const clickSubtab = async (r: RenderResult, name: string): Promise<void> => {
  await r.act(() => subtabBtn(r, name).click());
};

describe("TrajectoryDetail (#86) — header + Summary/Payload/Result/Timing sub-tabs", () => {
  it("renders a kind · Turn N · Step M header for a tool entry", () => {
    const r = mount(<TrajectoryDetail entry={tool(3)} onClose={() => {}} />);
    const header = r.$("[data-testid='trajectory-detail-header']");
    expect(header?.textContent).toContain("TOOL");
    expect(header?.textContent).toContain("Turn 2");
    expect(header?.textContent).toContain("Step 3");
  });

  it("derives the kind from the message role", () => {
    const rUser = mount(<TrajectoryDetail entry={msg(1, "user")} onClose={() => {}} />);
    expect(rUser.$("[data-testid='trajectory-detail-header']")?.textContent).toContain("USER");
    rUser.cleanup();
    const rAsst = mount(<TrajectoryDetail entry={msg(2, "assistant")} onClose={() => {}} />);
    expect(rAsst.$("[data-testid='trajectory-detail-header']")?.textContent).toContain("ASSISTANT");
  });

  it("opens on the Summary sub-tab", () => {
    const r = mount(<TrajectoryDetail entry={tool(3)} onClose={() => {}} />);
    expect(panel(r)?.getAttribute("data-subtab")).toBe("summary");
  });

  it("Payload shows a tool's args as pretty json", async () => {
    const r = mount(<TrajectoryDetail entry={tool(3)} onClose={() => {}} />);
    await clickSubtab(r, "payload");
    expect(panel(r)?.getAttribute("data-subtab")).toBe("payload");
    expect(panel(r)?.textContent).toContain("src/x.ts");
  });

  it("Payload shows a message's text content", async () => {
    const r = mount(<TrajectoryDetail entry={msg(1, "user", "do the thing")} onClose={() => {}} />);
    await clickSubtab(r, "payload");
    expect(panel(r)?.textContent).toContain("do the thing");
  });

  it("Result shows a tool's result snippet", async () => {
    const r = mount(<TrajectoryDetail entry={tool(3, { result: "exit 42" })} onClose={() => {}} />);
    await clickSubtab(r, "result");
    expect(panel(r)?.textContent).toContain("exit 42");
  });

  it("Result reads n/a for a message entry", async () => {
    const r = mount(<TrajectoryDetail entry={msg(1, "assistant")} onClose={() => {}} />);
    await clickSubtab(r, "result");
    expect(panel(r)?.textContent?.toLowerCase()).toContain("n/a");
  });

  it("Timing shows a tool's ts + duration when known", async () => {
    const r = mount(<TrajectoryDetail entry={tool(3)} onClose={() => {}} />);
    await clickSubtab(r, "timing");
    expect(panel(r)?.textContent).toContain("2024-01-02T03:04:05.000Z");
    expect(panel(r)?.textContent).toContain("1234");
  });

  it("Timing reads 'not available' for a tool with no correlated timing", async () => {
    const r = mount(<TrajectoryDetail entry={tool(3, { ts: null, duration_ms: null })} onClose={() => {}} />);
    await clickSubtab(r, "timing");
    expect(panel(r)?.textContent?.toLowerCase()).toContain("not available");
  });

  it("Timing reads 'not available' for a message entry", async () => {
    const r = mount(<TrajectoryDetail entry={msg(1, "user")} onClose={() => {}} />);
    await clickSubtab(r, "timing");
    expect(panel(r)?.textContent?.toLowerCase()).toContain("not available");
  });

  it("fires onClose from the close control", async () => {
    let closed = 0;
    const r = mount(<TrajectoryDetail entry={tool(3)} onClose={() => (closed += 1)} />);
    await r.act(() => (r.$("[data-testid='trajectory-detail-close']") as HTMLElement).click());
    expect(closed).toBe(1);
  });
});

// ── the panel that owns selection (feed row → sidebar) ───────────────────────

const rows = (r: RenderResult): HTMLElement[] =>
  [...r.$$("[data-testid='trajectory-row']")] as HTMLElement[];

const rowBySeq = (r: RenderResult, seq: number): HTMLElement =>
  r.$(`[data-testid='trajectory-row'][data-seq='${seq}']`) as HTMLElement;

const clickRow = async (r: RenderResult, seq: number): Promise<void> => {
  await r.act(() => rowBySeq(r, seq).click());
};

describe("TrajectoryPanel (#86) — feed row opens the drill-in sidebar", () => {
  const full = () => view([msg(1, "user", "do the thing"), msg(2, "assistant", "on it"), tool(3)]);

  it("has no sidebar until a row is clicked", () => {
    const r = mount(<TrajectoryPanel view={full()} loading={false} error={null} />);
    expect(r.$("[data-testid='trajectory-detail']")).toBeNull();
  });

  it("clicking a feed row opens the sidebar for that entry and marks the row", async () => {
    const r = mount(<TrajectoryPanel view={full()} loading={false} error={null} />);
    await clickRow(r, 3);
    expect(r.$("[data-testid='trajectory-detail']")).not.toBeNull();
    const header = r.$("[data-testid='trajectory-detail-header']");
    expect(header?.textContent).toContain("TOOL");
    expect(header?.textContent).toContain("Step 3");
    expect(rowBySeq(r, 3).getAttribute("data-selected")).toBe("true");
    // the other rows are not marked
    expect(rowBySeq(r, 1).getAttribute("data-selected")).toBe("false");
  });

  it("selecting another row updates the sidebar", async () => {
    const r = mount(<TrajectoryPanel view={full()} loading={false} error={null} />);
    await clickRow(r, 3);
    expect(r.$("[data-testid='trajectory-detail-header']")?.textContent).toContain("TOOL");
    await clickRow(r, 1);
    const header = r.$("[data-testid='trajectory-detail-header']");
    expect(header?.textContent).toContain("USER");
    expect(header?.textContent).toContain("Step 1");
    expect(rowBySeq(r, 1).getAttribute("data-selected")).toBe("true");
    expect(rowBySeq(r, 3).getAttribute("data-selected")).toBe("false");
  });

  it("closing the sidebar returns to the feed-only view", async () => {
    const r = mount(<TrajectoryPanel view={full()} loading={false} error={null} />);
    await clickRow(r, 3);
    expect(r.$("[data-testid='trajectory-detail']")).not.toBeNull();
    await r.act(() => (r.$("[data-testid='trajectory-detail-close']") as HTMLElement).click());
    expect(r.$("[data-testid='trajectory-detail']")).toBeNull();
    // the feed is still shown
    expect(rows(r).length).toBe(3);
  });
});
