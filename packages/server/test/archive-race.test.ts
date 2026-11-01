import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
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
