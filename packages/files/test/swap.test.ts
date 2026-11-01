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
const hooks = vi.hoisted(() => ({ afterStage: null as null | ((staged: string) => void) }));
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
        hook(String(to));
      }
    },
  };
});

const {
  asidePath,
  compareAndSwapFileSync,
  hashYaml,
  hashesMatch,
  isModelFileSync,
  isStaleSwapFile,
  parseSwapFileName,
  readModelText,
  recoverStaleModel,
  recoverStaleModels,
  STALE_SWAP_MS,
  tempPath,
} = await import("../src/index.js");

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
  expect(readdirSync(dir).filter((name) => parseSwapFileName(name) !== null)).toEqual([]);
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

  it.skipIf(process.getuid?.() === 0)("puts the model back when the swap fails after moving it aside", () => {
    writeFileSync(target, "base");
    // Reading the staged file then fails, inside the swap's compare step.
    hooks.afterStage = (staged) => fs.chmodSync(staged, 0o000);
    expect(() => compareAndSwapFileSync(target, "next", hashYaml("base"))).toThrow(/EACCES/);
    fs.chmodSync(target, 0o644);
    expect(readFileSync(target, "utf8")).toBe("base");
    expectNoLeftovers();
  });
});

/** No process runs under this pid (above Linux's pid_max). */
const DEAD_PID = 999_999_999;

/** What a writer that crashed between moving `target` aside and publishing leaves. */
function crashedSwap(content: string, pid: number): string {
  const aside = join(dir, `.model.yaml.aside-${pid}-0123abcd-0000-4000-8000-000000000000`);
  writeFileSync(aside, content);
  return aside;
}

describe("stale swap recovery", () => {
  it("parses swap file names", () => {
    expect(parseSwapFileName(".model.yaml.tmp-12-ab-cd")).toEqual({ original: "model.yaml", kind: "temp", pid: 12 });
    expect(parseSwapFileName(".a.b.yaml.aside-7-ff")).toEqual({ original: "a.b.yaml", kind: "aside", pid: 7 });
    expect(parseSwapFileName("model.yaml")).toBeNull();
    expect(parseSwapFileName(".model.yaml.tmp-x-ab")).toBeNull();
    expect(parseSwapFileName(".model.yaml.tmp-1-ab.yaml")).toBeNull();
    expect(parseSwapFileName(tempPath(target).slice(dir.length + 1))?.kind).toBe("temp");
    expect(parseSwapFileName(asidePath(target).slice(dir.length + 1))?.kind).toBe("aside");
  });

  it("treats a swap file as stale once its writer is gone or it is old", () => {
    const now = Date.now();
    const dead = crashedSwap("x", DEAD_PID);
    // Too young to judge even with a dead pid: the writer may be in another pid namespace.
    expect(isStaleSwapFile(dead, now)).toBe(false);
    expect(isStaleSwapFile(dead, now + 2_000)).toBe(true);
    const live = join(dir, `.other.yaml.aside-${process.pid}-abcd`);
    writeFileSync(live, "y");
    expect(isStaleSwapFile(live, now + 2_000)).toBe(false);
    expect(isStaleSwapFile(live, now + STALE_SWAP_MS + 1_000)).toBe(true);
    expect(isStaleSwapFile(join(dir, ".gone.yaml.aside-1-ab"), now + STALE_SWAP_MS * 2)).toBe(false);
  });

  it("restores a model a crashed writer left moved aside", () => {
    crashedSwap("committed", DEAD_PID);
    expect(recoverStaleModel(target, Date.now() + 2_000)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("committed");
    expectNoLeftovers();
  });

  it("restores through readModelText and isModelFileSync once the file is stale", () => {
    crashedSwap("committed", DEAD_PID);
    const later = Date.now() + 2_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      expect(isModelFileSync(target)).toBe(true);
      expect(readModelText(target)).toBe("committed");
    } finally {
      spy.mockRestore();
    }
    expectNoLeftovers();
  });

  it("restores every stale model in a directory", () => {
    crashedSwap("one", DEAD_PID);
    writeFileSync(join(dir, `.two.yaml.aside-${DEAD_PID}-ab`), "two");
    expect(recoverStaleModels(dir, Date.now() + 2_000).sort()).toEqual(["model.yaml", "two.yaml"]);
    expect(readFileSync(join(dir, "two.yaml"), "utf8")).toBe("two");
    expectNoLeftovers();
  });

  it("leaves a fresh swap by a live writer alone", () => {
    const aside = crashedSwap("in flight", process.pid);
    expect(recoverStaleModel(target, Date.now() + 2_000)).toBe(false);
    expect(readdirSync(dir)).toEqual([aside.slice(dir.length + 1)]);
  });

  it("never replaces a model another writer created", () => {
    const aside = crashedSwap("old", DEAD_PID);
    writeFileSync(target, "newer");
    expect(recoverStaleModel(target, Date.now() + 2_000)).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("newer");
    expect(readFileSync(aside, "utf8")).toBe("old");
  });

  it("never publishes a stale temp file, which holds a write that did not land", () => {
    writeFileSync(join(dir, `.model.yaml.tmp-${DEAD_PID}-ab`), "unpublished");
    expect(recoverStaleModel(target, Date.now() + STALE_SWAP_MS * 2)).toBe(false);
    expect(readModelText(target)).toBeNull();
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
