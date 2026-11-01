import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Server, ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, handleGetModel, handlePutModel } from "../src/index.js";

const MODEL_V1 = `version: 1
name: Conflict Model
properties: []
subsystems: []
nodes: []
edges: []
noInteraction: []
invariants: []
`;

const MODEL_V2 = `version: 1
name: Conflict Model (edited)
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

let modelsRoot: string;
let webDist: string;
let server: Server;
let base: string;

beforeAll(async () => {
  modelsRoot = mkdtempSync(join(tmpdir(), "mechflow-conflict-"));
  webDist = mkdtempSync(join(tmpdir(), "mechflow-conflict-web-"));
  writeFileSync(join(webDist, "index.html"), "<!doctype html><body>app</body></html>");
  server = createServer({ modelsRoot, webDist });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
  rmSync(modelsRoot, { recursive: true, force: true });
  rmSync(webDist, { recursive: true, force: true });
});

interface RequestResult {
  status: number;
  json: unknown;
  body: string;
}

async function request(
  method: string,
  path: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<RequestResult> {
  const res = await fetch(base + path, {
    method,
    body: body === undefined ? undefined : body,
    headers: {
      ...(body === undefined ? {} : { "content-type": "text/plain" }),
      ...headers,
    },
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, body: text, json };
}

describe("GET hash", () => {
  it("returns a content hash alongside the yaml and keeps it stable", async () => {
    writeFileSync(join(modelsRoot, "m.yaml"), MODEL_V1);
    const a = await request("GET", "/api/models/m.yaml");
    expect(a.status).toBe(200);
    const hashA = (a.json as { hash: string }).hash;
    expect(hashA).toMatch(/^[0-9a-f]{40}$/);

    // Unchanged content -> same hash.
    const b = await request("GET", "/api/models/m.yaml");
    const hashB = (b.json as { hash: string }).hash;
    expect(hashB).toBe(hashA);

    // After a write the hash changes.
    await request("PUT", "/api/models/m.yaml", MODEL_V2, { "if-match": hashA });
    const c = await request("GET", "/api/models/m.yaml");
    expect((c.json as { hash: string }).hash).not.toBe(hashA);
  });
});

describe("PUT with If-Match", () => {
  it("writes when the hash matches", async () => {
    writeFileSync(join(modelsRoot, "m.yaml"), MODEL_V1);
    const { json } = await request("GET", "/api/models/m.yaml");
    const hash = (json as { hash: string }).hash;

    const put = await request("PUT", "/api/models/m.yaml", MODEL_V2, {
      "if-match": hash,
    });
    expect(put.status).toBe(200);
    expect((put.json as { ok: boolean }).ok).toBe(true);
    expect(readFileSync(join(modelsRoot, "m.yaml"), "utf8")).toBe(MODEL_V2);
  });

  it("409s with the current yaml when the hash does not match", async () => {
    writeFileSync(join(modelsRoot, "m.yaml"), MODEL_V1);
    // A stale hash from some earlier load.
    const staleHash = "0".repeat(40);

    const put = await request("PUT", "/api/models/m.yaml", MODEL_V2, {
      "if-match": staleHash,
    });
    expect(put.status).toBe(409);
    const { conflict, hash: currentHash, yaml, loaded } = put.json as {
      conflict: true;
      hash: string;
      yaml: string;
      loaded: string;
    };
    expect(conflict).toBe(true);
    expect(loaded).toBe(staleHash);
    expect(currentHash).not.toBe(staleHash);
    // The current YAML is returned so the editor can offer reload.
    expect(yaml).toBe(MODEL_V1);
    // The on-disk file is left untouched by the rejected write.
    expect(readFileSync(join(modelsRoot, "m.yaml"), "utf8")).toBe(MODEL_V1);
  });

  it("still writes when no If-Match header is sent", async () => {
    const put = await request("PUT", "/api/models/noifmatch.yaml", MODEL_V2);
    expect(put.status).toBe(200);
    expect(readFileSync(join(modelsRoot, "noifmatch.yaml"), "utf8")).toBe(MODEL_V2);
  });

  it("matches an If-Match value wrapped in quotes", async () => {
    writeFileSync(join(modelsRoot, "m.yaml"), MODEL_V1);
    const { json } = await request("GET", "/api/models/m.yaml");
    const hash = (json as { hash: string }).hash;

    const put = await request("PUT", "/api/models/m.yaml", MODEL_V2, {
      "if-match": `"${hash}"`,
    });
    expect(put.status).toBe(200);
  });

  it("409s when the model was deleted since it was loaded", async () => {
    const put = await request("PUT", "/api/models/deleted.yaml", MODEL_V2, {
      "if-match": "0".repeat(40),
    });
    expect(put.status).toBe(409);
    expect(put.json).toMatchObject({ conflict: true, hash: null, yaml: null });
  });

  it("409s end-to-end after a genuine concurrent edit", async () => {
    // Browser loads the model and records the hash.
    writeFileSync(join(modelsRoot, "m.yaml"), MODEL_V1);
    const loaded = await request("GET", "/api/models/m.yaml");
    const loadedHash = (loaded.json as { hash: string }).hash;

    // The agent edits the file on disk out from under the browser.
    writeFileSync(join(modelsRoot, "m.yaml"), MODEL_V2);

    // The browser's save now carries the stale hash -> 409.
    const put = await request(
      "PUT",
      "/api/models/m.yaml",
      "version: 1\nname: Browser Edit\nproperties: []\nsubsystems: []\nnodes: []\nedges: []\nnoInteraction: []\ninvariants: []\n",
      { "if-match": loadedHash },
    );
    expect(put.status).toBe(409);
    expect((put.json as { conflict: boolean }).conflict).toBe(true);
    expect((put.json as { yaml: string }).yaml).toBe(MODEL_V2);
  });
});

describe("invalid model with If-Match", () => {
  it("422s before checking the hash", async () => {
    writeFileSync(join(modelsRoot, "m.yaml"), MODEL_V1);
    const invalid = "name: [unterminated";
    const put = await request("PUT", "/api/models/m.yaml", invalid, {
      "if-match": "0".repeat(40),
    });
    expect(put.status).toBe(422);
    expect(readFileSync(join(modelsRoot, "m.yaml"), "utf8")).toBe(MODEL_V1);
  });
});

describe("PUT with a JSON model", () => {
  const json = (model: unknown) => JSON.stringify({ model });
  const asJson = { "content-type": "application/json; charset=utf-8" };

  it("writes the serialized model and returns the new hash", async () => {
    writeFileSync(join(modelsRoot, "m.yaml"), MODEL_V1);
    const get = await request("GET", "/api/models/m.yaml");
    const { hash, model } = get.json as { hash: string; model: Record<string, unknown> };
    const edited = { ...model, name: "Edited in Godot" };

    const put = await request("PUT", "/api/models/m.yaml", json(edited), { ...asJson, "if-match": hash });
    expect(put.status).toBe(200);
    const after = await request("GET", "/api/models/m.yaml");
    const body = after.json as { hash: string; yaml: string; model: { name: string } };
    expect(body.model.name).toBe("Edited in Godot");
    expect(body.yaml).toBe(readFileSync(join(modelsRoot, "m.yaml"), "utf8"));
    expect((put.json as { hash: string }).hash).toBe(body.hash);
  });

  it("422s an invalid model and leaves the file alone", async () => {
    writeFileSync(join(modelsRoot, "m.yaml"), MODEL_V1);
    const put = await request("PUT", "/api/models/m.yaml", json({ name: "No version" }), asJson);
    expect(put.status).toBe(422);
    expect(readFileSync(join(modelsRoot, "m.yaml"), "utf8")).toBe(MODEL_V1);
  });

  it("400s malformed JSON and a body without a model", async () => {
    writeFileSync(join(modelsRoot, "m.yaml"), MODEL_V1);
    expect((await request("PUT", "/api/models/m.yaml", "{not json", asJson)).status).toBe(400);
    expect((await request("PUT", "/api/models/m.yaml", "{}", asJson)).status).toBe(400);
    expect(readFileSync(join(modelsRoot, "m.yaml"), "utf8")).toBe(MODEL_V1);
  });

  it("409s with the current yaml on a stale If-Match", async () => {
    writeFileSync(join(modelsRoot, "m.yaml"), MODEL_V1);
    const get = await request("GET", "/api/models/m.yaml");
    const { hash, model } = get.json as { hash: string; model: unknown };
    writeFileSync(join(modelsRoot, "m.yaml"), MODEL_V2);

    const put = await request("PUT", "/api/models/m.yaml", json(model), { ...asJson, "if-match": hash });
    expect(put.status).toBe(409);
    expect((put.json as { conflict: boolean; yaml: string }).yaml).toBe(MODEL_V2);
    expect(readFileSync(join(modelsRoot, "m.yaml"), "utf8")).toBe(MODEL_V2);
  });
});

/**
 * Small model whose description holds one counter per writer. Each writer
 * read-modify-writes only its own counter, so a lost write shows up as a
 * counter below that writer's number of successful saves.
 */
function counterModel(web: number, mcp: number): string {
  return `version: 1
