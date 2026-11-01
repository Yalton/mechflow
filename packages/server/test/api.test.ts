import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, PACKAGE } from "../src/index.js";
import { handlePutModel, restoreStaged, stageModel } from "../src/api.js";
import { listModels, resolveModelPath } from "../src/paths.js";

const VALID_MODEL = `version: 1
name: Test Model
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
  - id: b
    kind: pool
    name: B
    subsystem: core
    start: 0
edges:
  - id: a_to_b
    kind: flow
    from: a
    to: b
    rate: "1"
noInteraction: []
invariants: []
`;

// Edge references a node that does not exist -> validation error.
const INVALID_MODEL = `version: 1
name: Bad Model
properties: []
subsystems: []
nodes:
  - id: a
    kind: pool
    name: A
    start: 1
edges:
  - id: e
    kind: flow
    from: a
    to: missing
noInteraction: []
invariants: []
`;

let modelsRoot: string;
let webDist: string;
let server: ReturnType<typeof createServer>;
let base: string;

beforeAll(async () => {
  modelsRoot = mkdtempSync(join(tmpdir(), "mechflow-models-"));
  webDist = mkdtempSync(join(tmpdir(), "mechflow-web-"));
  mkdirSync(join(modelsRoot, "sub"), { recursive: true });
  writeFileSync(join(modelsRoot, "valid.yaml"), VALID_MODEL);
  writeFileSync(join(modelsRoot, "invalid.yaml"), INVALID_MODEL);
  writeFileSync(join(modelsRoot, "sub", "nested.yaml"), VALID_MODEL);

  writeFileSync(join(webDist, "index.html"), "<!doctype html><html><body>mechflow</body></html>");
  mkdirSync(join(webDist, "assets"), { recursive: true });
  writeFileSync(join(webDist, "assets", "app.js"), "console.log('mechflow');");

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

/** Minimal ServerResponse capture for calling handlers directly. */
function captureRes() {
  let status = 0;
  let body = "";
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(payload: string) {
      body = payload;
    },
  } as unknown as ServerResponse;
  return { res, getStatus: () => status, getBody: () => body };
}

async function request(
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; body: string; json: unknown }> {
  const res = await fetch(base + path, {
    method,
    body: body === undefined ? undefined : body,
    headers: body === undefined ? undefined : { "content-type": "text/plain" },
  });
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, body: text, json };
}

describe("package", () => {
  it("exposes its package name", () => {
    expect(PACKAGE).toBe("@mechflow/server");
  });
});

describe("path helpers", () => {
  it("rejects traversal and absolute paths", () => {
    expect(resolveModelPath("/root/models", "../package.json")).toBeNull();
    expect(resolveModelPath("/root/models", "..")).toBeNull();
    expect(resolveModelPath("/root/models", "/etc/passwd")).toBeNull();
  });

  it("resolves a normal relative path inside the root", () => {
    const abs = resolveModelPath("/root/models", "sub/nested.yaml");
    expect(abs).toBe(join("/root/models", "sub", "nested.yaml"));
  });

  it("lists models recursively and sorted", () => {
    expect(listModels(modelsRoot)).toEqual([
      "invalid.yaml",
      "sub/nested.yaml",
      "valid.yaml",
    ]);
  });

  it("returns an empty list for a missing root", () => {
    expect(listModels(join(modelsRoot, "does-not-exist"))).toEqual([]);
  });
});

describe("GET /api/models", () => {
  it("lists every model", async () => {
    const { status, json } = await request("GET", "/api/models");
    expect(status).toBe(200);
    expect(json).toEqual({
      models: ["invalid.yaml", "sub/nested.yaml", "valid.yaml"],
      folders: ["sub"],
    });
  });

  it("rejects non-GET methods", async () => {
    const { status } = await request("POST", "/api/models");
    expect(status).toBe(405);
  });
});

describe("GET /api/models/<path>", () => {
  it("returns yaml, parsed model, and no errors for a valid model", async () => {
    const { status, json } = await request("GET", "/api/models/valid.yaml");
    expect(status).toBe(200);
    expect(json).toMatchObject({
      model: { name: "Test Model" },
      errors: null,
    });
    expect(typeof (json as { yaml: string }).yaml).toBe("string");
  });

  it("returns the validation errors for an invalid model (still 200)", async () => {
    const { status, json } = await request("GET", "/api/models/invalid.yaml");
    expect(status).toBe(200);
    expect((json as { errors: unknown[] }).errors).toHaveLength(1);
    expect((json as { model: null }).model).toBeNull();
  });

  it("404s a missing model", async () => {
    const { status } = await request("GET", "/api/models/nope.yaml");
    expect(status).toBe(404);
  });

  it("blocks path traversal", async () => {
    const { body } = await request("GET", "/api/models/..%2f..%2fpackage.json");
    expect(body).not.toContain("@mechflow/mechflow");
  });
});

