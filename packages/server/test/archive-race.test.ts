import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { DEAD_WRITER_SWAP_MS } from "@mechflow/files";
import { expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({ directory: "", source: "", staged: "", restored: false }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    readdirSync: (path: string, options: { withFileTypes: true }) => {
      const listing = fs.readdirSync(path, options);
      if (path === race.directory && !race.restored) {
        // The list captured only the temp name; the model reappears before
        // export examines that list. This used to yield an incomplete ZIP.
        fs.renameSync(race.staged, race.source);
        race.restored = true;
      }
      return listing;
    },
  };
});

import { exportArchive } from "../src/archive.js";

it("retries when a model returns after the directory snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "mechflow-archive-race-"));
  try {
    race.directory = join(root, "Game");
    mkdirSync(race.directory);
    race.source = join(race.directory, "model.yaml");
    race.staged = join(race.directory, ".model.yaml.tmp-999-abcdef");
    race.restored = false;
    writeFileSync(race.source, "name: restored\n");
    renameSync(race.source, race.staged);
    const zip = exportArchive(root, "Game", "game");
    expect(race.restored).toBe(true);
    expect(new TextDecoder().decode(unzipSync(zip)["content/model.yaml"])).toBe("name: restored\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Pretend the swap files were left this long ago, past the dead-writer grace. */
function afterDeadWriterGrace(): { mockRestore(): void } {
  return vi.spyOn(Date, "now").mockReturnValue(Date.now() + DEAD_WRITER_SWAP_MS + 1_000);
}

it("restores a model a crashed writer left moved aside, instead of 409ing forever", () => {
  const root = mkdtempSync(join(tmpdir(), "mechflow-archive-stale-"));
  const source = join(root, "Game", "model.yaml");
  // No process runs under this pid (above Linux's pid_max).
  const aside = join(root, "Game", ".model.yaml.aside-999999999-0123abcd");
  const clock = afterDeadWriterGrace();
  try {
    mkdirSync(join(root, "Game"));
    writeFileSync(source, "name: saved\n");
    renameSync(source, aside);
    const files = unzipSync(exportArchive(root, "Game", "game"));
    expect(new TextDecoder().decode(files["content/model.yaml"])).toBe("name: saved\n");
    expect(Object.keys(files).filter((name) => name.includes(".aside-"))).toEqual([]);
    expect(readFileSync(source, "utf8")).toBe("name: saved\n");
    expect(existsSync(aside)).toBe(false);
  } finally {
    clock.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

it("skips a stale temp file whose write never published", () => {
  const root = mkdtempSync(join(tmpdir(), "mechflow-archive-stale-"));
  const clock = afterDeadWriterGrace();
  try {
    mkdirSync(join(root, "Game"));
    writeFileSync(join(root, "Game", ".model.yaml.tmp-999999999-0123abcd"), "name: unpublished\n");
    const files = unzipSync(exportArchive(root, "Game", "game"));
    expect(Object.keys(files).filter((name) => name.startsWith("content/"))).toEqual([]);
  } finally {
    clock.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
