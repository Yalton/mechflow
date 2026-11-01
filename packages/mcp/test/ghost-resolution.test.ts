import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { parseModelYaml } from "@mechflow/core";
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

/** The noInteraction records for a pair (order-insensitive) from an on-disk model. */
function noInteractionFor(model: { noInteraction: Array<{ a: string; b: string }> }, id1: string, id2: string) {
  const want = [id1, id2].sort().join();
  return model.noInteraction.filter((n) => [n.a, n.b].sort().join() === want);
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "mechflow-ghost-"));
  cpSyncExamples();
  await connectServer();
});

afterEach(async () => {
  await client.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

/** Copy the example models into the temp models root. */
function cpSyncExamples(): void {
  cpSync(EXAMPLES_DIR, root, { recursive: true });
}

describe("mark_no_interaction", () => {
  it("silences the marked pair in list_ghost_edges", async () => {
    const marked = await callTool("mark_no_interaction", {
      path: "elements.yaml",
      a: "fire",
      b: "water",
      reason: "Designed to be unrelated.",
    });
    expect(marked.isError).toBe(false);

    const { text, isError } = await callTool("list_ghost_edges", { path: "elements.yaml" });
    expect(isError).toBe(false);
    const ghosts = JSON.parse(text);
    expect(hasPair(ghosts, "fire", "water")).toBe(false);
  });

  it("is idempotent — marking the same pair twice keeps a single record", async () => {
    const first = await callTool("mark_no_interaction", { path: "elements.yaml", a: "fire", b: "water", reason: "unrelated" });
    const second = await callTool("mark_no_interaction", { path: "elements.yaml", a: "water", b: "fire", reason: "unrelated" });
    expect(first.isError).toBe(false);
    expect(second.isError).toBe(false);

    const onDisk = readFileSync(path.join(root, "elements.yaml"), "utf8");
    const parsed = parseModelYaml(onDisk);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(noInteractionFor(parsed.model, "fire", "water").length).toBe(1);
  });

  it("preserves pre-existing noInteraction records", async () => {
    await callTool("mark_no_interaction", { path: "elements.yaml", a: "fire", b: "water", reason: "unrelated" });
    const onDisk = readFileSync(path.join(root, "elements.yaml"), "utf8");
    const parsed = parseModelYaml(onDisk);
    if (!parsed.ok) throw new Error("model failed to parse");
    // The original ice-metal_door record is untouched.
    expect(noInteractionFor(parsed.model, "ice", "metal_door").length).toBe(1);
  });

  it("returns validation errors for an invalid model", async () => {
    writeFileSync(path.join(root, "bad.yaml"), INVALID_YAML);
    const { isError } = await callTool("mark_no_interaction", { path: "bad.yaml", a: "x", b: "y", reason: "nope" });
    expect(isError).toBe(true);
  });
});

describe("add_interaction", () => {
  it("adds an interaction edge, writes it, and silences the pair", async () => {
    const { text, isError } = await callTool("add_interaction", {
      path: "elements.yaml",
      from: "fire",
      to: "water",
      label: "ignites",
    });
    expect(isError).toBe(false);
    const res = JSON.parse(text);
    expect(res.written).toBe(true);
    expect(res.edge.kind).toBe("interaction");
    expect(res.edge.from).toBe("fire");
    expect(res.edge.to).toBe("water");
    expect(res.edge.label).toBe("ignites");
    expect(typeof res.edge.id).toBe("string");

    // The edge is on disk with its generated id...
    const onDisk = readFileSync(path.join(root, "elements.yaml"), "utf8");
    expect(onDisk).toContain("fire_to_water");

    // ...and the pair is no longer a ghost.
    const { text: ghostsText } = await callTool("list_ghost_edges", { path: "elements.yaml" });
    const ghosts = JSON.parse(ghostsText);
    expect(hasPair(ghosts, "fire", "water")).toBe(false);
  });

  it("writes optional polarity and strength", async () => {
    const { isError } = await callTool("add_interaction", {
      path: "elements.yaml",
      from: "fire",
      to: "water",
      polarity: "-",
      strength: "modifier",
    });
    expect(isError).toBe(false);
    const onDisk = readFileSync(path.join(root, "elements.yaml"), "utf8");
    const parsed = parseModelYaml(onDisk);
    if (!parsed.ok) throw new Error("model failed to parse");
    const edge = parsed.model.edges.find((e) => e.from === "fire" && e.to === "water");
    expect(edge?.polarity).toBe("-");
    expect(edge?.strength).toBe("modifier");
  });

  it("errors on an unknown endpoint", async () => {
    const { isError } = await callTool("add_interaction", { path: "elements.yaml", from: "fire", to: "ghost" });
    expect(isError).toBe(true);
  });

  it("returns validation errors for an invalid model", async () => {
    writeFileSync(path.join(root, "bad.yaml"), INVALID_YAML);
    const { isError } = await callTool("add_interaction", { path: "bad.yaml", from: "x", to: "y" });
    expect(isError).toBe(true);
  });
});
