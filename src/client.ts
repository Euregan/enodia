import {
  Kind,
  DocumentNode,
  ObjectTypeDefinitionNode,
  TypeNode,
  FieldDefinitionNode,
  InputValueDefinitionNode,
  InputObjectTypeDefinitionNode,
  ScalarTypeDefinitionNode,
  EnumTypeDefinitionNode,
} from "graphql";

// Types

type GqlScalarToTs = { gql: string; ts: string };

// Helpers

const isEnum = (
  type: TypeNode | ObjectTypeDefinitionNode,
  enums: Array<EnumTypeDefinitionNode>
): boolean => {
  switch (type.kind) {
    case Kind.OBJECT_TYPE_DEFINITION:
    case Kind.NAMED_TYPE:
      return (
        "name" in type && enums.some((e) => e.name.value === type.name.value)
      );
    case Kind.LIST_TYPE:
    case Kind.NON_NULL_TYPE:
      return isEnum(type.type, enums);
  }
};

const isScalar = (type: TypeNode, scalars: Array<GqlScalarToTs>): boolean => {
  switch (type.kind) {
    case Kind.NAMED_TYPE:
      return scalars.some(({ gql }) => gql === type.name.value);
    case Kind.LIST_TYPE:
    case Kind.NON_NULL_TYPE:
      return isScalar(type.type, scalars);
  }
};

const isGqlTypeOptional = (type: TypeNode): boolean =>
  type.kind !== Kind.NON_NULL_TYPE;

const gqlTypeToGqlString = (type: TypeNode): string => {
  switch (type.kind) {
    case Kind.NAMED_TYPE: {
      return type.name.value;
    }
    case Kind.LIST_TYPE:
      return `[${gqlTypeToGqlString(type.type)}]`;
    case Kind.NON_NULL_TYPE:
      return `${gqlTypeToGqlString(type.type)}!`;
  }
};

const gqlTypeToTsName = (
  type: TypeNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
  suffix?: string
): string => {
  switch (type.kind) {
    case Kind.NAMED_TYPE: {
      const tsType = scalars.find(({ gql }) => gql === type.name.value);
      return tsType
        ? tsType.ts
        : `${type.name.value}${isEnum(type, enums) ? "" : suffix || ""}`;
    }
    case Kind.LIST_TYPE:
    case Kind.NON_NULL_TYPE:
      return gqlTypeToTsName(type.type, scalars, enums, suffix);
  }
};

const gqlTypeToTsString = (
  type: TypeNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
  suffix?: string
): string => {
  switch (type.kind) {
    case Kind.NAMED_TYPE:
      return gqlTypeToTsName(type, scalars, enums, suffix);
    case Kind.LIST_TYPE:
      return `Array<${gqlTypeToTsString(type.type, scalars, enums, suffix)}>`;
    case Kind.NON_NULL_TYPE:
      return gqlTypeToTsString(type.type, scalars, enums, suffix);
  }
};

const fieldsConstraint = (
  type: TypeNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
  generic = "T"
) => `${generic} extends ${gqlTypeToTsName(type, scalars, enums)}Query[number]`;

const queryResult = (
  type: TypeNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>
) =>
  isScalar(type, scalars)
    ? gqlTypeToTsString(type, scalars, enums)
    : `${gqlTypeToTsString(type, scalars, enums, "Result<T>")}${
        type.kind !== Kind.NON_NULL_TYPE ? " | null" : ""
      }`;

const argsToTsDeclaration = (
  args: ReadonlyArray<InputValueDefinitionNode>,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
  withProperty = true
) =>
  `${
    withProperty
      ? `args${args.every((arg) => isGqlTypeOptional(arg.type)) ? "?" : ""}: `
      : ""
  }{ ${args
    .map(
      (arg) =>
        `${arg.name.value}${
          isGqlTypeOptional(arg.type) ? "?" : ""
        }: ${gqlTypeToTsName(arg.type, scalars, enums)}`
    )
    .join(", ")} }`;

const getQueries = (schema: DocumentNode) =>
  schema.definitions.find(
    (node) =>
      node.kind === Kind.OBJECT_TYPE_DEFINITION && node.name.value === "Query"
  ) as ObjectTypeDefinitionNode | undefined;

