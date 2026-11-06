/** `Object()` wraps anything thrown, null and strings too, so reading from it can't fail. */
export const errorCode = (error: unknown): unknown => {
    return Object(error).code;
};

export const reasonOf = (error: unknown): string => {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
};
