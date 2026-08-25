/**
 * @showrunner/daemon workspace — the filesystem-persistence sibling of db.ts.
 *
 * Owns the context & handoff filesystem protocol (T05): the run workspace
 * layout, materialization, context resolution, and the raw record files. The
 * read side lives in readers.ts, the write side in writers.ts; this barrel
 * re-exports both. src/daemon/handoff.ts is a thin re-export shim over this
 * module so existing importers keep compiling (repointed to workspace in #51).
 */
export * from "./readers.ts";
export * from "./writers.ts";
