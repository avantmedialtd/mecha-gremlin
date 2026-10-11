import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { fetchModels, pickModel } from "../src/lmstudio.ts";

type Entry = { key: string; type?: string; instances?: string[] };

/** A `/api/v1/models` payload, shaped like LM Studio 0.4's. */
function modelsPayload(...entries: Entry[]) {
  return {
    models: entries.map(({ key, type = "llm", instances = [] }) => ({
      type,
      key,
      display_name: key,
      loaded_instances: instances.map((id) => ({ id, config: { context_length: 8192, parallel: 4 } })),
    })),
  };
}

const config: Config = {
  baseUrl: "http://lmstudio.test:1234",
  apiToken: "test-token",
  model: undefined,
  reasoningEffort: "none",
};

describe("pickModel", () => {
  test("uses the one loaded model", () => {
    const payload = modelsPayload(
      { key: "qwen2.5-0.5b-instruct-mlx" },
      { key: "prism-ml/bonsai-27b", instances: ["prism-ml/bonsai-27b"] },
    );
    expect(pickModel(payload)).toEqual({ ok: true, model: "prism-ml/bonsai-27b" });
  });

  test("uses the first of several and says so", () => {
    const payload = modelsPayload({ key: "a", instances: ["a"] }, { key: "b", instances: ["b"] });
    const choice = pickModel(payload);
    expect(choice).toMatchObject({ ok: true, model: "a" });
    if (choice.ok) {
      expect(choice.note).toContain("first of 2");
      expect(choice.note).toContain("LMSTUDIO_MODEL");
    }
  });

  test("accepts a configured instance id or model key that is loaded", () => {
    const payload = modelsPayload({ key: "qwen3", instances: ["qwen3", "qwen3:2"] });
    expect(pickModel(payload, "qwen3:2")).toEqual({ ok: true, model: "qwen3:2" });
    expect(pickModel(payload, "qwen3")).toEqual({ ok: true, model: "qwen3" });
  });

  test("rejects a configured model that is not loaded, listing what is", () => {
    const payload = modelsPayload({ key: "a", instances: ["a"] }, { key: "b" });
    const choice = pickModel(payload, "b");
    expect(choice.ok).toBe(false);
    if (!choice.ok) {
      expect(choice.reason).toContain("Loaded: a.");
      expect(choice.reason).toContain("lms load b");
    }
  });

  test("fails when no model is loaded", () => {
    const choice = pickModel(modelsPayload({ key: "a" }, { key: "b" }));
    expect(choice.ok).toBe(false);
    if (!choice.ok) expect(choice.reason).toContain("lms load <model>");
  });

  test("ignores loaded embedding models", () => {
    const payload = modelsPayload({ key: "nomic-embed", type: "embedding", instances: ["nomic-embed"] });
    const choice = pickModel(payload);
    expect(choice.ok).toBe(false);
    if (!choice.ok) expect(choice.reason).toContain("No model is loaded");
  });

  // Each case is wrapped in its own row: test.each spreads array rows into arguments.
  test.each([
    [null],
    [[]],
    [{ data: [] }],
    [{ models: [{ key: 1 }] }],
    [{ models: [{ key: "a", type: "llm", loaded_instances: {} }] }],
  ])(
    "reports an unexpected payload shape: %p",
    (payload: unknown) => {
      const choice = pickModel(payload);
      expect(choice.ok).toBe(false);
      if (!choice.ok) expect(choice.reason).toContain("unexpected shape");
    },
  );
});

describe("fetchModels", () => {
  test("calls the native models endpoint with the bearer token", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const result = await fetchModels(config, async (input, init) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
      return Response.json(modelsPayload());
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual([{ url: "http://lmstudio.test:1234/api/v1/models", auth: "Bearer test-token" }]);
  });

  test("explains an unreachable server", async () => {
    const result = await fetchModels(config, async () => {
      throw new TypeError("Unable to connect");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("http://lmstudio.test:1234");
      expect(result.reason).toContain("lms server start");
    }
  });

  test.each([401, 403])("explains a rejected token (HTTP %p)", async (status) => {
    const result = await fetchModels(config, async () => new Response("denied", { status }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("LMSTUDIO_API_TOKEN");
  });

  test("reports other HTTP errors and non-JSON bodies", async () => {
    const notFound = await fetchModels(config, async () => new Response("nope", { status: 404 }));
    expect(notFound).toMatchObject({ ok: false });
    const html = await fetchModels(config, async () => new Response("<html>", { status: 200 }));
    expect(html.ok).toBe(false);
    if (!html.ok) expect(html.reason).toContain("didn't return JSON");
  });
});
