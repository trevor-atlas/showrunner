import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { cleanupDir, tmpDataDir } from "./helpers.ts";
import {
  PRICES_FILE,
  estimateUsd,
  loadRoster,
  pricesPathFor,
} from "../src/index.ts";
import type { Roster } from "../src/index.ts";

/**
 * The price roster (spec §11.1) — the fallback/estimate path for spend.
 * Tests use the scratch data dir (T03's F3 pattern): no real prices.json is
 * ever touched, and every run's estimates read from its own data dir.
 */

test("a missing prices.json reads as the empty roster (no estimates, §11.1)", () => {
  const dir = tmpDataDir("roster-missing");
  try {
    expect(loadRoster(dir)).toEqual({});
    expect(loadRoster(dir)).toHaveProperty("constructor", Object);
  } finally {
    cleanupDir(dir);
  }
});

test("a valid prices.json parses into the { model: { in_per_mtok, out_per_mtok } } shape", () => {
  const dir = tmpDataDir("roster-valid");
  try {
    writeFileSync(
      pricesPathFor(dir),
      JSON.stringify({ "fake-pi": { in_per_mtok: 3, out_per_mtok: 15 }, "gpt-x": { in_per_mtok: 2.5, out_per_mtok: 10 } }),
    );
    const roster = loadRoster(dir);
    expect(roster["fake-pi"]).toEqual({ in_per_mtok: 3, out_per_mtok: 15 });
    expect(roster["gpt-x"]).toEqual({ in_per_mtok: 2.5, out_per_mtok: 10 });
  } finally {
    cleanupDir(dir);
  }
});

test("the roster file lives at {data_dir}/prices.json", () => {
  const dir = tmpDataDir("roster-path");
  try {
    expect(pricesPathFor(dir)).toBe(join(dir, PRICES_FILE));
    expect(PRICES_FILE).toBe("prices.json");
  } finally {
    cleanupDir(dir);
  }
});

test("malformed prices.json (not JSON) throws with the file path", () => {
  const dir = tmpDataDir("roster-badjson");
  try {
    writeFileSync(pricesPathFor(dir), "{ not json");
    expect(() => loadRoster(dir)).toThrow(/prices\.json/);
    expect(() => loadRoster(dir)).toThrow(/not valid JSON/);
  } finally {
    cleanupDir(dir);
  }
});

test("a roster with the wrong shape (missing rates / wrong types) throws", () => {
  const dir = tmpDataDir("roster-badshape");
  try {
    // a model whose entry has no out_per_mtok
    writeFileSync(pricesPathFor(dir), JSON.stringify({ "fake-pi": { in_per_mtok: 3 } }));
    expect(() => loadRoster(dir)).toThrow(/not a valid roster/);
    // an entry with a non-number rate
    writeFileSync(pricesPathFor(dir), JSON.stringify({ "fake-pi": { in_per_mtok: "cheap", out_per_mtok: 15 } }));
    expect(() => loadRoster(dir)).toThrow(/not a valid roster/);
    // non-object root
    writeFileSync(pricesPathFor(dir), JSON.stringify([1, 2]));
    expect(() => loadRoster(dir)).toThrow(/not a valid roster/);
  } finally {
    cleanupDir(dir);
  }
});

test("estimateUsd prices a token delta as tokens × per_mtok / 1e6", () => {
  const roster: Roster = { "fake-pi": { in_per_mtok: 3, out_per_mtok: 15 } };
  // 1000 in × 3 + 200 out × 15 = 3000 + 3000 = $0.006
  expect(estimateUsd(roster, "fake-pi", { tokens_in: 1000, tokens_out: 200 })).toBeCloseTo(0.006);
  // zero tokens cost nothing
  expect(estimateUsd(roster, "fake-pi", { tokens_in: 0, tokens_out: 0 })).toBe(0);
  // 1M tokens × 1 = $1.0
  expect(estimateUsd(roster, "fake-pi", { tokens_in: 1_000_000, tokens_out: 0 })).toBeCloseTo(3);
});

test("estimateUsd returns null for a model missing from the roster (never fabricated)", () => {
  const roster: Roster = { "fake-pi": { in_per_mtok: 3, out_per_mtok: 15 } };
  expect(estimateUsd(roster, "unknown-model", { tokens_in: 1000, tokens_out: 200 })).toBeNull();
  expect(estimateUsd({}, "fake-pi", { tokens_in: 1000, tokens_out: 200 })).toBeNull();
});
