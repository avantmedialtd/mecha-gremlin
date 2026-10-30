// A tool's result as the model gets it: one text. A result is read block by block, so that one
// malformed block doesn't lose the rest, as the SDK's callTool() would (Brief R18.2).
import { isSpecType } from '@modelcontextprotocol/client';
import { characterBoundary } from '../tools/read.ts';

/** As much as one call of the read tool returns. */
export const RESULT_LIMIT = 32 * 1024;

type Described = {
    readonly text: string;
    readonly isText: boolean;
};

const typeOf = (block: unknown): string => {
    const type: unknown =
        typeof block === 'object' && block !== null ? Reflect.get(block, 'type') : undefined;

    return typeof type === 'string' ? type : 'unknown';
};

const notShown = (type: string, mimeType: string | undefined, data: string): string => {
    const described = mimeType === undefined ? type : `${type} ${mimeType}`;

    return `[${described}, ${data.length} base64 characters, not shown]`;
};

const describe = (block: unknown): Described => {
    if (!isSpecType.ContentBlock(block)) {
        return { text: `[${typeOf(block)} block, not shown]`, isText: false };
    }

    switch (block.type) {
        case 'text':
            return { text: block.text, isText: true };
        case 'resource_link': {
            const mimeType = block.mimeType === undefined ? '' : ` (${block.mimeType})`;

            return {
                text: `[resource link: ${block.name} ${block.uri}${mimeType}]`,
                isText: false,
            };
        }
        case 'resource': {
            const { resource } = block;

            return {
                text:
                    'text' in resource
                        ? `[resource ${resource.uri}]\n${resource.text}`
                        : notShown('resource', resource.mimeType, resource.blob),
                isText: false,
            };
        }
        default:
            return { text: notShown(block.type, block.mimeType, block.data), isText: false };
    }
};

/** The blocks joined with line feeds; structured content only when no text block came. */
export const flatten = (content: unknown, structuredContent: unknown): string => {
    const blocks = Array.isArray(content) ? content.map(describe) : [];
    const structured =
        structuredContent === undefined || blocks.some((block) => block.isText)
            ? []
            : [JSON.stringify(structuredContent)];
    const parts = [...blocks.map((block) => block.text), ...structured];

    return parts.length === 0 ? '(no output)' : parts.join('\n');
};

/** At most 32 KiB, cut where a character starts, with a note giving the whole size. */
export const capped = (text: string): string => {
    const bytes = new TextEncoder().encode(text);

    if (bytes.length <= RESULT_LIMIT) {
        return text;
    }

    const cut = characterBoundary(bytes, RESULT_LIMIT);
    const shown = new TextDecoder().decode(bytes.subarray(0, cut));

    return `${shown}\n[The result is ${bytes.length} bytes, so it was cut: these are its first ${cut}.]`;
};