name: Race
description: "web=${web} mcp=${mcp}"
properties: []
subsystems: []
nodes: []
edges: []
noInteraction: []
invariants: []
`;
}

function counters(yaml: string): { web: number; mcp: number } {
  const match = /web=(\d+) mcp=(\d+)/.exec(yaml);
  if (!match) throw new Error(`no counters in:\n${yaml}`);
  return { web: Number(match[1]), mcp: Number(match[2]) };
}

/**
 * Another process doing what the MCP server's tools do (`updateModelFile`):
 * read the model, bump its counter, and publish with a compare-and-swap,
 * re-reading on a lost race. Runs until stdin closes, then prints how many
 * saves succeeded.
 */
const OTHER_WRITER = `
const { compareAndSwapFileSync, hashYaml, readModelText } = await import(process.argv[1]);
const target = process.argv[2];
let stop = false;
process.stdin.on("end", () => (stop = true)).resume();
process.stdout.write("ready\\n");
let saved = 0;
while (!stop) {
  const text = readModelText(target);
  const next = text.replace(/mcp=(\\d+)/, (_, n) => "mcp=" + (Number(n) + 1));
  if (compareAndSwapFileSync(target, next, hashYaml(text)).ok) saved++;
  // Yield so the stdin "end" event can be seen.
  if (saved % 20 === 0) await new Promise((resolve) => setImmediate(resolve));
}
process.stdout.write("saved=" + saved + "\\n");
`;

/** Minimal ServerResponse stand-in that records the JSON a handler sends. */
function captureJson(): { res: ServerResponse; status: () => number; json: () => unknown } {
  let status = 0;
  let body = "";
  const res = {
    writeHead: (code: number) => { status = code; return res; },
    setHeader: () => res,
    end: (chunk?: string) => { body = chunk ?? ""; return res; },
  } as unknown as ServerResponse;
  return { res, status: () => status, json: () => JSON.parse(body) };
}

describe("concurrent writers", () => {
  it("loses no write when the server and another process race on one model", async () => {
    const target = join(modelsRoot, "race.yaml");
    writeFileSync(target, counterModel(0, 0));
    // The built package, as the server itself loads it.
    const filesEntry = new URL("../node_modules/@mechflow/files/dist/index.js", import.meta.url).href;
    const other = spawn(process.execPath, [
      "--input-type=module", "-e", OTHER_WRITER, filesEntry, target,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let otherOut = "";
    let otherErrors = "";
    other.stdout.on("data", (chunk) => (otherOut += chunk));
    other.stderr.on("data", (chunk) => (otherErrors += chunk));
    const otherDone = new Promise<number | null>((resolve) => other.on("exit", resolve));
    await new Promise((resolve) => other.stdout.once("data", resolve));

    // The browser path through the real handlers, in a tight loop while the
    // other process writes continuously: GET, bump, PUT with If-Match.
    let webSaved = 0;
    try {
      for (let i = 0; i < 1500; i++) {
        const get = captureJson();
        handleGetModel(modelsRoot, "race.yaml", get.res);
        expect(get.status()).toBe(200);
        const { yaml, hash } = get.json() as { yaml: string; hash: string };
        const { web, mcp } = counters(yaml);
        const put = captureJson();
        handlePutModel(modelsRoot, "race.yaml", counterModel(web + 1, mcp), put.res, hash);
        if (put.status() === 200) webSaved++;
        else expect(put.status()).toBe(409);
      }
    } finally {
      other.stdin.end();
    }

    expect(await otherDone, otherErrors).toBe(0);
    const mcpSaved = Number(/saved=(\d+)/.exec(otherOut)?.[1]);
    expect(webSaved).toBeGreaterThan(0);
    expect(mcpSaved).toBeGreaterThan(0);
    expect(counters(readFileSync(target, "utf8"))).toEqual({ web: webSaved, mcp: mcpSaved });
  }, 60_000);
});
