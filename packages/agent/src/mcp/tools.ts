// A server's tools, listed leniently: the SDK's listTools() loses a whole server over one
// malformed tool (Brief R18.2), so the agent sends tools/list itself, with a loose result
// schema, and checks each tool alone.
import { createHash } from 'node:crypto';
import { type Result, err, ok } from '@mecha-gremlin/core/result';
import type { ToolSchema } from '@mecha-gremlin/core/tools';
import {
    type Client,
    type JsonSchemaType,
    type StandardSchemaWithJSON,
    fromJsonSchema,
    isSpecType,
} from '@modelcontextprotocol/client';
import {
    Ajv,
    AjvJsonSchemaValidator,
    addFormats,
} from '@modelcontextprotocol/client/validators/ajv';
import { z } from 'zod';
import type { Redact } from './redact.ts';

export type ListedTool = {
    /** The tool's name as the server lists it. */
    readonly name: string;
    readonly description: string;
    readonly schema: ToolSchema<unknown>;
    /** The patched copy of its input schema: what the model is sent. */
    readonly inputSchema: Readonly<Record<string, unknown>>;
};

export type ToolWarning = {
    readonly message: 'mcp tool dropped' | 'mcp exclusion unmatched';
    readonly tool: string | undefined;
    readonly reason: string;
};

export type Listing = {
    readonly tools: readonly ListedTool[];
    readonly warnings: readonly ToolWarning[];
    /** A SHA-256 of the list as it came, so that a change between runs shows. */
    readonly catalog: string;
};

export type ListOptions = {
    readonly includeTools: readonly string[] | undefined;
    readonly excludeTools: readonly string[];
    /** What is left of the server's startupTimeoutMs, for each page's request. */
    readonly remaining: () => number;
    readonly signal: AbortSignal;
    readonly redact: Redact;
};

const MAX_PAGES = 64;

// Anthropic refuses a whole request over one of these at an input schema's root (Brief R18.2).
const ROOT_UNIONS = ['oneOf', 'allOf', 'anyOf'];

// The keywords whose values are schemas, and those whose values hold schemas by name or position.
const SCHEMA_KEYWORDS = [
    'items',
    'additionalItems',
    'additionalProperties',
    'contains',
    'propertyNames',
    'not',
    'if',
    'then',
    'else',
    'unevaluatedItems',
    'unevaluatedProperties',
];

const SCHEMA_MAPS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'];

const SCHEMA_LISTS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];

const Page = z.looseObject({ tools: z.array(z.unknown()) });

// What isSpecType.Tool lets through.
type McpTool = typeof isSpecType.Tool extends ((value: unknown) => value is infer T) ? T : never;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const patchEach = (value: unknown, patch: (schema: unknown) => unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map(patch);
    }

    return isRecord(value)
        ? Object.fromEntries(Object.entries(value).map(([key, schema]) => [key, patch(schema)]))
        : value;
};

// An object schema without properties, or an array schema without items, gets an empty one, which
// accepts the same values: some providers refuse a schema without them (Brief R18.2).
const patchSchema = (schema: unknown): unknown => {
    if (!isRecord(schema)) {
        return schema;
    }

    const patched = Object.fromEntries(
        Object.entries(schema).map(([keyword, value]) => {
            if (SCHEMA_KEYWORDS.includes(keyword)) {
                return [keyword, patchSchema(value)];
            }

            if (SCHEMA_MAPS.includes(keyword) || SCHEMA_LISTS.includes(keyword)) {
                return [keyword, patchEach(value, patchSchema)];
            }

            return [keyword, value];
        }),
    );

    return {
        ...patched,
        ...(schema.type === 'object' && !Object.hasOwn(schema, 'properties')
            ? { properties: {} }
            : {}),
        ...(schema.type === 'array' && !Object.hasOwn(schema, 'items') ? { items: {} } : {}),
    };
};

/**
 * The copy the model is sent, leaving the server's own schema unchanged: fromJsonSchema hands
 * back the object it was given. `$schema` goes, since fromJsonSchema throws for draft-04 and
 * draft-07 is what the model is sent anyway.
 */
export const preflight = (
    inputSchema: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
    const { $schema: _dialect, ...rest } = structuredClone(inputSchema);
    const patched = patchSchema(rest);

    return isRecord(patched) ? { ...patched } : {};
};

/**
 * Whether a schema's type is object, which is all fromJsonSchema's type needs, without the cast
 * that R17.3 needed. isSpecType.Tool has checked it for every tool listed.
 */
export const isObjectSchema = (
    schema: Readonly<Record<string, unknown>>,
): schema is JsonSchemaType => {
    return schema.type === 'object';
};

// A validator that can't print: the default one logs "unknown format … ignored" through
// console, outside the agent's logger (Brief R18.2).
export const silentValidator = (): AjvJsonSchemaValidator => {
    const ajv = new Ajv({ logger: false, strict: false, allErrors: true, validateSchema: false });
    addFormats(ajv);

    return new AjvJsonSchemaValidator(ajv);
};

