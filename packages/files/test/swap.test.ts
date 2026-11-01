import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Lets a test run a second writer at an exact point inside a swap: right after
 * the swap moves the current file aside (the window where the old
 * compare-then-rename lost writes). The hook fires once, then clears itself.
 */
const hooks = vi.hoisted(() => ({ afterStage: null as null | (() => void) }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      actual.renameSync(from, to);
      // The staging rename moves the model itself (not a temp file) aside.
      if (hooks.afterStage && !String(from).includes(".tmp-")) {
        const hook = hooks.afterStage;
        hooks.afterStage = null;
        hook();
      }
    },
  };
});

const { compareAndSwapFileSync, hashYaml, hashesMatch, readModelText, tempPath } = await import(
  "../src/index.js"
);

let dir: string;
let target: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mechflow-files-"));
  target = join(dir, "model.yaml");
  hooks.afterStage = null;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A second process's unconditional atomic write (temp file + rename). */
function otherWriter(content: string): void {
  const tmp = join(dir, `.model.yaml.tmp-999-other`);
  writeFileSync(tmp, content);
  renameSync(tmp, target);
}

/** No temp or staged files are left next to the model. */
function expectNoLeftovers(): void {
  expect(readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
}

describe("compareAndSwapFileSync", () => {
  it("replaces the file when the expected hash matches", () => {
    writeFileSync(target, "a");
    const result = compareAndSwapFileSync(target, "b", hashYaml("a"));
    expect(result).toEqual({ ok: true, hash: hashYaml("b") });
    expect(readFileSync(target, "utf8")).toBe("b");
    expectNoLeftovers();
  });

  it("refuses and reports the current content when the hash is stale", () => {
    writeFileSync(target, "remote");
    const result = compareAndSwapFileSync(target, "mine", hashYaml("base"));
    expect(result).toEqual({ ok: false, hash: hashYaml("remote"), current: "remote" });
    expect(readFileSync(target, "utf8")).toBe("remote");
    expectNoLeftovers();
  });

  it("refuses a conditional write to a missing file", () => {
    expect(compareAndSwapFileSync(target, "new", hashYaml("gone"))).toEqual({
      ok: false, hash: null, current: null,
    });
    expect(readModelText(target)).toBeNull();
    expectNoLeftovers();
  });

  it("creates exclusively with expected null", () => {
    expect(compareAndSwapFileSync(target, "first", null).ok).toBe(true);
    expect(compareAndSwapFileSync(target, "second", null)).toEqual({
      ok: false, hash: hashYaml("first"), current: "first",
    });
    expect(readFileSync(target, "utf8")).toBe("first");
    expectNoLeftovers();
  });

  it("replaces unconditionally with expected undefined", () => {
    writeFileSync(target, "anything");
    expect(compareAndSwapFileSync(target, "forced").ok).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("forced");
  });

  it("loses to a writer that lands after the compare, keeping its write", () => {
    writeFileSync(target, "base");
    hooks.afterStage = () => otherWriter("mcp");
    const result = compareAndSwapFileSync(target, "browser", hashYaml("base"));
    expect(result).toEqual({ ok: false, hash: hashYaml("mcp"), current: "mcp" });
    expect(readFileSync(target, "utf8")).toBe("mcp");
    expectNoLeftovers();
  });

  it("keeps a newer write that lands while a stale file is being put back", () => {
    writeFileSync(target, "remote");
    hooks.afterStage = () => otherWriter("newest");
    const result = compareAndSwapFileSync(target, "mine", hashYaml("base"));
    expect(result).toMatchObject({ ok: false, current: "newest" });
    expect(readFileSync(target, "utf8")).toBe("newest");
    expectNoLeftovers();
  });

  it("lets exactly one of two conditional writers on the same base win", () => {
    writeFileSync(target, "base");
    let inner: ReturnType<typeof compareAndSwapFileSync> | undefined;
    hooks.afterStage = () => {
      inner = compareAndSwapFileSync(target, "second", hashYaml("base"));
    };
    const outer = compareAndSwapFileSync(target, "first", hashYaml("base"));
    // The second writer finds the file moved aside and must not treat that as
    // a match: it would publish over "base" without having compared it.
    expect(inner).toMatchObject({ ok: false });
    expect(outer.ok).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("first");
    expectNoLeftovers();
  });
});

describe("readModelText", () => {
  it("returns null for a missing file", () => {
    expect(readModelText(target)).toBeNull();
  });

  it("reads the file", () => {
    writeFileSync(target, "text");
    expect(readModelText(target)).toBe("text");
  });
});

describe("helpers", () => {
  it("names temp files the way the watcher ignores them", () => {
    expect(tempPath(target)).toMatch(/\/\.model\.yaml\.tmp-\d+-[0-9a-f-]+$/);
  });

  it("matches If-Match values with quotes and case", () => {
    expect(hashesMatch("abc", '"ABC"')).toBe(true);
    expect(hashesMatch("abc", "")).toBe(false);
  });
});
