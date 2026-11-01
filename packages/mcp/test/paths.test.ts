import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PathEscapeError,
  ModelConflictError,
  readModelFile,
  resolveWithin,
  updateModelFile,
  UPDATE_ATTEMPTS,
  writeModelFileAtomic,
} from "../src/paths.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "mechflow-paths-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveWithin", () => {
  it("resolves a simple relative path inside the root", () => {
    expect(resolveWithin(root, "hub-spoke.yaml")).toBe(path.resolve(root, "hub-spoke.yaml"));
  });

  it("resolves nested paths inside the root", () => {
    expect(resolveWithin(root, "models/sub/a.yaml")).toBe(path.resolve(root, "models/sub/a.yaml"));
  });

  it("collapses dot-dot segments that stay inside", () => {
    expect(resolveWithin(root, "models/sub/../a.yaml")).toBe(path.resolve(root, "models/a.yaml"));
  });

  it("rejects a path that escapes the root", () => {
    expect(() => resolveWithin(root, "../escape.yaml")).toThrow(PathEscapeError);
    expect(() => resolveWithin(root, "../../etc/passwd")).toThrow(/escapes the models root/);
  });

  it("rejects the root itself as a model path", () => {
    expect(() => resolveWithin(root, ".")).toThrow(PathEscapeError);
    expect(() => resolveWithin(root, "")).toThrow(PathEscapeError);
  });
});

describe("writeModelFileAtomic", () => {
  it("writes content and leaves no temp files behind", () => {
    const target = path.join(root, "model.yaml");
    writeModelFileAtomic(target, "version: 1\n");
    expect(readFileSync(target, "utf8")).toBe("version: 1\n");
    // No leftover temp files in the directory.
    const leftovers = readdirSync(root).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("readModelFile returns the written bytes", () => {
    const target = path.join(root, "model.yaml");
    writeModelFileAtomic(target, "name: x\n");
    expect(readModelFile(target)).toBe("name: x\n");
  });
});

describe("updateModelFile", () => {
  it("re-applies the change on top of a write that lands mid-update", () => {
    const target = path.join(root, "model.yaml");
    writeModelFileAtomic(target, "a\n");
    const seen: string[] = [];
    const written = updateModelFile(target, "model.yaml", (text) => {
      seen.push(text);
      // Another writer (the browser save) lands after our read.
      if (seen.length === 1) writeModelFileAtomic(target, "a\nbrowser\n");
      return `${text}mcp\n`;
    });
    expect(seen).toEqual(["a\n", "a\nbrowser\n"]);
    expect(written).toBe("a\nbrowser\nmcp\n");
    expect(readFileSync(target, "utf8")).toBe("a\nbrowser\nmcp\n");
  });

  it("gives up with ModelConflictError when the file never settles", () => {
    const target = path.join(root, "model.yaml");
    writeModelFileAtomic(target, "0");
    let n = 0;
    expect(() =>
      updateModelFile(target, "model.yaml", (text) => {
        writeModelFileAtomic(target, String(++n));
        return `${text}!`;
      }),
    ).toThrow(ModelConflictError);
    expect(n).toBe(UPDATE_ATTEMPTS);
    expect(readFileSync(target, "utf8")).toBe(String(UPDATE_ATTEMPTS));
  });
});