/** `core`'s ToolSchema over the compiled copy, which validateArgs checks arguments against. */
const toolSchema = (
    inputSchema: Readonly<Record<string, unknown>>,
    compiled: StandardSchemaWithJSON<unknown, unknown>,
): ToolSchema<unknown> => {
    return {
        '~standard': {
            version: 1,
            vendor: 'mcp',
            validate: (value) => compiled['~standard'].validate(value),
            jsonSchema: {
                input: () => ({ ...inputSchema }),
                output: () => ({ ...inputSchema }),
            },
        },
    };
};

// fromJsonSchema compiles at once, and throws for what can't compile, such as an invalid pattern
// or a $ref that can't be resolved.
const compile = (
    inputSchema: Readonly<Record<string, unknown>>,
    validator: AjvJsonSchemaValidator,
): Result<ToolSchema<unknown>, string> => {
    // isSpecType.Tool has already checked the type, so this always holds.
    // Stryker disable next-line all
    const narrowed = isObjectSchema(inputSchema) ? inputSchema : undefined;

    try {
        return ok(toolSchema(inputSchema, fromJsonSchema(narrowed ?? {}, validator)));
    } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
    }
};

const pagesOf = async (client: Client, { remaining, signal }: ListOptions): Promise<unknown[]> => {
    const tools: unknown[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
        const result = await client.request(
            // JSON leaves out a cursor that is undefined, as on the first page.
            { method: 'tools/list', params: { cursor } },
            Page,
            { timeout: remaining(), signal },
        );
        const next = result.nextCursor;
        tools.push(...result.tools);

        if (typeof next !== 'string' || seen.has(next)) {
            break;
        }

        seen.add(next);
        cursor = next;
    }

    return tools;
};

const nameOf = (tool: unknown): string | undefined => {
    const name: unknown = isRecord(tool) ? tool.name : undefined;

    return typeof name === 'string' ? name : undefined;
};

/**
 * A server's tools, filtered, with their schemas patched and compiled. Fails, naming what's
 * wrong, when a tool `includeTools` names isn't listed or can't be offered. That text isn't
 * redacted here: the whole failure is, where it's reported.
 */
export const listTools = async (
    client: Client,
    options: ListOptions,
): Promise<Result<Listing, string>> => {
    const { includeTools, excludeTools, redact } = options;
    const raw = await pagesOf(client, options);
    const warnings: ToolWarning[] = [];
    const listed = new Map<string, McpTool>();
    const drop = (tool: string | undefined, reason: string): void => {
        warnings.push({
            message: 'mcp tool dropped',
            tool: tool === undefined ? undefined : redact(tool),
            reason,
        });
    };

    for (const tool of raw) {
        if (!isSpecType.Tool(tool) || tool.name === '') {
            drop(nameOf(tool), "it isn't a valid MCP tool, or its name is empty");
        } else if (listed.has(tool.name)) {
            drop(tool.name, 'the server lists it twice, and only the first is offered');
        } else {
            listed.set(tool.name, tool);
        }
    }

    // Servers shrink their lists by scope, flags and version, so an exclusion only warns.
    for (const name of excludeTools.filter((each) => !listed.has(each))) {
        warnings.push({
            message: 'mcp exclusion unmatched',
            tool: redact(name),
            reason: "excludeTools names it, but the server doesn't list it",
        });
    }

    const missing = (includeTools ?? []).filter((name) => !listed.has(name));
    const validator = silentValidator();
    const tools: ListedTool[] = [];
    const refused: string[] = [];

    for (const tool of listed.values()) {
        const required = includeTools?.includes(tool.name);

        if (required === false || excludeTools.includes(tool.name)) {
            continue;
        }

        const union = ROOT_UNIONS.find((keyword) => Object.hasOwn(tool.inputSchema, keyword));
        const inputSchema = preflight(tool.inputSchema);
        const compiled =
            union === undefined
                ? compile(inputSchema, validator)
                : err(`its input schema has ${union} at its root, which providers refuse`);

        if (compiled.ok) {
            tools.push({
                name: tool.name,
                description: tool.description ?? '',
                schema: compiled.value,
                inputSchema,
            });
        } else if (required === true) {
            refused.push(`${tool.name}, which its includeTools names: ${compiled.error}`);
        } else {
            drop(tool.name, redact(compiled.error));
        }
    }

    if (missing.length > 0 || refused.length > 0) {
        return err(
            [
                ...(missing.length > 0
                    ? [`it doesn't list ${missing.join(', ')}, which its includeTools names`]
                    : []),
                ...refused.map((reason) => `it can't offer ${reason}`),
            ].join('; '),
        );
    }

    return ok({
        tools,
        warnings,
        catalog: createHash('sha256').update(JSON.stringify(raw)).digest('hex'),
    });
};
