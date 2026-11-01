import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createWatcher,
  type ModelWatchEvent,
  type WatcherHandle,
} from "../src/watch.js";

const MODEL = `version: 1
name: Watched Model
properties: []
subsystems:
  - id: core
    name: Core
    tier: core
nodes:
  - id: a
    kind: pool
    name: A
    subsystem: core
    start: 1
edges: []
noInteraction: []
invariants: []
`;

const DEBOUNCE_MS = 100;

let dir: string;
let watchers: WatcherHandle[] = [];

async function watch(events: ModelWatchEvent[]): Promise<WatcherHandle> {
  const watcher = createWatcher(dir, (e) => events.push(e));
  watchers.push(watcher);
  await watcher.ready;
  return watcher;
}

afterAll(() => {
  for (const watcher of watchers) watcher.close();
  watchers = [];
  rmSync(dir, { recursive: true, force: true });
});

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mechflow-watch-"));
});

/** Resolve once `target` events have fired, or reject on timeout. */
async function waitEvents(
  events: ModelWatchEvent[],
  target: number,
  timeout = 4000,
): Promise<void> {
  const start = Date.now();
  while (events.length < target) {
    if (Date.now() - start > timeout) {
      throw new Error(`expected ${target} events, only ${events.length} fired`);
    }
    await new Promise((r) => setTimeout(r, 15));
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

describe("createWatcher", () => {
  it("emits exactly one model-changed after the debounce", async () => {
    const events: ModelWatchEvent[] = [];
    await watch(events);

    writeFileSync(join(dir, "a.yaml"), MODEL);

    await waitEvents(events, 1);
    // Give any (erroneously) coalesced duplicate a chance to appear.
    await sleep(DEBOUNCE_MS + 50);

    const changed = events.filter((e) => e.type === "model-changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ path: "a.yaml" });
    expect(typeof (changed[0] as { hash: string }).hash).toBe("string");
  });

  it("coalesces rapid writes to a single event", async () => {
    const events: ModelWatchEvent[] = [];
    await watch(events);

    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, "b.yaml"), `${MODEL}\n# ${i}`);
    }

    await waitEvents(events, 1);
    await sleep(DEBOUNCE_MS + 50);

    const changed = events.filter(
      (e) => e.type === "model-changed" && e.path === "b.yaml",
    );
    expect(changed).toHaveLength(1);
  });

  it("ignores atomic-write temp files", async () => {
    const events: ModelWatchEvent[] = [];
    await watch(events);

    writeFileSync(join(dir, ".b.yaml.tmp-1234-abcd1234"), "temp");
    await sleep(DEBOUNCE_MS + 100);

    expect(events).toHaveLength(0);
  });

  it("emits model-removed when a file is deleted", async () => {
    const events: ModelWatchEvent[] = [];
    await watch(events);

    const p = join(dir, "del.yaml");
    writeFileSync(p, MODEL);
    await waitEvents(events, 1);

    events.length = 0;
    rmSync(p);
    await waitEvents(events, 1);

    expect(events[0]).toEqual({ type: "model-removed", path: "del.yaml" });
  });
});
