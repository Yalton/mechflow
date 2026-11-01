import { describe, expect, it } from "vitest";
import {
  ConflictError,
  fetchModel,
  saveModel,
} from "../../src/api/models";

interface FakeResponse {
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

function fakeResponse(
  status: number,
  body: unknown,
): FakeResponse & { url: string; init: RequestInit } {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
    url: "",
    init: {},
  };
}

/** Record calls and return a queue of canned responses. */
function fakeFetch(...responses: FakeResponse[]): typeof fetch {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[i++] ?? fakeResponse(500, { error: "no canned response" });
    next.url = String(url);
    next.init = init ?? {};
    return next;
  }) as unknown as typeof fetch;
  fn.calls = calls;
  return fn as typeof fetch & { calls: Array<{ url: string; init: RequestInit }> };
}

describe("fetchModel", () => {
  it("returns the parsed model, yaml, and hash", async () => {
    const fetchImpl = fakeFetch(
      fakeResponse(200, {
        yaml: "name: X",
        model: { name: "X" },
        errors: null,
        hash: "abc123",
      }),
    ) as unknown as typeof fetch;

    const model = await fetchModel("m.yaml", fetchImpl);
    expect(model).toEqual({ yaml: "name: X", model: { name: "X" }, errors: null, hash: "abc123" });
  });

  it("throws when the server is not ok", async () => {
    const fetchImpl = fakeFetch(fakeResponse(404, { error: "not found" })) as unknown as typeof fetch;
    await expect(fetchModel("missing.yaml", fetchImpl)).rejects.toThrow(/404/);
  });
});

describe("saveModel", () => {
  it("sends content-type and returns the written hash", async () => {
    const fetchImpl = fakeFetch(
      fakeResponse(200, { ok: true, model: { name: "X" }, hash: "def456" }),
    ) as unknown as typeof fetch;
    const typed = fetchImpl as ReturnType<typeof fakeFetch>;

    const result = await saveModel("m.yaml", "name: X", undefined, fetchImpl);
    expect(result).toEqual({ ok: true, model: { name: "X" }, hash: "def456" });
    expect(typed.calls[0]).toMatchObject({
      url: "/api/models/m.yaml",
      init: { method: "PUT", headers: { "content-type": "text/plain" } },
    });
    // No If-Match header when no hash was provided.
    expect((typed.calls[0].init.headers as Record<string, string>)["if-match"]).toBeUndefined();
  });

  it("sends the If-Match header when a hash is provided", async () => {
    const fetchImpl = fakeFetch(
      fakeResponse(200, { ok: true, model: {}, hash: "ghi789" }),
    ) as unknown as typeof fetch;
    const typed = fetchImpl as ReturnType<typeof fakeFetch>;

    await saveModel("m.yaml", "name: Y", "abc123", fetchImpl);
    expect((typed.calls[0].init.headers as Record<string, string>)["if-match"]).toBe("abc123");
  });

  it("throws ConflictError with the remote yaml on a 409", async () => {
    const fetchImpl = fakeFetch(
      fakeResponse(409, {
        conflict: true,
        loaded: "abc123",
        hash: "remote99",
        yaml: "name: Remote",
      }),
    ) as unknown as typeof fetch;

    await expect(saveModel("m.yaml", "name: Local", "abc123", fetchImpl)).rejects.toMatchObject({
      name: "ConflictError",
      remoteYaml: "name: Remote",
      loadedHash: "abc123",
      remoteHash: "remote99",
    });
  });
});

describe("ConflictError", () => {
  it("carries the paths and hashes", () => {
    const err = new ConflictError("m.yaml", "a", "b", "name: Remote");
    expect(err).toBeInstanceOf(Error);
    expect(err.path).toBe("m.yaml");
    expect(err.loadedHash).toBe("a");
    expect(err.remoteHash).toBe("b");
    expect(err.remoteYaml).toBe("name: Remote");
    expect(err.name).toBe("ConflictError");
  });
});
