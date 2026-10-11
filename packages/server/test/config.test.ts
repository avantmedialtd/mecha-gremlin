import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
    test("defaults apply when nothing is set", () => {
        expect(loadConfig({})).toEqual({
            ok: true,
            config: {
                baseUrl: "http://127.0.0.1:1234",
                apiToken: "lm-studio",
                model: undefined,
                reasoningEffort: "none",
            },
        });
    });

    test("blank values count as unset", () => {
        const result = loadConfig({ LMSTUDIO_MODEL: "  ", LMSTUDIO_API_TOKEN: "" });
        expect(result).toMatchObject({
            ok: true,
            config: { model: undefined, apiToken: "lm-studio" },
        });
    });

    test("a trailing slash on the base URL is removed", () => {
        const result = loadConfig({ LMSTUDIO_BASE_URL: "http://studio.local:1234/" });
        expect(result).toMatchObject({ ok: true, config: { baseUrl: "http://studio.local:1234" } });
    });

    test("model, token and reasoning effort are passed through", () => {
        const result = loadConfig({
            LMSTUDIO_MODEL: "prism-ml/bonsai-27b",
            LMSTUDIO_API_TOKEN: "sk-lm-secret",
            LMSTUDIO_REASONING_EFFORT: "low",
        });
        expect(result).toMatchObject({
            ok: true,
            config: {
                model: "prism-ml/bonsai-27b",
                apiToken: "sk-lm-secret",
                reasoningEffort: "low",
            },
        });
    });

    test.each([
        "not a url",
        "ftp://127.0.0.1:1234",
        "http://127.0.0.1:1234/v1",
        "http://127.0.0.1:1234/?x=1",
    ])("rejects LMSTUDIO_BASE_URL=%p", (value) => {
        const result = loadConfig({ LMSTUDIO_BASE_URL: value });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.problems.join("\n")).toContain("LMSTUDIO_BASE_URL");
    });

    test("rejects an unknown reasoning effort", () => {
        const result = loadConfig({ LMSTUDIO_REASONING_EFFORT: "extreme" });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.problems.join("\n")).toContain("LMSTUDIO_REASONING_EFFORT");
    });

    test("reports every invalid variable at once", () => {
        const result = loadConfig({
            LMSTUDIO_BASE_URL: "nope",
            LMSTUDIO_REASONING_EFFORT: "extreme",
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.problems).toHaveLength(2);
    });
});
