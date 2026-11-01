import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../src/server.js";

const EXAMPLES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/examples");

const INVALID_YAML = `version: 1
name: ""
nodes: not-a-list
`;

let root: string;
let client: Client;

async function connectServer(): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(root);
  await server.connect(serverTransport);
  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
}

interface CallResult {
  text: string;
  isError: boolean;
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  const res = await client.request(
    { method: "tools/call", params: { name, arguments: args } },
    CallToolResultSchema,
  );
  const first = res.content?.[0];
  const text = first && first.type === "text" ? first.text : "";
  return { text, isError: Boolean(res.isError) };
}

/** True if a ghost-edge result contains the pair (order-insensitive). */
function hasPair(ghosts: Array<{ a: string; b: string }>, id1: string, id2: string): boolean {
  const want = [id1, id2].sort().join();
  return ghosts.some((g) => [g.a, g.b].sort().join() === want);
}

function depthOf(result: { levels: Array<{ depth: number; nodes: Array<{ id: string }> }> }, id: string): number {
  const level = result.levels.find((l) => l.nodes.some((n) => n.id === id));
  return level ? level.depth : -1;
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "mechflow-analysis-"));
  cpSync(EXAMPLES_DIR, root, { recursive: true });
  await connectServer();
});

afterEach(async () => {
  await client.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

describe("analyze_model", () => {
  it("returns a combined report with the expected shape", async () => {
    const { text, isError } = await callTool("analyze_model", { path: "dag.yaml" });
    expect(isError).toBe(false);
    const report = JSON.parse(text);
    expect(report.modelName).toBe("DAG");
    expect(report.generatedFrom).toMatch(/^[0-9a-f]{8}$/);
    expect(report.summary).toMatchObject({ errors: 0, warnings: 0, infos: 0, byCheck: {} });
    expect(Array.isArray(report.findings)).toBe(true);
    expect(Array.isArray(report.matrix.ids)).toBe(true);
    expect(Array.isArray(report.ghostEdges)).toBe(true);
  });

  it("flags nothing for the DAG example", async () => {
    const { text } = await callTool("analyze_model", { path: "dag.yaml" });
    const report = JSON.parse(text);
    expect(report.findings.length).toBe(0);
  });

  it("filters checks by id when `checks` is provided", async () => {
    const { text } = await callTool("analyze_model", { path: "elements.yaml", checks: ["ghost-edges"] });
    const report = JSON.parse(text);
    expect(report.findings.length).toBeGreaterThan(0);
    for (const finding of report.findings) {
      expect(finding.check).toBe("ghost-edges");
    }
  });

  it("returns validation errors for an invalid model", async () => {
    const target = path.join(root, "bad.yaml");
    writeFileSync(target, INVALID_YAML);
    const { text, isError } = await callTool("analyze_model", { path: "bad.yaml" });
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.valid).toBe(false);
    expect(Array.isArray(parsed.errors)).toBe(true);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });
});

describe("trace_effects", () => {
  it("traces flow edges level by level from a node", async () => {
    const { text, isError } = await callTool("trace_effects", { path: "hub-spoke.yaml", node: "labour" });
    expect(isError).toBe(false);
    const result = JSON.parse(text);
    // labour (depth 0) -> market (depth 1) -> goods/services/waste (depth 2).
    expect(depthOf(result, "labour")).toBe(0);
    expect(depthOf(result, "market")).toBe(1);
    expect(depthOf(result, "goods")).toBe(2);
    expect(depthOf(result, "services")).toBe(2);
    expect(depthOf(result, "waste")).toBe(2);
  });

  it("respects maxDepth", async () => {
    const { text } = await callTool("trace_effects", { path: "hub-spoke.yaml", node: "labour", maxDepth: 1 });
    const result = JSON.parse(text);
    expect(depthOf(result, "market")).toBe(1);
    expect(depthOf(result, "goods")).toBe(-1);
  });

  it("errors on an unknown node", async () => {
    const { isError } = await callTool("trace_effects", { path: "hub-spoke.yaml", node: "nope" });
    expect(isError).toBe(true);
  });

  it("returns validation errors for an invalid model", async () => {
    writeFileSync(path.join(root, "bad.yaml"), INVALID_YAML);
    const { isError } = await callTool("trace_effects", { path: "bad.yaml", node: "labour" });
    expect(isError).toBe(true);
  });
});

describe("list_ghost_edges", () => {
  it("returns related-but-unconnected pairs sorted by relevance", async () => {
    const { text, isError } = await callTool("list_ghost_edges", { path: "elements.yaml" });
    expect(isError).toBe(false);
    const ghosts = JSON.parse(text);
    expect(ghosts.length).toBeGreaterThan(0);
    // fire writes temperature (shared with water); water and ice both read
    // temperature; electricity reads conductive, which metal_door has.
    expect(hasPair(ghosts, "fire", "water")).toBe(true);
    expect(hasPair(ghosts, "water", "ice")).toBe(true);
    expect(hasPair(ghosts, "electricity", "metal_door")).toBe(true);
  });

  it("returns validation errors for an invalid model", async () => {
    writeFileSync(path.join(root, "bad.yaml"), INVALID_YAML);
    const { isError } = await callTool("list_ghost_edges", { path: "bad.yaml" });
    expect(isError).toBe(true);
  });
});

describe("get_interaction_matrix", () => {
  it("returns the sorted ids and every interacting pair", async () => {
    const { text, isError } = await callTool("get_interaction_matrix", { path: "dag.yaml" });
    expect(isError).toBe(false);
    const matrix = JSON.parse(text);
    expect(matrix.ids).toEqual(["a", "b", "c"]);
    // Every pair interacts in the DAG: a-b, a-c, b-c.
    expect(hasPair(matrix.cells, "a", "b")).toBe(true);
    expect(hasPair(matrix.cells, "a", "c")).toBe(true);
    expect(hasPair(matrix.cells, "b", "c")).toBe(true);
    expect(matrix.cells.length).toBe(3);
  });

  it("returns validation errors for an invalid model", async () => {
    writeFileSync(path.join(root, "bad.yaml"), INVALID_YAML);
    const { isError } = await callTool("get_interaction_matrix", { path: "bad.yaml" });
    expect(isError).toBe(true);
  });
});
