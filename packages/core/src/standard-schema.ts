// Standard Schema v1 and Standard JSON Schema (https://standardschema.dev), copied here as the spec
// suggests, so `core` depends on no schema library. Compatibility is structural: zod 4 and other
// implementations fit without importing anything from here.

export type StandardTypedV1<Input = unknown, Output = Input> = {
    readonly '~standard': StandardTypedV1.Props<Input, Output>;
};

export declare namespace StandardTypedV1 {
    type Props<Input = unknown, Output = Input> = {
        readonly version: 1;
        readonly vendor: string;
        readonly types?: Types<Input, Output> | undefined;
    };

    type Types<Input = unknown, Output = Input> = {
        readonly input: Input;
        readonly output: Output;
    };
}

export type StandardSchemaV1<Input = unknown, Output = Input> = {
    readonly '~standard': StandardSchemaV1.Props<Input, Output>;
};

export declare namespace StandardSchemaV1 {
    type Props<Input = unknown, Output = Input> = StandardTypedV1.Props<Input, Output> & {
        readonly validate: (
            value: unknown,
            options?: Options,
        ) => Result<Output> | Promise<Result<Output>>;
    };

    type Options = {
        readonly libraryOptions?: Readonly<Record<string, unknown>> | undefined;
    };

    type Result<Output> = SuccessResult<Output> | FailureResult;

    type SuccessResult<Output> = {
        readonly value: Output;
        readonly issues?: undefined;
    };

    type FailureResult = {
        readonly issues: ReadonlyArray<Issue>;
    };

    type Issue = {
        readonly message: string;
        readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
    };

    type PathSegment = {
        readonly key: PropertyKey;
    };
}

export type StandardJSONSchemaV1<Input = unknown, Output = Input> = {
    readonly '~standard': StandardJSONSchemaV1.Props<Input, Output>;
};

export declare namespace StandardJSONSchemaV1 {
    type Props<Input = unknown, Output = Input> = StandardTypedV1.Props<Input, Output> & {
        readonly jsonSchema: Converter;
    };

    type Converter = {
        /** May throw for a target the library doesn't support. */
        readonly input: (options: Options) => Record<string, unknown>;
        /** May throw for a target the library doesn't support. */
        readonly output: (options: Options) => Record<string, unknown>;
    };

    /** The spec asks libraries to support `draft-2020-12` and `draft-07`; others are best effort. */
    type Target = 'draft-2020-12' | 'draft-07' | 'openapi-3.0' | ({} & string);

    type Options = {
        readonly target: Target;
        readonly libraryOptions?: Readonly<Record<string, unknown>> | undefined;
    };
}
