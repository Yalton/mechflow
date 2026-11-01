import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { zipSync, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/index.js";

const modelsRoot = mkdtempSync(join(tmpdir(), "mechflow-archive-"));
const webDist = mkdtempSync(join(tmpdir(), "mechflow-archive-web-"));
const server = createServer({ modelsRoot, webDist });
let base: string;
const yaml = "version: 1\nname: Gold snowball\n";

beforeAll(async () => {
  mkdirSync(join(modelsRoot, "ChainShot", "Economy", "empty"), { recursive: true });
  mkdirSync(join(modelsRoot, "Other"));
  writeFileSync(join(modelsRoot, "ChainShot", "Economy", "gold-snowball.yaml"), yaml);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  rmSync(modelsRoot, { recursive: true, force: true });
  rmSync(webDist, { recursive: true, force: true });
});

async function upload(zip: Uint8Array, game?: string): Promise<Response> {
  const suffix = game ? `?game=${encodeURIComponent(game)}` : "";
  return fetch(`${base}/api/archive${suffix}`, { method: "POST", body: Buffer.from(zip), headers: { "content-type": "application/zip" } });
}

describe("archive HTTP round trips", () => {
  it("exports and restores a complete game with graph bytes and empty folders", async () => {
    const response = await fetch(`${base}/api/archive?kind=game&path=ChainShot`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    const zip = new Uint8Array(await response.arrayBuffer());
    const files = unzipSync(zip);
    expect(new TextDecoder().decode(files["content/Economy/gold-snowball.yaml"])).toBe(yaml);
    expect(files["content/Economy/empty/"]).toBeDefined();
    expect((await upload(zip)).status).toBe(409);
    rmSync(join(modelsRoot, "ChainShot"), { recursive: true, force: true });
    const imported = await upload(zip);
    expect(imported.status).toBe(201);
    expect(await imported.json()).toEqual({ path: "ChainShot" });
    expect(readFileSync(join(modelsRoot, "ChainShot", "Economy", "gold-snowball.yaml"), "utf8")).toBe(yaml);
    expect(readdirSync(join(modelsRoot, "ChainShot", "Economy", "empty"))).toEqual([]);
  });

  it("imports an exported folder into a selected existing game", async () => {
    const response = await fetch(`${base}/api/archive?kind=folder&path=ChainShot%2FEconomy`);
    expect(response.status).toBe(200);
    const zip = new Uint8Array(await response.arrayBuffer());
    expect((await upload(zip)).status).toBe(400);
    const imported = await upload(zip, "Other");
    expect(imported.status).toBe(201);
    expect(await imported.json()).toEqual({ path: "Other/Economy" });
    expect(readFileSync(join(modelsRoot, "Other", "Economy", "gold-snowball.yaml"), "utf8")).toBe(yaml);
    expect((await upload(zip, "Other")).status).toBe(409);
  });

  it("rejects unsafe entries and malformed archives without writing files", async () => {
    const manifest = new TextEncoder().encode(JSON.stringify({ version: 1, kind: "game", name: "Unsafe" }));
    const zip = zipSync({ ".mechflow-archive.json": manifest, "content/../escape.yaml": new TextEncoder().encode(yaml) });
    expect((await upload(zip)).status).toBe(400);
    expect((await upload(new Uint8Array([1, 2, 3]))).status).toBe(400);
    expect(existsSync(join(modelsRoot, "Unsafe"))).toBe(false);
    expect(existsSync(join(modelsRoot, "escape.yaml"))).toBe(false);
  });

  it("waits through a concurrent model swap instead of omitting the graph", async () => {
    const source = join(modelsRoot, "ChainShot", "Economy", "gold-snowball.yaml");
    const staged = join(modelsRoot, "ChainShot", "Economy", ".gold-snowball.yaml.tmp-999-abcdef");
    // The export blocks this event loop while it retries, so another process
    // must restore the file. Start that process first and move the file aside
    // only once it is ready: a real swap keeps the file away for microseconds,
    // and a cold Node start under load can outlast the export's retry budget.
    const child = spawn(process.execPath, ["-e",
      "process.stdout.write('ready\\n'); process.stdin.once('data', () => setTimeout(() => " +
      "{ require('node:fs').renameSync(process.argv[1], process.argv[2]); process.exit(0); }, 30))", staged, source],
    { stdio: ["pipe", "pipe", "inherit"] });
    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    renameSync(source, staged);
    child.stdin.write("go\n");
    try {
      const response = await fetch(`${base}/api/archive?kind=game&path=ChainShot`);
      expect(response.status).toBe(200);
      const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
      expect(new TextDecoder().decode(files["content/Economy/gold-snowball.yaml"])).toBe(yaml);
    } finally {
      child.stdin.end();
      await exited;
      if (existsSync(staged)) renameSync(staged, source);
    }
  });

  it("rejects damaged content even when the ZIP structure is intact", async () => {
    const manifest = new TextEncoder().encode(JSON.stringify({ version: 1, kind: "game", name: "Damaged" }));
    const zip = zipSync({ ".mechflow-archive.json": manifest, "content/model.yaml": new TextEncoder().encode(yaml) }, { level: 0 });
    const index = Buffer.from(zip).indexOf(Buffer.from(yaml));
    expect(index).toBeGreaterThan(0);
    zip[index + 9] ^= 1;
    expect((await upload(zip)).status).toBe(400);
    expect(existsSync(join(modelsRoot, "Damaged"))).toBe(false);
  });

  // About 15,000 filesystem operations: under 3 s idle, up to ~11 s on a loaded host.
  it("restores an export at the entry limit", { timeout: 30_000 }, async () => {
    const root = join(modelsRoot, "AtLimit");
    mkdirSync(root);
    try {
      for (let i = 0; i < 4999; i++) mkdirSync(join(root, `f${i}`));
      const response = await fetch(`${base}/api/archive?kind=game&path=AtLimit`);
      expect(response.status).toBe(200);
      const zip = new Uint8Array(await response.arrayBuffer());
      rmSync(root, { recursive: true, force: true });
      expect((await upload(zip)).status).toBe(201);
      expect(readdirSync(root)).toHaveLength(4999);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