describe("PUT /api/models/<path>", () => {
  it("writes a valid model atomically and it is retrievable", async () => {
    const put = await request("PUT", "/api/models/new.yaml", VALID_MODEL);
    expect(put.status).toBe(200);
    expect((put.json as { ok: boolean }).ok).toBe(true);

    // The file exists on disk with the exact body we wrote.
    const onDisk = readFileSync(join(modelsRoot, "new.yaml"), "utf8");
    expect(onDisk).toBe(VALID_MODEL);

    const get = await request("GET", "/api/models/new.yaml");
    expect(get.json).toMatchObject({ model: { name: "Test Model" } });
  });

  it("rejects an invalid model with 422 and the error list", async () => {
    const { status, json } = await request("PUT", "/api/models/bad.yaml", INVALID_MODEL);
    expect(status).toBe(422);
    expect((json as { errors: unknown[] }).errors).toHaveLength(1);
    // Nothing was written for the rejected model.
    expect(existsSync(join(modelsRoot, "bad.yaml"))).toBe(false);
  });

  it("rejects a traversal path with 400", () => {
    const captured = captureRes();
    handlePutModel(modelsRoot, "../escape.yaml", VALID_MODEL, captured.res);
    expect(captured.getStatus()).toBe(400);
    expect(existsSync(join(modelsRoot, "escape.yaml"))).toBe(false);
  });
});