const getMutations = (schema: DocumentNode) =>
  schema.definitions.find(
    (node) =>
      node.kind === Kind.OBJECT_TYPE_DEFINITION &&
      node.name.value === "Mutation"
  ) as ObjectTypeDefinitionNode | undefined;

// Generators

const imports = (hooks: boolean) =>
  (hooks
    ? ["import { useState, useEffect, useCallback } from 'react'"]
    : []
  ).join("\n");

// TODO: Group imports from same file together
const customScalarsImports = (
  scalarTypes: Record<string, ScalarType>,
  customScalars: Array<ScalarTypeDefinitionNode>
) =>
  customScalars
    .map((scalar, index) => {
      const type = scalarTypes[scalar.name.value];
      if (!type) {
        // TODO: Write a nicer, more detailed error, with steps to solve
        throw `No type for scalar ${scalar.name.value}.`;
      }

      // We make sure not to import twice the same type
      if (
        customScalars.some((s, i) => {
          const t = scalarTypes[s.name.value];
          return (
            "path" in t &&
            "path" in type &&
            t.path === type.path &&
            t.name === type.name &&
            i < index
          );
        })
      ) {
        return null;
      }

      return "path" in type
        ? `import type ${type.name ? "" : scalar.name.value}${
            type.name ? `{ ${type.name} }` : ""
          } from '${type.path}'`
        : null;
    })
    .filter(Boolean)
    .join("\n");

const types = (
  schema: DocumentNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
  react: boolean
) =>
  [
    "type Arguments = string | number | boolean | null | {",
    "    [K in string]: Arguments;",
    `} | Array<Arguments> | ${scalars.map((scalar) => scalar.ts).join(" | ")};`,
    "",
    "type ArgumentTypes = Record<string, string>;",
    "",
    "type Query = Prettify<",
  ]
    .concat(
      (
        schema.definitions.filter(
          (node) =>
            node.kind === Kind.OBJECT_TYPE_DEFINITION &&
            // We don't expose these types
            !["Query", "Mutation"].includes(node.name.value)
        ) as Array<ObjectTypeDefinitionNode>
      ).map(
        (node) =>
          `  | ${node.name.value}${isEnum(node, enums) ? "" : "Query"}[number]`
      )
    )
    .concat([
      ">;",
      "",
      "type Fields = null | Array<Query>;",
      "",
      "type Prettify<T> = {",
      "  [K in keyof T]: T[K];",
      "} & unknown;",
      "",
      "type KeysOfUnion<T> = T extends T ? keyof T: never;",
      "",
      "type CallOptions = {",
      "  fetch?: typeof fetch;",
      "  cache?: boolean",
      "};",
      "",
      "type MergedUnion<T> = (T extends unknown ? (k: T) => void : never) extends ((k: infer I) => void) ? I : never;",
    ])
    .concat(
      react && getQueries(schema)
        ? [
            "",
            "type Error = string;",
            "",
            "/**",
            " * The type returned by the query hook.",
            " */",
            "type QueryResult<Data> =",
            "  /**",
            "   * If the call is still running, then it returns a simple array",
            "   * with `true` as the first element. The next two elements are",
            "   * `null`. The last element is a function to manually call the API.",
            "   */",
            "  | readonly [true, null, null, () => Promise<Data>]",
            "  /**",
            "   * If the call has errored, the array contains `false` as the",
            "   * loading variable, then the error that happened, and finally",
            "   * `null` for the result. The last element is a function to",
            "   *  manually call the API.",
            "   */",
            "  | readonly [false, Error, null, () => Promise<Data>]",
            "  /**",
            "   * If the call has come through, the array contains `false` as the",
            "   * loading variable, `null` for the error, and finally the data",
            "   * returned by the API. The last element is a function to manually",
            "   * call the API.",
            "   */",
            "  | readonly [false, null, Data, () => Promise<Data>];",
          ]
        : []
    )
    .concat(
      react && getMutations(schema)
        ? [
            "",
            "/**",
            " * The type returned by the `useMutation` hook. The first element of",
            " * the array is always a function to call the API, as mutations should",
            " * happen on user input. While the last data returned by the API is",
            " * available as the last element of the array, it can also be accessed",
            " * from the promise returned by the call function.",
            " */",
            "type MutationResult<Payload, Data> =",
            "  /**",
            "   * If the call hasn't been sent yet, or if it is running, then",
            "   * it returns a simple array, with a boolean indicating the",
            "   * loading state as the second element. The two last elements are",
            "   * `null`.",
            "   */",
            "  | [(payload: Payload) => Promise<Data>, boolean, null, null]",
            "  /**",
            "   * If the call has errored, the array contains `false` as the",
            "   * loading variable, then the error that happened, and finally",
            "   * `null` for the result.",
            "   */",
            "  | [(payload: Payload) => Promise<Data>, false, Error, null]",
            "  /**",
            "   * If the call has come through, the array contains `false` as the",
            "   * loading variable, `null` for the error, and finally the data",
            "   * returned by the API.",
            "   */",
            "  | [(payload: Payload) => Promise<Data>, false, null, Data];",
          ]
        : []
    )
    .join("\n");

