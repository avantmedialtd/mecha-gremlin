// Stryker loads Babel 8, whose stack-trace rewriter wraps Bun's native `Error.prepareStackTrace`.
// Vite calls `Error.captureStackTrace` on objects that aren't errors, and Bun's native function
// throws for those (oven-sh/bun#41151), so Stryker can't load its Vitest runner. Set before Babel
// loads, this function is the one Babel wraps, and like V8's own it formats any object.
//
// Remove this file, and the `--preload` flag in package.json's `mutation` script, once that issue
// is fixed.
Error.prepareStackTrace = (error: object, frames: readonly { toString(): string }[]) =>
    [Error.prototype.toString.call(error), ...frames].join('\n    at ');
