// Times as the `mcp` command takes and shows them: a whole number and a unit, as in 90s or 2m.
import { type Result, err, ok } from '@mecha-gremlin/core/result';
import { LONGEST_TIMEOUT_MS, SHORTEST_TIMEOUT_MS } from '../mcp/entry.ts';

// From the largest, so that a time is shown in the largest unit that divides it.
const UNITS = [
    ['h', 3_600_000],
    ['m', 60_000],
    ['s', 1000],
    ['ms', 1],
] as const;

const DIGITS = /^\d+$/;

const millisecondsOf = (text: string): number | undefined => {
    for (const [unit, size] of UNITS) {
        const number = text.slice(0, -unit.length);

        if (text.endsWith(unit) && DIGITS.test(number)) {
            return Number(number) * size;
        }
    }

    return undefined;
};

/** A time in the largest unit that divides it exactly. */
export const durationOf = (milliseconds: number): string => {
    for (const [unit, size] of UNITS) {
        if (milliseconds % size === 0) {
            return `${milliseconds / size}${unit}`;
        }
    }

    return `${milliseconds}ms`;
};

/**
 * A time option's value in milliseconds, or what is wrong with it. A bare number is refused,
 * since nothing in it says whether it counts seconds or milliseconds.
 */
export const readTime = (option: string, text: string): Result<number, string> => {
    const milliseconds = millisecondsOf(text);

    if (milliseconds === undefined) {
        return err(
            DIGITS.test(text)
                ? `${option} needs a unit, as in 30s: ms, s, m or h.`
                : `${option} must be a whole number and a unit, ms, s, m or h, as in 90s.`,
        );
    }

    return milliseconds >= SHORTEST_TIMEOUT_MS && milliseconds <= LONGEST_TIMEOUT_MS
        ? ok(milliseconds)
        : err(
              `${option} must be from ${durationOf(SHORTEST_TIMEOUT_MS)} to ${LONGEST_TIMEOUT_MS}ms, about 24 days.`,
          );
};
