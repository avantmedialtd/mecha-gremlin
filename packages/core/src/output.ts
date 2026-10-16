// Brief 4.3's truncateMiddle and normalizeOutput, as a stream: the middle is dropped as the bytes
// arrive, so memory stays bounded by the limit however much a command writes.
export type Capture = {
    // The most bytes kept at each end.
    readonly half: number;
    readonly head: Uint8Array;
    // The first byte after the head, which shows whether the head's cut splits a character.
    readonly next: number | undefined;
    readonly tail: Uint8Array;
    readonly total: number;
};

// An odd limit leaves a byte unused, so that what's dropped always gets its note. A limit below 2
// is a programming error, taken as 2: each end keeps at least a byte.
export const startCapture = (limit: number): Capture => {
    return {
        half: Math.max(Math.floor(limit / 2), 1),
        head: new Uint8Array(0),
        next: undefined,
        tail: new Uint8Array(0),
        total: 0,
    };
};

const concat = (first: Uint8Array, second: Uint8Array): Uint8Array => {
    const joined = new Uint8Array(first.length + second.length);
    joined.set(first);
    joined.set(second, first.length);

    return joined;
};

export const appendCapture = (capture: Capture, chunk: Uint8Array): Capture => {
    const { half } = capture;
    const toHead = chunk.subarray(0, half - capture.head.length);
    const rest = chunk.subarray(toHead.length);

    return {
        half,
        head: concat(capture.head, toHead),
        next: capture.next ?? rest[0],
        tail: concat(capture.tail, rest).slice(-half),
        total: capture.total + chunk.length,
    };
};

export const wasCut = (capture: Capture): boolean => {
    return capture.total > 2 * capture.half;
};

// UTF-8 continuation bytes are 10xxxxxx. A character has at most 3 of them, so in invalid UTF-8 a
// cut moves no more than 3 bytes.
const isContinuation = (byte: number | undefined): boolean => {
    return ((byte ?? 0) & 0xc0) === 0x80;
};

const headEnd = (head: Uint8Array, next: number | undefined): number => {
    let end = head.length;
    let after = next;

    while (end > head.length - 3 && isContinuation(after)) {
        end--;
        after = head[end];
    }

    return end;
};

const tailStart = (tail: Uint8Array): number => {
    let start = 0;

    while (start < 3 && isContinuation(tail[start])) {
        start++;
    }

    return start;
};

// TextDecoder replaces invalid UTF-8 with U+FFFD instead of throwing.
const decode = (bytes: Uint8Array): string => {
    return new TextDecoder().decode(bytes).replaceAll('\0', '␀');
};

export const renderCapture = (capture: Capture): string => {
    const { head, tail, total } = capture;

    if (!wasCut(capture)) {
        return decode(concat(head, tail));
    }

    const end = headEnd(head, capture.next);
    const start = tailStart(tail);
    const omitted = total - end - (tail.length - start);

    return `${decode(head.subarray(0, end))}\n[… ${omitted} bytes omitted …]\n${decode(tail.subarray(start))}`;
};
