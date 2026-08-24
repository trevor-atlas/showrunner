/**
 * Component render smoke tests (issue #36) — mount each browser-safe component
 * with remix/ui/test `render()` under the happy-dom harness and assert the
 * rendered DOM (structure, tokens-driven attributes, ARIA, and the wired
 * interactions). The chart components are asserted against the geometry their
 * pure models produce (the math itself is covered DOM-free in
 * charts-model.test.ts).
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";

import { ensureDom, teardownDom } from "./dom-harness.ts";

ensureDom();
afterAll(teardownDom);

import { render, type RenderResult } from "remix/ui/test";

import { Badge } from "../../src/ui/app/ui/public/components/badge.tsx";
import { Button } from "../../src/ui/app/ui/public/components/button.tsx";
import { Card } from "../../src/ui/app/ui/public/components/card.tsx";
import { Collapsible } from "../../src/ui/app/ui/public/components/collapsible.tsx";
import { IconButton } from "../../src/ui/app/ui/public/components/icon-button.tsx";
import { Input } from "../../src/ui/app/ui/public/components/input.tsx";
import { Kpi } from "../../src/ui/app/ui/public/components/kpi.tsx";
import { Select } from "../../src/ui/app/ui/public/components/select.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../src/ui/app/ui/public/components/table.tsx";
import { Tooltip } from "../../src/ui/app/ui/public/components/tooltip.tsx";
import { Bars } from "../../src/ui/app/ui/public/components/charts/bars.tsx";
import { Donut } from "../../src/ui/app/ui/public/components/charts/donut.tsx";
import { Line } from "../../src/ui/app/ui/public/components/charts/line.tsx";

// happy-dom sets Event.target/currentTarget only for its OWN Event class; a
// bun-native `new Event()` dispatched on a happy-dom node arrives with a null
// target. Use the happy-dom window's Event so handlers that read event.target
// (as they do in a real browser) see the element under test.
declare const window: { Event: typeof Event };

let active: RenderResult | null = null;
function mount(node: Parameters<typeof render>[0]): RenderResult {
  active = render(node);
  return active;
}
afterEach(() => {
  active?.cleanup();
  active = null;
});

describe("Card", () => {
  it("renders title, summary, and body", () => {
    const r = mount(
      <Card title="Runs" summary="last 24h">
        <span data-testid="child">body</span>
      </Card>,
    );
    expect(r.$("h2")?.textContent).toBe("Runs");
    expect(r.$("p")?.textContent).toBe("last 24h");
    expect(r.$("[data-testid='child']")?.textContent).toBe("body");
  });

  it("omits the summary paragraph when absent", () => {
    const r = mount(<Card title="Runs" />);
    expect(r.$("p")).toBeNull();
  });
});

describe("Badge", () => {
  it("carries the tone as a data attribute", () => {
    const r = mount(<Badge tone="success">ok</Badge>);
    const el = r.$("[data-component='badge']");
    expect(el?.getAttribute("data-tone")).toBe("success");
    expect(el?.textContent).toBe("ok");
  });

  it("defaults to the neutral tone", () => {
    const r = mount(<Badge>x</Badge>);
    expect(r.$("[data-component='badge']")?.getAttribute("data-tone")).toBe("neutral");
  });
});

describe("Button", () => {
  it("fires onClick and reflects the variant", async () => {
    let clicks = 0;
    const r = mount(
      <Button variant="destructive" onClick={() => (clicks += 1)}>
        Delete
      </Button>,
    );
    const btn = r.$("button");
    expect(btn?.getAttribute("data-variant")).toBe("destructive");
    await r.act(() => (btn as HTMLButtonElement).click());
    expect(clicks).toBe(1);
  });

  it("renders a disabled button", () => {
    const r = mount(<Button disabled>x</Button>);
    expect((r.$("button") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("IconButton", () => {
  it("exposes an aria-label and fires onClick", async () => {
    let clicks = 0;
    const r = mount(
      <IconButton label="Copy" onClick={() => (clicks += 1)}>
        <span>C</span>
      </IconButton>,
    );
    const btn = r.$("button");
    expect(btn?.getAttribute("aria-label")).toBe("Copy");
    await r.act(() => (btn as HTMLButtonElement).click());
    expect(clicks).toBe(1);
  });
});

describe("Input", () => {
  it("reports typed values through onInput", async () => {
    let seen = "";
    const r = mount(<Input ariaLabel="filter" onInput={(v) => (seen = v)} />);
    const input = r.$("input") as HTMLInputElement;
    expect(input.getAttribute("aria-label")).toBe("filter");
    await r.act(() => {
      input.value = "hello";
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    expect(seen).toBe("hello");
  });

  it("renders a search input when asked", () => {
    const r = mount(<Input type="search" />);
    expect((r.$("input") as HTMLInputElement).getAttribute("type")).toBe("search");
  });
});

describe("Kpi", () => {
  it("renders label, value, and sub", () => {
    const r = mount(<Kpi label="Spend" value="$12.00" sub="+3%" />);
    expect(r.$("[data-kpi-label]")?.textContent).toBe("Spend");
    expect(r.$("[data-kpi-value]")?.textContent).toBe("$12.00");
    expect(r.$("[data-kpi-sub]")?.textContent).toBe("+3%");
  });

  it("omits the sub line when absent", () => {
    const r = mount(<Kpi label="Spend" value="$0" />);
    expect(r.$("[data-kpi-sub]")).toBeNull();
  });
});

describe("Table", () => {
  it("renders a sortable header with aria-sort and fires onSort", async () => {
    let sorts = 0;
    const r = mount(
      <Table>
        <TableHead>
          <TableRow>
            <TableHeader sort="ascending" onSort={() => (sorts += 1)} indicator="▲">
              Name
            </TableHeader>
            <TableHeader>Plain</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          <TableRow>
            <TableCell rowHeader>a</TableCell>
            <TableCell>b</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const headers = r.$$("th");
    expect(headers[0]?.getAttribute("aria-sort")).toBe("ascending");
    // a non-sortable header must not claim an aria-sort state
    expect(headers[1]?.getAttribute("aria-sort")).toBeNull();
    expect(r.$("[data-sort-indicator]")?.textContent).toBe("▲");
    expect(r.$("th[scope='row']")?.textContent).toBe("a");
    await r.act(() => (r.$("[data-table-sort]") as HTMLButtonElement).click());
    expect(sorts).toBe(1);
  });
});

describe("Tooltip", () => {
  it("links the bubble to the trigger and keeps it in the markup", () => {
    const r = mount(
      <Tooltip id="tip-1" content="more info">
        <span>?</span>
      </Tooltip>,
    );
    expect(r.$("[data-tooltip-trigger]")?.getAttribute("aria-describedby")).toBe("tip-1");
    const bubble = r.$("[data-tooltip-bubble]");
    expect(bubble?.getAttribute("id")).toBe("tip-1");
    expect(bubble?.getAttribute("role")).toBe("tooltip");
    expect(bubble?.textContent).toBe("more info");
  });
});

describe("Collapsible", () => {
  it("renders the accordion trigger with the title and the panel content", () => {
    const r = mount(
      <Collapsible title="Details" defaultOpen>
        <span data-testid="panel">hidden bits</span>
      </Collapsible>,
    );
    // wraps the remix/ui accordion primitive: a real button trigger + a region
    const trigger = r.$("button");
    expect(trigger?.textContent).toContain("Details");
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(r.$("[data-testid='panel']")?.textContent).toBe("hidden bits");
  });
});

describe("Select", () => {
  it("renders the primitive trigger, default label, and options", () => {
    const r = mount(
      <Select
        defaultLabel="Pick one"
        ariaLabel="picker"
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ]}
      />,
    );
    const trigger = r.$("button");
    expect(trigger?.getAttribute("aria-label")).toBe("picker");
    expect(trigger?.textContent).toContain("Pick one");
    // the options render inline (the primitive is portal-free)
    expect(r.container.textContent).toContain("Alpha");
    expect(r.container.textContent).toContain("Beta");
  });
});

describe("Donut", () => {
  it("draws one stroked slice per non-zero value plus a track", () => {
    const r = mount(<Donut values={[1, 3]} ariaLabel="mix" />);
    expect(r.$("[data-component='donut']")?.getAttribute("aria-label")).toBe("mix");
    expect(r.$("[data-donut-track]")).not.toBeNull();
    const slices = r.$$("[data-donut-slice]");
    expect(slices.length).toBe(2);
    // second slice fraction = 3/4
    expect(Number(slices[1]?.getAttribute("data-fraction"))).toBeCloseTo(0.75, 5);
  });

  it("omits zero-value slices", () => {
    const r = mount(<Donut values={[0, 0]} />);
    expect(r.$$("[data-donut-slice]").length).toBe(0);
  });
});

describe("Bars", () => {
  it("renders a fill rect per item scaled to the max", () => {
    const r = mount(
      <Bars
        items={[
          { label: "a", value: 5 },
          { label: "b", value: 10 },
        ]}
      />,
    );
    const bars = r.$$("[data-bar]");
    expect(bars.length).toBe(2);
    expect(Number(bars[0]?.getAttribute("data-fraction"))).toBeCloseTo(0.5, 5);
    expect(Number(bars[1]?.getAttribute("data-fraction"))).toBeCloseTo(1, 5);
    expect(r.$$("[data-bar-fill]").length).toBe(2);
  });
});

describe("Line", () => {
  it("emits a single path built from the model", () => {
    const r = mount(<Line values={[0, 10]} width={100} height={40} padding={0} />);
    expect(r.$("[data-line-path]")?.getAttribute("d")).toBe("M 0 40 L 100 0");
    expect(r.$("[data-line-dot]")).not.toBeNull();
  });

  it("renders no path for an empty series", () => {
    const r = mount(<Line values={[]} />);
    expect(r.$("[data-line-path]")).toBeNull();
  });
});
