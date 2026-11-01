import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../src/server.js";

const VALID_YAML = `version: 1
name: Test
properties:
  - id: gold
    kind: number
subsystems:
  - id: core
    name: Core
    tier: core
nodes:
  - id: shop
    kind: mechanic
    name: Shop
    reads: [gold]
    writes: [gold]
  - id: bank
    kind: mechanic
    name: Bank
    reads: [gold]
    writes: [gold]
edges:
  - id: e1
    kind: interaction
    from: shop
    to: bank
    label: pays
noInteraction: []
invariants: []
`;

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

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "mechflow-mcp-"));
  await connectServer();
});

afterEach(async () => {
  await client.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

describe("list_models", () => {
  it("lists yaml files relative to the root", async () => {
    const target = path.join(root, "hub.yaml");
    writeFileSync(target, VALID_YAML);
    const { text, isError } = await callTool("list_models");
    expect(isError).toBe(false);
    const models = JSON.parse(text) as string[];
    expect(models).toContain("hub.yaml");
  });
});

describe("read_model", () => {
  it("returns a valid model with its YAML", async () => {
    const target = path.join(root, "model.yaml");
    writeFileSync(target, VALID_YAML);
    const { text, isError } = await callTool("read_model", { path: "model.yaml" });
    expect(isError).toBe(false);
    const parsed = JSON.parse(text);
    expect(parsed.valid).toBe(true);
    expect(parsed.yaml).toContain("name: Test");
  });

  it("returns validation errors for an invalid model", async () => {
    const target = path.join(root, "bad.yaml");
    writeFileSync(target, INVALID_YAML);
    const { text, isError } = await callTool("read_model", { path: "bad.yaml" });
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.valid).toBe(false);
    expect(Array.isArray(parsed.errors)).toBe(true);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });
});

describe("write_model", () => {
  it("writes a valid model to disk", async () => {
    const { isError } = await callTool("write_model", { path: "new.yaml", yaml: VALID_YAML });
    expect(isError).toBe(false);
    expect(existsSync(path.join(root, "new.yaml"))).toBe(true);
  });

  it("refuses to write an invalid model", async () => {
    const { isError } = await callTool("write_model", { path: "bad.yaml", yaml: INVALID_YAML });
    expect(isError).toBe(true);
    expect(existsSync(path.join(root, "bad.yaml"))).toBe(false);
  });
});

describe("patch_model", () => {
  it("applies operations, validates, and writes the serialized model", async () => {
    await callTool("write_model", { path: "model.yaml", yaml: VALID_YAML });
    const { text, isError } = await callTool("patch_model", {
      path: "model.yaml",
      operations: [{ op: "add_node", node: { id: "temple", kind: "mechanic", name: "Temple", reads: ["gold"], writes: [] } }],
    });
    expect(isError).toBe(false);
    const parsed = JSON.parse(text);
    expect(parsed.written).toBe(true);
    expect(parsed.serialized).toContain("temple");

    // The on-disk file now contains the new node and is still valid.
    const onDisk = readFileSync(path.join(root, "model.yaml"), "utf8");
    expect(onDisk).toContain("Temple");
    expect(/name:\s*Temple/.test(onDisk)).toBe(true);
  });

  it("refuses a patch that produces an invalid model", async () => {
    await callTool("write_model", { path: "model.yaml", yaml: VALID_YAML });
    const { text, isError } = await callTool("patch_model", {
      path: "model.yaml",
      operations: [{ op: "add_node", node: { id: "shop", kind: "mechanic", name: "Dup", reads: [], writes: [] } }],
    });
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.written).toBe(false);
    expect(Array.isArray(parsed.errors)).toBe(true);
  });

  it("refuses a path that escapes the models root", async () => {
    const { isError } = await callTool("read_model", { path: "../secret.yaml" });
    expect(isError).toBe(true);
  });
});