describe("model management API", () => {
  it("publishes a create exclusively and preserves an intervening source replacement", () => {
    const target = join(modelsRoot, "exclusive.yaml");
    writeFileSync(target, "existing contents");
    const captured = captureRes();
    handlePutModel(modelsRoot, "exclusive.yaml", VALID_MODEL, captured.res, undefined, "*");
    expect(captured.getStatus()).toBe(409);
    expect(readFileSync(target, "utf8")).toBe("existing contents");

    const source = join(modelsRoot, "racy.yaml");
    writeFileSync(source, "original contents");
    const staged = stageModel(source);
    writeFileSync(source, "replacement contents");
    const recovered = restoreStaged(source, staged);
    expect(readFileSync(source, "utf8")).toBe("replacement contents");
    expect(recovered).toBeTruthy();
    expect(readFileSync(join(modelsRoot, recovered!), "utf8")).toBe("original contents");
  });
  it("creates only when absent, renames, and deletes a model through HTTP", async () => {
    const create = await fetch(`${base}/api/models/managed.yaml`, {
      method: "PUT", headers: { "if-none-match": "*" }, body: VALID_MODEL,
    });
    expect(create.status).toBe(200);
    const duplicate = await fetch(`${base}/api/models/managed.yaml`, {
      method: "PUT", headers: { "if-none-match": "*" }, body: VALID_MODEL.replace("Test Model", "Overwrite"),
    });
    expect(duplicate.status).toBe(409);
    expect(readFileSync(join(modelsRoot, "managed.yaml"), "utf8")).toBe(VALID_MODEL);

    const opened = await (await fetch(`${base}/api/models/managed.yaml`)).json() as { hash: string };
    const rename = await fetch(`${base}/api/models/managed.yaml/rename`, {
      method: "POST", headers: { "content-type": "application/json", "if-match": opened.hash },
      body: JSON.stringify({ path: "renamed.yaml" }),
    });
    expect(rename.status).toBe(200);
    expect(existsSync(join(modelsRoot, "managed.yaml"))).toBe(false);
    expect(readFileSync(join(modelsRoot, "renamed.yaml"), "utf8")).toBe(VALID_MODEL);

    const staleDelete = await fetch(`${base}/api/models/renamed.yaml`, {
      method: "DELETE", headers: { "if-match": "stale" },
    });
    expect(staleDelete.status).toBe(409);
    expect(existsSync(join(modelsRoot, "renamed.yaml"))).toBe(true);
    const deleted = await fetch(`${base}/api/models/renamed.yaml`, {
      method: "DELETE", headers: { "if-match": opened.hash },
    });
    expect(deleted.status).toBe(200);
    expect(existsSync(join(modelsRoot, "renamed.yaml"))).toBe(false);
  });

  it("rejects rename collisions, traversal, and invalid destinations", async () => {
    const post = (path: string) => fetch(`${base}/api/models/valid.yaml/rename`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    expect((await post("sub/nested.yaml")).status).toBe(409);
    expect((await post("../escape.yaml")).status).toBe(400);
    expect((await post("bad.txt")).status).toBe(400);
    expect(existsSync(join(modelsRoot, "valid.yaml"))).toBe(true);
  });
});

describe("GET /api/models/<path>/report", () => {
  it("returns the analysis report for a valid model", async () => {
    const { status, json } = await request("GET", "/api/models/valid.yaml/report");
    expect(status).toBe(200);
    const report = json as {
      modelName: string;
      generatedFrom: string;
      summary: { errors: number; warnings: number; infos: number };
    };
    expect(report.modelName).toBe("Test Model");
    expect(report.generatedFrom).toMatch(/^[0-9a-f]{8}$/);
    expect(report.summary).toMatchObject({ errors: 0, warnings: 0, infos: 0 });
  });

  it("422s an invalid model", async () => {
    const { status, json } = await request("GET", "/api/models/invalid.yaml/report");
    expect(status).toBe(422);
    expect((json as { errors: unknown[] }).errors).toHaveLength(1);
  });
});

describe("POST /api/folders", () => {
  const post = async (body: unknown) => {
    const res = await fetch(`${base}/api/folders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as unknown };
  };

  it("creates a nested folder, missing parents included, and lists it while empty", async () => {
    expect(await post({ path: "GameA/Economy" })).toEqual({ status: 201, json: { ok: true, path: "GameA/Economy" } });
    const { json } = await request("GET", "/api/models");
    expect((json as { folders: string[] }).folders).toEqual(expect.arrayContaining(["GameA", "GameA/Economy"]));
  });

  it("keeps same-named models in different games apart", async () => {
    await post({ path: "GameB/Economy" });
    const put = (path: string) => fetch(`${base}/api/models/${path}`, {
      method: "PUT", headers: { "content-type": "text/plain", "if-none-match": "*" }, body: VALID_MODEL,
    });
    expect((await put("GameA/Economy/graph.yaml")).status).toBe(200);
    expect((await put("GameB/Economy/graph.yaml")).status).toBe(200);
    const { json } = await request("GET", "/api/models");
    expect((json as { models: string[] }).models).toEqual(
      expect.arrayContaining(["GameA/Economy/graph.yaml", "GameB/Economy/graph.yaml"]),
    );
  });

  it("rejects a folder that exists, escapes the root, or is hidden", async () => {
    expect((await post({ path: "sub" })).status).toBe(409);
    expect((await post({ path: "sub/nested.yaml" })).status).toBe(409);
    expect((await post({ path: "../outside" })).status).toBe(400);
    expect((await post({ path: "GameA/.secret" })).status).toBe(400);
    expect((await post({ path: "" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });

  it("refuses to create a folder through a symlink that leaves the root", async () => {
    const outside = mkdtempSync(join(tmpdir(), "mechflow-outside-"));
    symlinkSync(outside, join(modelsRoot, "escape"));
    expect((await post({ path: "escape/inner" })).status).toBe(400);
    expect(existsSync(join(outside, "inner"))).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("POST /api/folders/rename and /delete", () => {
  const post = async (route: string, body: unknown) => {
    const res = await fetch(`${base}/api/folders${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as unknown };
  };
  const models = async () => ((await request("GET", "/api/models")).json as { models: string[]; folders: string[] });

  beforeAll(() => {
    mkdirSync(join(modelsRoot, "Move", "Old", "Deep"), { recursive: true });
    writeFileSync(join(modelsRoot, "Move", "Old", "m.yaml"), VALID_MODEL);
    mkdirSync(join(modelsRoot, "Move", "Taken"), { recursive: true });
    mkdirSync(join(modelsRoot, "Hollow", "Inner"), { recursive: true });
  });

  it("renames a folder with its models, and moves one into a new parent", async () => {
    expect(await post("/rename", { path: "Move/Old", to: "Move/New" })).toEqual({ status: 200, json: { ok: true, path: "Move/New" } });
    expect((await models()).models).toContain("Move/New/m.yaml");
    expect((await post("/rename", { path: "Move/New", to: "Elsewhere/Sub/New" })).status).toBe(200);
    const after = await models();
    expect(after.models).toContain("Elsewhere/Sub/New/m.yaml");
    expect(after.folders).toEqual(expect.arrayContaining(["Elsewhere/Sub/New/Deep"]));
  });

  it("refuses a rename onto an existing path, into itself, out of the root, or of a missing folder", async () => {
    expect((await post("/rename", { path: "Elsewhere", to: "Move/Taken" })).status).toBe(409);
    expect((await post("/rename", { path: "Elsewhere", to: "Elsewhere/Sub/Inside" })).status).toBe(400);
    expect((await post("/rename", { path: "Elsewhere", to: "../out" })).status).toBe(400);
    expect((await post("/rename", { path: "Nope", to: "Fine" })).status).toBe(404);
    expect((await post("/rename", { path: "valid.yaml", to: "Fine" })).status).toBe(404);
    expect((await post("/rename", { path: "Elsewhere" })).status).toBe(400);
  });

  it("deletes a folder holding only empty folders, and refuses one with files", async () => {
    expect((await post("/delete", { path: "Elsewhere" })).status).toBe(409);
    expect(existsSync(join(modelsRoot, "Elsewhere", "Sub", "New", "m.yaml"))).toBe(true);
    expect(await post("/delete", { path: "Hollow" })).toEqual({ status: 200, json: { ok: true } });
    expect(existsSync(join(modelsRoot, "Hollow"))).toBe(false);
    expect((await post("/delete", { path: "Hollow" })).status).toBe(404);
    expect((await post("/delete", { path: "../" })).status).toBe(404);
  });
});

describe("static serving", () => {
  it("serves index.html for the SPA root", async () => {
    const { status, body } = await request("GET", "/");
    expect(status).toBe(200);
    expect(body).toContain("<!doctype html>");
  });

  it("serves static assets with a content type", async () => {
    const { status, body } = await request("GET", "/assets/app.js");
    expect(status).toBe(200);
    expect(body).toContain("mechflow");
  });

  it("falls back to index.html for unknown client routes", async () => {
    const { status } = await request("GET", "/graph");
    expect(status).toBe(200);
  });
});
