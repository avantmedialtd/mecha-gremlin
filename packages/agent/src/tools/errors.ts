/** `Object()` wraps anything thrown, null and strings too, so reading from it can't fail. */
export const errorCode = (error: unknown): unknown => {
    return Object(error).code;
};

export const reasonOf = (error: unknown): string => {
    return error instanceof Error ? error.message : String(error);
};
