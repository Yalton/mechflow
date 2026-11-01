import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { simulate, parseModelYaml } from "@mechflow/core";
import { readFileSync } from "node:fs";
import { createMcpServer } from "../src/server.js";

const ECONOMY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/examples/economy.yaml",
);

let root: string;
let client: Client;

// The tool returns JSON whose shape each test checks field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(args: Record<string, unknown>): Promise<{ body: any; isError: boolean }> {
  const res = await client.request(
    { method: "tools/call", params: { name: "simulate", arguments: args } },
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
  root = mkdtempSync(path.join(tmpdir(), "mechflow-simulate-"));
  copyFileSync(ECONOMY, path.join(root, "economy.yaml"));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createMcpServer(root).connect(serverTransport);
  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

describe("simulate tool", () => {
  it("returns per-pool series that match the core trace", async () => {
    const { body, isError } = await call({ path: "economy.yaml", seed: 1, steps: 10 });
    expect(isError).toBe(false);
    const parsed = parseModelYaml(readFileSync(ECONOMY, "utf8"));
    if (!parsed.ok) throw new Error("example");
    const core = simulate(parsed.model, { seed: 1, steps: 10 });
    if (!core.ok) throw new Error("core");
    expect(body.path).toBe("economy.yaml");
    expect(body.stepsRun).toBe(10);
    expect(body.end).toEqual({ reason: "steps", step: 10 });
    expect(Object.keys(body.pools).sort()).toEqual(["market", "reserve", "treasury", "workshop"]);
    expect(body.pools.treasury).toEqual([
      core.trace.initial.amounts.treasury,
      ...core.trace.steps.map((s) => s.amounts.treasury),
    ]);
    expect(body.steps).toHaveLength(10);
    expect(body.steps[0]).toMatchObject({ step: 1, inTransit: 0 });
    expect(body.totals.moved.treasury_to_workshop).toBe(
      core.trace.steps.reduce((n, s) => n + (s.moved.treasury_to_workshop ?? 0), 0),
    );
  });

  it("limits the series to the requested pools", async () => {
    const { body } = await call({ path: "economy.yaml", seed: 1, steps: 3, pools: ["market"] });
    expect(Object.keys(body.pools)).toEqual(["market"]);
    expect(body.pools.market).toHaveLength(4);
  });

  it("refuses a pools filter naming something that is not a pool", async () => {
    const { body, isError } = await call({
      path: "economy.yaml",
      seed: 1,
      steps: 3,
      pools: ["gold"],
    });
    expect(isError).toBe(true);
    expect(body).toBe("not a pool: gold");
  });

  it("returns the full trace on request", async () => {
    const { body } = await call({ path: "economy.yaml", seed: 2, steps: 2, detail: "full" });
    expect(body.steps).toHaveLength(2);
    expect(body.steps[0].moved).toBeDefined();
    expect(body.initial.amounts.treasury).toBe(1000);
  });

  it("is reproducible for a seed", async () => {
    const a = await call({ path: "economy.yaml", seed: 5, steps: 20 });
    const b = await call({ path: "economy.yaml", seed: 5, steps: 20 });
    expect(a.body).toEqual(b.body);
  });

  it("returns option errors as data", async () => {
    const { body, isError } = await call({
      path: "economy.yaml",
      seed: 1,
      steps: 5,
      interactive: { treasury: "always" },
    });
    expect(isError).toBe(true);
    expect(body.errors).toEqual([
      { path: "options.interactive.treasury", message: '"treasury" is not an interactive node' },
    ]);
  });

  it("reports a missing file and an invalid model cleanly", async () => {
    expect((await call({ path: "nope.yaml", seed: 1, steps: 1 })).isError).toBe(true);
    writeFileSync(path.join(root, "bad.yaml"), "version: 1\nname: ''\n");
    const bad = await call({ path: "bad.yaml", seed: 1, steps: 1 });
    expect(bad.isError).toBe(true);
    expect(bad.body.valid).toBe(false);
  });
});
