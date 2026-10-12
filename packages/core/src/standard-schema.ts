// The Standard Schema v1 and Standard JSON Schema interfaces (https://standardschema.dev), declared
// here as types, as the spec suggests, so `core` depends on no schema library. Any library that
// implements both (zod 4, for one) can define a tool's arguments. Compatibility is structural.

/** The properties every standard shares. */
export interface StandardTypedV1<Input = unknown, Output = Input> {
    readonly "~standard": StandardTypedV1.Props<Input, Output>;
}

export declare namespace StandardTypedV1 {
    interface Props<Input = unknown, Output = Input> {
        /** The version number of the standard. */
        readonly version: 1;
        /** The name of the schema library. */
        readonly vendor: string;
        /** Inferred types associated with the schema. */
        readonly types?: Types<Input, Output> | undefined;
    }

    interface Types<Input = unknown, Output = Input> {
        readonly input: Input;
        readonly output: Output;
    }
}

/** A schema that validates values. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
    readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

export declare namespace StandardSchemaV1 {
    interface Props<Input = unknown, Output = Input> extends StandardTypedV1.Props<Input, Output> {
        /** Validates an unknown value, synchronously or not. */
        readonly validate: (
            value: unknown,
            options?: Options | undefined,
        ) => Result<Output> | Promise<Result<Output>>;
    }

    interface Options {
        readonly libraryOptions?: Record<string, unknown> | undefined;
    }

    type Result<Output> = SuccessResult<Output> | FailureResult;

    interface SuccessResult<Output> {
        readonly value: Output;
        /** The absence of issues indicates success. */
        readonly issues?: undefined;
    }

    interface FailureResult {
        readonly issues: ReadonlyArray<Issue>;
    }

    interface Issue {
        readonly message: string;
        readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
    }

    interface PathSegment {
        readonly key: PropertyKey;
    }
}

/** A schema that describes itself as JSON Schema. */
export interface StandardJSONSchemaV1<Input = unknown, Output = Input> {
    readonly "~standard": StandardJSONSchemaV1.Props<Input, Output>;
}

export declare namespace StandardJSONSchemaV1 {
    interface Props<Input = unknown, Output = Input> extends StandardTypedV1.Props<Input, Output> {
        readonly jsonSchema: Converter;
    }

    interface Converter {
        /** The JSON Schema of the values the schema accepts. May throw for an unsupported target. */
        readonly input: (options: Options) => Record<string, unknown>;
        /** The JSON Schema of the values the schema produces. May throw for an unsupported target. */
        readonly output: (options: Options) => Record<string, unknown>;
    }

    /** The JSON Schema dialect to generate. `draft-2020-12` and `draft-07` are widely supported. */
    type Target = "draft-2020-12" | "draft-07" | "openapi-3.0" | ({} & string);

    interface Options {
        readonly target: Target;
        readonly libraryOptions?: Record<string, unknown> | undefined;
    }
}