const queryArgsToTypes = (
  schema: DocumentNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>
) =>
  ["const queryToGqlTypes = {"]
    .concat(
      (
        schema.definitions.filter(
          (node) =>
            node.kind === Kind.OBJECT_TYPE_DEFINITION &&
            // We don't expose these types
            !["Query", "Mutation"].includes(node.name.value)
        ) as Array<ObjectTypeDefinitionNode>
      ).map(
        (node) =>
          `  ${node.name.value}Query: { ${(node.fields || [])
            .filter(
              (field) =>
                !isEnum(field.type, enums) && !isScalar(field.type, scalars)
            )
            .map(
              (field) =>
                `${field.name.value}: { query: '${gqlTypeToTsName(
                  field.type,
                  scalars,
                  enums,
                  "Query"
                )}' as const${
                  (field.arguments || []).length > 0
                    ? `, $args: { ${(field.arguments || [])
                        .map(
                          (argument) =>
                            `${argument.name.value}: '${gqlTypeToGqlString(
                              argument.type
                            )}' as const`
                        )
                        .join(", ")}}`
                    : ""
                } }`
            )
            .join(", ")} },`
      )
    )
    .concat(["};"])
    .join("\n");

const fieldsToQuery = () =>
  [
    "const fieldsToQuery = (query: Fields, path: Array<string> = []): string => {",
    "    if (query === null) {",
    "        return '';",
    "    }",
    "",
    "    const scalars = query.filter(field => typeof field === 'string') as Array<string>;",
    "    const objects = query.filter(field => typeof field !== 'string') as Array<Exclude<Query, string>>;",
    "",
    "    return `{\\n  ${scalars.join('\\n')}\\n${objects",
    "      .map((field) => {",
    "        const key = Object.keys(field).filter((k) => k !== '$args')[0] as Exclude<KeysOfUnion<Exclude<Query, string>>, '$args'>;",
    "",
    "        let queryField = key",
    "",
    "        if ('$args' in field && field.$args) {",
    "          queryField += `(${Object.keys(field.$args)",
    "            .map(",
    "              (arg) =>",
    "                `${arg}: $${path.concat([key, arg]).join('_')}`",
    "            )",
    "            .join('\\n')})`;",
    "        }",
    "",
    "        queryField += ` ${fieldsToQuery((field as MergedUnion<typeof field>)[key], path.concat(key))}`",
    "",
    "        return queryField;",
    "      })",
    "      .join('\\n')}\\n}`;",
    "}",
  ].join("\n");

export const resultsToArgs = () =>
  [
    "const resultsToArgs = (query: keyof typeof queryToGqlTypes, returns: Fields, path: Array<string> = []) =>",
    "  returns",
    "    ? (",
    "        returns.filter((field) => typeof field !== 'string') as Array<",
    "          Exclude<Query, string>",
    "        >",
    "      )",
    "        .map((field) => {",
    "          const key = Object.keys(field).filter((k) => k !== '$args')[0] as Exclude<KeysOfUnion<Exclude<Query, string>>, '$args'>;",
    "",
    "          const queryTypes = queryToGqlTypes[query];",
    "          const types = (queryTypes as MergedUnion<typeof queryTypes>)[key];",
    "",
    "          let args = '';",
    "          if ('$args' in field && field.$args && '$args' in types) {",
    "            args += Object.keys(field.$args)",
    "              .map(",
    "                (arg) =>",
    "                  `$${path.concat([key, arg]).join('_')}: ${types.$args[arg as keyof typeof types.$args]}`",
    "              )",
    "              .join('\\n');",
    "          }",
    "",
    "          args += resultsToArgs(types.query, (field as MergedUnion<typeof field>)[key], path.concat(key))",
    "",
    "          return args;",
    "        })",
    "        .join('\\n')",
    "    : '';",
  ].join("\n");

const argsToGql = () =>
  [
    "const argsToGql = (argTypes: ArgumentTypes, args: Record<string, Arguments>, query: keyof typeof queryToGqlTypes | null, returns: Fields | null) =>",
    "  Object.keys(args)",
    "    .map((key) => `$${key}: ${argTypes[key]}`)",
    "    .concat(query && returns ? resultsToArgs(query, returns) : [])",
    "    .join(', ');",
  ].join("\n");

const variablesToArgs = () =>
  [
    "const variablesToArgs = (args: Record<string, Arguments>) =>",
    "  Object.keys(args)",
    "    .map((key) => `${key}: $${key}`)",
    "    .join(', ');",
  ].join("\n");

const returnsToVariables = () =>
  [
    "const returnsToVariables = (returns: Fields, path: Array<string> = []): Record<string, Arguments> =>",
    "  returns",
    "    ? Object.assign({}, ...(",
    "        returns.filter((field) => typeof field !== 'string') as Array<",
    "          Exclude<Query, string>",
    "        >",
    "      )",
    "        .map((field) => {",
    "          const key = Object.keys(field).filter((k) => k !== '$args')[0] as Exclude<KeysOfUnion<Exclude<Query, string>>, '$args'>;",
    "",
    "          let args: Record<string, Arguments> = {};",
    "          if ('$args' in field && field.$args) {",
    "            args = Object.fromEntries(Object.entries(field.$args)",
    "              .map(",
    "                ([arg, value]) =>",
    "                  [path.concat([key, arg]).join('_'), value]",
    "              ));",
    "          }",
    "",
    "          args = {...args, ...returnsToVariables((field as MergedUnion<typeof field>)[key], path.concat(key))}",
    "",
    "          return args;",
    "        }))",
    "    : {};",
    ,
  ].join("\n");

const cache = () =>
  [
    "const cache: Record<string, any> = {};",
    "",
    "const setCache = (",
    "  query: string,",
    "  returns: Fields,",
    "  args: Record<string, Arguments> | undefined,",
    "  data: any",
    ") => {",
    "  cache[",
    "    `${JSON.stringify(query)}|${JSON.stringify(returns)}|${JSON.stringify(",
    "      args",
    "    )}`",
    "  ] = data;",
    "};",
    "",
    "const hasCache = (",
    "  query: string,",
    "  returns: Fields,",
    "  args: Record<string, Arguments> | undefined",
    ") =>",
    "  `${JSON.stringify(query)}|${JSON.stringify(returns)}|${JSON.stringify(",
    "    args",
    "  )}` in cache;",
    "",
    "const getCache = (",
    "  query: string,",
    "  returns: Fields,",
    "  args: Record<string, Arguments> | undefined",
    ") =>",
    "  cache[",
    "    `${JSON.stringify(query)}|${JSON.stringify(returns)}|${JSON.stringify(",
    "      args",
    "    )}`",
    "  ];",
  ].join("\n");

const call = () =>
  [
    "const call = async (",
    "  graphqlServerUrl: string,",
    "  query: string,",
    "  returns: Fields,",
    "  args: Record<string, Arguments> | undefined,",
    "  argTypes: ArgumentTypes | undefined,",
    "  queryType: keyof typeof queryToGqlTypes | null,",
    "  options: CallOptions = {}",
    ") => {",
    "    if (options.cache && hasCache(query, returns, args)) {",
    "      return getCache(query, returns, args);",
    "    }",
    "",
    "    const result = await (options.fetch || fetch)(graphqlServerUrl, {",
    "      method: 'POST',",
    "      body: JSON.stringify({",
    "        operationName: query,",
    "        query: `query ${query}${",
    "          argTypes && args ? `(${argsToGql(argTypes, args, queryType, returns)})` : ''",
    "        } {\\n ${query}${",
    "          args ? `(${variablesToArgs(args)})` : ''",
    "        }\\n ${fieldsToQuery(returns)} }`,",
    "        variables: { ...args, ...returnsToVariables(returns) },",
    "      }),",
    "      headers: {",
    "        'Content-Type': 'application/json',",
    "      },",
    "    }).then((response: Response) => response.json());",
    "",
    "    setCache(query, returns, args, result);",
    "",
    "    return result;",
    "}",
  ].join("\n");

const fieldQuery = (
  field: FieldDefinitionNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>
): string =>
  isScalar(field.type, scalars) || isEnum(field.type, enums)
    ? `'${field.name.value}'`
    : `{ ${field.name.value}: ${gqlTypeToTsName(
        field.type,
        scalars,
        enums,
        "Query"
      )}${
        field.arguments && field.arguments.length > 0
          ? `, $args${
              field.arguments.every((arg) => isGqlTypeOptional(arg.type))
                ? "?"
                : ""
            }: { ${field.arguments
              .map(
                (arg) =>
                  `${arg.name.value}${
                    isGqlTypeOptional(arg.type) ? "?" : ""
                  }: ${gqlTypeToTsName(arg.type, scalars, enums)}`
              )
              .join(", ")} }`
          : ""
      } }`;

const queriesTypes = (
  schema: DocumentNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>
) => {
  const queries = (
    schema.definitions.filter(
      (node) =>
        node.kind === Kind.OBJECT_TYPE_DEFINITION &&
        // We don't expose these types
        !["Query", "Mutation"].includes(node.name.value)
    ) as Array<ObjectTypeDefinitionNode>
  )
    .map((node) =>
      [
        `export type ${node.name.value}${
          isEnum(node, enums) ? "" : "Query"
        } = Array<`,
      ]
        .concat(
          (node.fields || []).map(
            (field) => `  | ${fieldQuery(field, scalars, enums)}`
          )
        )
        .concat([">;"])
        .join("\n")
    )
    .join("\n\n");

  const types = (
    schema.definitions.filter(
      (node) =>
        node.kind === Kind.OBJECT_TYPE_DEFINITION &&
        // We don't expose these types
        !["Query", "Mutation"].includes(node.name.value) &&
        !isEnum(node, enums)
    ) as Array<ObjectTypeDefinitionNode>
  )
    .map((node) =>
      [`type ${node.name.value} = {`]
        .concat(
          (node.fields || []).map(
            (field) =>
              `  ${field.name.value}: ${gqlTypeToTsName(
                field.type,
                scalars,
                enums
              )}${field.type.kind !== Kind.NON_NULL_TYPE ? " | null" : ""}`
          )
        )
        .concat(["};"])
        .join("\n")
    )
    .join("\n\n");

  const results = (
    schema.definitions.filter(
      (node) =>
        node.kind === Kind.OBJECT_TYPE_DEFINITION &&
        // We don't expose these types
        !["Query", "Mutation"].includes(node.name.value) &&
        !isEnum(node, enums)
    ) as Array<ObjectTypeDefinitionNode>
  )
    .map((node) =>
      [
        `type ${node.name.value}Result<T extends ${node.name.value}Query[number]> = Prettify<Omit<{`,
        "  [P in T extends string ? T : keyof T]:",
      ]
        .concat(
          (node.fields || [])
            .filter(
              (field) =>
                !isScalar(field.type, scalars) && !isEnum(field.type, enums)
            )
            .map(
              (field) =>
                `    P extends '${field.name.value}' ? T extends { ${
                  field.name.value
                }: ${gqlTypeToTsName(
                  field.type,
                  scalars,
                  enums
                )}Query } ? ${gqlTypeToTsName(
                  field.type,
                  scalars,
                  enums
                )}Result<T['${field.name.value}'][number]> : never :`
            )
        )
        .concat([
          `    P extends keyof ${node.name.value} ? ${node.name.value}[P] : never`,
          "}, '$args'>>;",
        ])
        .join("\n")
    )
    .join("\n\n");

  const inputs = (
    schema.definitions.filter(
      (node) => node.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION
    ) as Array<InputObjectTypeDefinitionNode>
  )
    .map((node) =>
      [`export type ${node.name.value} = {`]
        .concat(
          (node.fields || []).map(
            (field) =>
              `  ${field.name.value}: ${gqlTypeToTsName(
                field.type,
                scalars,
                enums
              )}`
          )
        )
        .concat(["};"])
        .join("\n")
    )
    .join("\n\n");

  const enumerations = (
    schema.definitions.filter(
      (node) => node.kind === Kind.ENUM_TYPE_DEFINITION
    ) as Array<EnumTypeDefinitionNode>
  )
    .map((node) =>
      [`export type ${node.name.value} = `]
        .concat(
          (node.values || []).map(
            (value, index, values) =>
              `  | '${value.name.value}'${
                index === values.length - 1 ? ";" : ""
              }`
          )
        )
        .join("\n")
    )
    .join("\n\n");

  return [queries, types, results, inputs, enumerations].join("\n\n");
};

const queryFunctionParameters = (
  field: FieldDefinitionNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
  withArgs = true
) =>
  [
    !isScalar(field.type, scalars) ? "query: Array<T>" : null,
    withArgs && field.arguments && field.arguments.length > 0
      ? `args${
          field.arguments.every((arg) => isGqlTypeOptional(arg.type)) ? "?" : ""
        }: { ${field.arguments
          .map(
            (arg) =>
              `${arg.name.value}${
                isGqlTypeOptional(arg.type) ? "?" : ""
              }: ${gqlTypeToTsName(arg.type, scalars, enums)}`
          )
          .join(", ")} }`
      : null,
  ]
    .filter(Boolean)
    .join(", ");

const gqlArgTypes = (args: readonly InputValueDefinitionNode[]) =>
  args
    .map((node) => `${node.name.value}: '${gqlTypeToGqlString(node.type)}'`)
    .join(", ");

const queryOrMutationFunctions = (
  queries: ObjectTypeDefinitionNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>
): string =>
  (queries.fields || [])
    .map((field) =>
      [
        `    ${field.name.value}: ${
          isScalar(field.type, scalars)
            ? ""
            : `<T extends ${gqlTypeToTsName(
                field.type,
                scalars,
                enums
              )}Query[number]>`
        }(${queryFunctionParameters(field, scalars, enums)}): Promise<${
          isScalar(field.type, scalars)
            ? gqlTypeToTsName(field.type, scalars, enums)
            : `${gqlTypeToTsName(field.type, scalars, enums)}Result<T>${
                field.type.kind !== Kind.NON_NULL_TYPE ? " | null" : ""
              }`
        }> => call(graphqlServerUrl, '${field.name.value}', ${
          !isScalar(field.type, scalars) ? "query" : "null"
        }${
          field.arguments && field.arguments.length > 0
            ? `, args, { ${gqlArgTypes(field.arguments)} }`
            : ", undefined, undefined"
        }, ${
          isEnum(field.type, enums) || isScalar(field.type, scalars)
            ? "null"
            : `'${gqlTypeToTsName(field.type, scalars, enums, "Query")}'`
        }, options),`,
      ].join("\n")
    )
    .join("\n");

const client = (
  schema: DocumentNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>
) => {
  const queries = getQueries(schema);
  const mutations = getMutations(schema);

  return (
    // TODO: Handle custom headers (i.e. for authentication)
    [`const enodia = (graphqlServerUrl: string, options?: CallOptions) => ({`]
      .concat(
        queries
          ? [
              "  query: {",
              queryOrMutationFunctions(queries, scalars, enums),
              `  }${mutations ? "," : ""}`,
            ]
          : []
      )
      .concat(
        mutations
          ? [
              "  mutation: {",
              queryOrMutationFunctions(mutations, scalars, enums),
              "  }",
            ]
          : []
      )
      .concat(["});", "", "export default enodia"])
      .join("\n")
  );
};

const react = (
  url: string,
  schema: DocumentNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>
) => {
  const queries = getQueries(schema);
  const mutations = getMutations(schema);

  return (queries?.fields || [])
    .map((field) =>
      [
        `export const use${field.name.value[0].toUpperCase()}${field.name.value.slice(
          1
        )}Query = ${
          !isScalar(field.type, scalars) && !isEnum(field.type, enums)
            ? `<${fieldsConstraint(field.type, scalars, enums)}>`
            : ""
        }(`,
        `  ${queryFunctionParameters(field, scalars, enums)}${
          (!isScalar(field.type, scalars) && !isEnum(field.type, enums)) ||
          (field.arguments && field.arguments.length > 0)
            ? ", "
            : ""
        }skip?: boolean`,
        `): QueryResult<${queryResult(field.type, scalars, enums)}> => {`,
        "  const [error, setError] = useState<Error | null>(null);",
        "  // We use undefined as the empty value so we can discriminate between the loading state and the null returned by the API",
        `  const [data, setData] = useState<${queryResult(
          field.type,
          scalars,
          enums
        )} | undefined>(undefined);`,
        "",
        "  const fetch = useCallback(",
        "    () =>",
        `      call('${url}', '${field.name.value}', ${
          !isScalar(field.type, scalars) ? "query" : "null"
        }${
          field.arguments && field.arguments.length > 0
            ? `, args, { ${gqlArgTypes(field.arguments)} }`
            : ", undefined, undefined"
        }, ${
          isEnum(field.type, enums) || isScalar(field.type, scalars)
            ? "null"
            : `'${gqlTypeToTsName(field.type, scalars, enums, "Query")}'`
        }, { cache: false })`,
        "        .then((data) => {",
        "          setData(data);",
        "          return data;",
        "        })",
        "        .catch((error: Error) => {",
        "          setError(error);",
        "        }),",
        `    [${
          !isScalar(field.type, scalars) && !isEnum(field.type, enums)
            ? "query"
            : ""
        }${
          !isScalar(field.type, scalars) &&
          !isEnum(field.type, enums) &&
          field.arguments &&
          field.arguments.length > 0
            ? ", "
            : ""
        }${field.arguments && field.arguments.length > 0 ? "args" : ""}]`,
        "  );",
        "",
        "  useEffect(() => {",
        "    if (!skip) {",
        `      call('${url}', '${field.name.value}', ${
          !isScalar(field.type, scalars) ? "query" : "null"
        }${
          field.arguments && field.arguments.length > 0
            ? `, args, { ${gqlArgTypes(field.arguments)} }`
            : ", undefined, undefined"
        }, ${
          isEnum(field.type, enums) || isScalar(field.type, scalars)
            ? "null"
            : `'${gqlTypeToTsName(field.type, scalars, enums, "Query")}'`
        })`,
        "        .then((data) => {",
        "          setData(data);",
        "          return data;",
        "        })",
        "        .catch((error: Error) => {",
        "          setError(error);",
        "        })",
        "    }",
        `  }, [skip${
          !isScalar(field.type, scalars) && !isEnum(field.type, enums)
            ? ", query"
            : ""
        }${field.arguments && field.arguments.length > 0 ? ", args" : ""}]);`,
        "",
        "  if (error) {",
        "    return [false, error, null, fetch];",
        "  }",
        "",
        "  if (data !== undefined) {",
        "    return [false, null, data, fetch];",
        "  }",
        "",
        "  return [true, null, null, fetch];",
        "}",
      ].join("\n")
    )
    .concat(
      (mutations?.fields || []).map((field) =>
        [
          `export const use${field.name.value[0].toUpperCase()}${field.name.value.slice(
            1
          )}Mutation = ${
            !isScalar(field.type, scalars) && !isEnum(field.type, enums)
              ? `<${fieldsConstraint(field.type, scalars, enums)}>`
              : ""
          }(`,
          `  ${queryFunctionParameters(field, scalars, enums, false)}${
            !isScalar(field.type, scalars) ? ", " : ""
          }callbacks: Array<(data: ${
            !isScalar(field.type, scalars) && !isEnum(field.type, enums)
              ? "T"
              : queryResult(field.type, scalars, enums)
          }) => Promise<unknown>> = []`,
          `): MutationResult<${
            field.arguments && field.arguments.length > 0
              ? argsToTsDeclaration(field.arguments, scalars, enums, false)
              : "undefined"
          }, ${queryResult(field.type, scalars, enums)}> => {`,
          "  const [loading, setLoading] = useState<boolean>(false);",
          "  const [error, setError] = useState<Error | null>(null);",
          "  // We use undefined as the empty value so we can discriminate between the loading state and the null returned by the API",
          `  const [data, setData] = useState<${queryResult(
            field.type,
            scalars,
            enums
          )} | undefined>(undefined);`,
          "",
          `  const mutate = useCallback(async (${
            field.arguments && field.arguments.length > 0
              ? argsToTsDeclaration(field.arguments, scalars, enums)
              : ""
          }) => {`,
          "    if (loading) {",
          "      return Promise.reject();",
          "    }",
          "",
          "    setLoading(true);",
          "",
          `    return call('${url}', '${field.name.value}', ${
            !isScalar(field.type, scalars) ? "query" : "null"
          }${
            field.arguments && field.arguments.length > 0
              ? `, args, { ${gqlArgTypes(field.arguments)} }`
              : ", undefined, undefined"
          }, ${
            isEnum(field.type, enums) || isScalar(field.type, scalars)
              ? "null"
              : `'${gqlTypeToTsName(field.type, scalars, enums, "Query")}'`
          })`,
          "      .then(async (data) => {",
          "        setData(data);",
          "        await Promise.all(callbacks.map(callback => callback(data)));",
          "        setLoading(false);",
          "",
          "        return data;",
          "      })",
          "      .catch((error: Error) => {",
          "        setError(error);",
          "        setLoading(false);",
          "",
          "        return Promise.reject(error);",
          "      });",
          `  }, [callbacks, loading${
            !isScalar(field.type, scalars) && !isEnum(field.type, enums)
              ? ", query"
              : ""
          }]);`,
          "",
          "  if (error) {",
          "    return [mutate, false, error, null];",
          "  }",
          "",
          "  if (data) {",
          "    return [mutate, false, null, data];",
          "  }",
          "",
          "  return [mutate, loading, null, null];",
          "}",
        ].join("\n")
      )
    )
    .join("\n\n");
};

// Client generator

export type ScalarType = { path: string; name?: string } | { name: string };

type Options = {
  url: string;
  scalarTypes: Record<string, ScalarType>;
  withReact: boolean;
};

const schemaToClient = (
  schema: DocumentNode,
  { url, scalarTypes, withReact }: Options
) => {
  const customScalars = schema.definitions.filter(
    (node) => node.kind === Kind.SCALAR_TYPE_DEFINITION
  ) as Array<ScalarTypeDefinitionNode>;

  const baseScalars: Array<GqlScalarToTs> = [
    { gql: "Int", ts: "number" },
    { gql: "Float", ts: "number" },
    { gql: "String", ts: "string" },
    { gql: "Boolean", ts: "boolean" },
    { gql: "ID", ts: "string" },
  ];

  const scalars: Array<GqlScalarToTs> = baseScalars.concat(
    customScalars.map((scalar) => {
      const type = scalarTypes[scalar.name.value];

      if (!type) {
        // TODO: Write a nicer, more detailed error, with steps to solve
        throw `No type for scalar ${scalar.name.value}.`;
      }

      return {
        gql: scalar.name.value,
        ts: type.name || scalar.name.value,
      };
    })
  );

  const enums = schema.definitions.filter(
    (node) => node.kind === Kind.ENUM_TYPE_DEFINITION
  ) as Array<EnumTypeDefinitionNode>;

  return [
    imports(withReact),
    customScalarsImports(scalarTypes, customScalars),
    types(schema, scalars, enums, withReact),
    queryArgsToTypes(schema, scalars, enums),
    fieldsToQuery(),
    resultsToArgs(),
    argsToGql(),
    variablesToArgs(),
    returnsToVariables(),
    cache(),
    call(),
    queriesTypes(schema, scalars, enums),
    client(schema, scalars, enums),
    withReact ? react(url, schema, scalars, enums) : "",
  ].join("\n\n");
};

export default schemaToClient;
