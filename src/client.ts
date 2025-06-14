import {
  Kind,
  DocumentNode,
  ObjectTypeDefinitionNode,
  FieldDefinitionNode,
  InputValueDefinitionNode,
  EnumTypeDefinitionNode,
} from "graphql";
import { GqlScalarToTs, ScalarType } from "./types.ts";
import {
  argsToTsDeclaration,
  baseScalars,
  customScalarsImports,
  fieldsConstraint,
  getCustomScalars,
  getMutations,
  getQueries,
  gqlTypeToGqlString,
  gqlTypeToTsName,
  isEnum,
  isGqlTypeOptional,
  isScalar,
  queriesTypes,
  queryResult,
  types,
} from "./generator/helpers.ts";

// Generators

const imports = (hooks: boolean) =>
  (hooks
    ? ["import { useState, useEffect, useCallback } from 'react'"]
    : []
  ).join("\n");

const clientTypes = (schema: DocumentNode, react: boolean) =>
  (
    [
      "type CallOptions = {",
      "  fetch?: typeof fetch;",
      "  cache?: boolean",
      "  headers?: Record<string, string>",
      "};",
    ] as Array<string>
  )
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
    "  queryOrMutation: 'query' | 'mutation',",
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
    "        query: `${queryOrMutation} ${query}${",
    "          argTypes && args ? `(${argsToGql(argTypes, args, queryType, returns)})` : ''",
    "        } {\\n ${query}${",
    "          args ? `(${variablesToArgs(args)})` : ''",
    "        }\\n ${fieldsToQuery(returns)} }`,",
    "        variables: { ...args, ...returnsToVariables(returns) },",
    "      }),",
    "      headers: {",
    "        'Content-Type': 'application/json',",
    "        ...options.headers",
    "      },",
    "      credentials: 'include',",
    "    }).then((response: Response) => response.json());",
    "",
    "    setCache(query, returns, args, result);",
    "",
    "    return result;",
    "}",
  ].join("\n");

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
        }(${queryFunctionParameters(
          field,
          scalars,
          enums
        )}): Promise<${queryResult(
          field.type,
          scalars,
          enums
        )}> => call(graphqlServerUrl, '${field.name.value}', ${
          !isScalar(field.type, scalars) ? "query" : "null"
        }${
          field.arguments && field.arguments.length > 0
            ? `, args, { ${gqlArgTypes(field.arguments)} }`
            : ", undefined, undefined"
        }, ${
          isEnum(field.type, enums) || isScalar(field.type, scalars)
            ? "null"
            : `'${gqlTypeToTsName(field.type, scalars, enums, "Query")}'`
        }, "query", options).then(({ data }) => data.${field.name.value}),`,
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
        }, "query", { cache: false })`,
        "        .then(({ data }) => {",
        `          setData(data.${field.name.value});`,
        `          return data.${field.name.value};`,
        "        })",
        "        .catch((error: Error) => {",
        "          setError(error);",
        "        }),",
        `    [${
          !isScalar(field.type, scalars) && !isEnum(field.type, enums)
            ? "JSON.stringify(query)"
            : ""
        }${
          !isScalar(field.type, scalars) &&
          !isEnum(field.type, enums) &&
          field.arguments &&
          field.arguments.length > 0
            ? ", "
            : ""
        }${
          field.arguments && field.arguments.length > 0
            ? "JSON.stringify(args)"
            : ""
        }]`,
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
        }, "query")`,
        "        .then(({ data }) => {",
        `          setData(data.${field.name.value});`,
        `          return data.${field.name.value};`,
        "        })",
        "        .catch((error: Error) => {",
        "          setError(error);",
        "        })",
        "    }",
        `  }, [skip${
          !isScalar(field.type, scalars) && !isEnum(field.type, enums)
            ? ", JSON.stringify(query)"
            : ""
        }${
          field.arguments && field.arguments.length > 0
            ? ", JSON.stringify(args)"
            : ""
        }]);`,
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
          }, "mutation")`,
          "      .then(async ({ data }) => {",
          `        setData(data.${field.name.value});`,
          "        await Promise.all(callbacks.map(callback => callback(data)));",
          "        setLoading(false);",
          "",
          `        return data.${field.name.value};`,
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

type Options = {
  scalarTypes: Record<string, ScalarType>;
  withReact?: { url: string };
};

const schemaToClient = (
  schema: DocumentNode,
  { scalarTypes, withReact }: Options
) => {
  const customScalars = getCustomScalars(schema);

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
    imports(!!withReact),
    customScalarsImports(scalarTypes, customScalars),
    types(schema, scalars, enums),
    clientTypes(schema, !!withReact),
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
    withReact ? react(withReact.url, schema, scalars, enums) : "",
  ].join("\n\n");
};

export default schemaToClient;
