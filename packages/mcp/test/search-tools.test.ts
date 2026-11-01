import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../src/server.js";

const EXAMPLES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/examples",
);

let root: string;
let client: Client;

// The tools return JSON whose shape each test checks field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;

async function call(
  name: string,
  args: Record<string, unknown>,
): Promise<{ body: Body; isError: boolean }> {
  const res = await client.request(
    { method: "tools/call", params: { name, arguments: args } },
    CallToolResultSchema,
  );
  const first = res.content?.[0];
  const text = first && first.type === "text" ? first.text : "";
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Plain-text error.
  }
  return { body, isError: Boolean(res.isError) };
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "mechflow-search-"));
  for (const name of ["boundary", "combo", "obsolete", "exploit", "narrow"]) {
    copyFileSync(path.join(EXAMPLES, `${name}.yaml`), path.join(root, `${name}.yaml`));
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createMcpServer(root).connect(serverTransport);
  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

describe("search tools", () => {
  it("lists the five tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of [
      "sweep_boundaries",
      "find_dominant_combinations",
      "compare_systems",
      "optimize_player",
      "possibility_space",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("sweep_boundaries finds the exploding army", async () => {
    const { body, isError } = await call("sweep_boundaries", {
      path: "boundary.yaml",
      objective: "strength",
      seed: 1,
      steps: 50,
      runs: 3,
    });
    expect(isError).toBe(false);
    expect(body.findings.map((f: { id: string }) => f.id)).toContain(
      "search-boundary:explosion:army",
    );
    expect(body.report.settings[0]).toEqual({
      label: "defaults",
      score: expect.any(Number),
      problems: expect.any(Array),
    });
    expect(body.evaluationsUsed).toBe(7);
  });

  it("find_dominant_combinations flags the multiplying pair", async () => {
    const { body } = await call("find_dominant_combinations", {
      path: "combo.yaml",
      objective: "wealth",
      seed: 1,
      steps: 30,
      runs: 2,
      k: 2,
    });
    expect(body.findings.map((f: { id: string }) => f.id)).toEqual([
      "search-dominant:pray+sharpen",
    ]);
    expect(body.report.mode).toBe("exhaustive");
    expect(body.report.best[0].nodes).toEqual(["pray", "sharpen"]);
  });

  it("compare_systems flags trade", async () => {
    const { body } = await call("compare_systems", {
      path: "obsolete.yaml",
      objective: "wealth",
      seed: 1,
      steps: 20,
      runs: 4,
    });
    expect(body.findings.map((f: { id: string }) => f.id)).toEqual([
      "search-system-dominance:trade",
    ]);
    expect(body.report.subsystems).toHaveLength(3);
  });

  it("optimize_player finds farming and leaves out the trace unless asked", async () => {
    const args = { path: "exploit.yaml", objective: "wealth", seed: 1, steps: 30, runs: 2 };
    const { body } = await call("optimize_player", args);
    expect(body.findings.map((f: { id: string }) => f.id)).toEqual([
      "search-unintended-optimum:optimizer",
    ]);
    expect(body.report.fires[0].node).toBe("farm");
    expect(body.report.trace).toBeUndefined();
    const full = await call("optimize_player", { ...args, detail: "full" });
    expect(full.body.report.trace.steps).toHaveLength(30);
  });

  it("possibility_space flags the narrow space and the specialist", async () => {
    const { body } = await call("possibility_space", {
      path: "narrow.yaml",
      objective: "wealth",
      seed: 1,
      steps: 10,
      runs: 4,
    });
    expect(body.findings.map((f: { id: string }) => f.id)).toEqual(["search-narrow-space:space"]);
    expect(body.report.viable).toEqual([{ label: "focus:jeweller", score: expect.any(Number) }]);
    expect(body.report.specialists[0]).toMatchObject({
      label: "focus:jeweller",
      dependsOn: "max(price)",
    });
  });

  it("returns option errors as an error result", async () => {
    const { body, isError } = await call("find_dominant_combinations", {
      path: "combo.yaml",
      objective: "nope",
      seed: 1,
      steps: 10,
    });
    expect(isError).toBe(true);
    expect(body.errors).toEqual([
      { path: "options.objective", message: 'unknown objective "nope"' },
    ]);
  });
});
