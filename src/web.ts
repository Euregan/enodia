import {
  DocumentNode,
  ObjectTypeDefinitionNode,
  FieldDefinitionNode,
  InputValueDefinitionNode,
  EnumTypeDefinitionNode,
} from "graphql";
import {
  FetchPolicy,
  GqlScalarToTs,
  HookFetchPolicy,
  ScalarTypeInfo,
} from "./types.ts";
import {
  argsToTsDeclaration,
  fieldsConstraint,
  getMutations,
  getQueries,
  gqlTypeToGqlString,
  gqlTypeToTsName,
  isEnum,
  isGqlTypeOptional,
  isScalar,
  queriesTypes,
  queryResult,
  resolveScalars,
  types,
} from "./generator/helpers.ts";
import {
  argsToGql,
  clientTypes,
  fieldsToQuery,
  queryArgsToTypes,
  resultsToArgs,
  returnsToVariables,
  variablesToArgs,
} from "./generator/client.ts";
import { clientCodecRuntime, hasCodecs } from "./generator/codecs.ts";

// Generators

const imports = (hooks: boolean) =>
  (hooks
    ? ["import { useState, useEffect, useCallback } from 'react'"]
    : []
  ).join("\n");

const cache = () =>
  [
    "const cache: Record<string, any> = {};",
    "",
    "const cacheKey = (",
    "  query: string,",
    "  returns: Fields,",
    "  args: Record<string, Arguments> | undefined",
    ") => `${JSON.stringify(query)}|${JSON.stringify(returns)}|${JSON.stringify(args)}`;",
    "",
    "const setCache = (",
    "  query: string,",
    "  returns: Fields,",
    "  args: Record<string, Arguments> | undefined,",
    "  data: any",
    ") => {",
    "  cache[cacheKey(query, returns, args)] = data;",
    "};",
    "",
    "const hasCache = (",
    "  query: string,",
    "  returns: Fields,",
    "  args: Record<string, Arguments> | undefined",
    ") => cacheKey(query, returns, args) in cache;",
    "",
    "const getCache = (",
    "  query: string,",
    "  returns: Fields,",
    "  args: Record<string, Arguments> | undefined",
    ") => cache[cacheKey(query, returns, args)];",
  ].join("\n");

const call = (withCodecs: boolean, defaultFetchPolicy: FetchPolicy) =>
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
    `    const fetchPolicy = options.fetchPolicy || '${defaultFetchPolicy}';`,
    "",
    "    if (fetchPolicy !== 'network-only' && fetchPolicy !== 'no-cache' && hasCache(query, returns, args)) {",
    "      return getCache(query, returns, args);",
    "    }",
    "",
    "    if (fetchPolicy === 'cache-only') {",
    '      throw new Error(`No cached data for query "${query}" with fetchPolicy "cache-only".`);',
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
    withCodecs
      ? "        variables: { ...encodeArguments(args, argTypes), ...returnsToVariables(returns) },"
      : "        variables: { ...args, ...returnsToVariables(returns) },",
    "      }),",
    "      headers: {",
    "        'Content-Type': 'application/json',",
    "        ...options.headers",
    "      },",
    "      credentials: 'include',",
    "    }).then((response: Response) => response.json());",
    "",
    ...(withCodecs
      ? [
          "    if (queryType && result && result.data) {",
          "      result.data[query] = decodeResult(queryType.replace(/Query$/, ''), result.data[query]);",
          "    }",
          "",
        ]
      : []),
    "    if (fetchPolicy !== 'no-cache') {",
    "      setCache(query, returns, args, result);",
    "    }",
    "",
    "    return result;",
    "}",
  ].join("\n");

const queryFunctionParameters = (
  field: FieldDefinitionNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
  withArgs = true,
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
              }: ${gqlTypeToTsName(arg.type, scalars, enums)}`,
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
  enums: Array<EnumTypeDefinitionNode>,
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
                enums,
              )}Query[number]>`
        }(${queryFunctionParameters(
          field,
          scalars,
          enums,
        )}): Promise<${queryResult(
          field.type,
          scalars,
          enums,
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
      ].join("\n"),
    )
    .join("\n");

const client = (
  schema: DocumentNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
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
          : [],
      )
      .concat(
        mutations
          ? [
              "  mutation: {",
              queryOrMutationFunctions(mutations, scalars, enums),
              "  }",
            ]
          : [],
      )
      .concat(["});", "", "export default enodia"])
      .join("\n")
  );
};

const react = (
  url: string,
  schema: DocumentNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
  defaultFetchPolicy: HookFetchPolicy,
) => {
  const queries = getQueries(schema);
  const mutations = getMutations(schema);

  return (queries?.fields || [])
    .map((field) => {
      const name = field.name.value;
      const usesQuerySelection =
        !isScalar(field.type, scalars) && !isEnum(field.type, enums);
      const hasArgs = !!(field.arguments && field.arguments.length > 0);
      const callPrefix = `call('${url}', '${name}', ${
        !isScalar(field.type, scalars) ? "query" : "null"
      }${
        field.arguments && field.arguments.length > 0
          ? `, args, { ${gqlArgTypes(field.arguments)} }`
          : ", undefined, undefined"
      }, ${
        isEnum(field.type, enums) || isScalar(field.type, scalars)
          ? "null"
          : `'${gqlTypeToTsName(field.type, scalars, enums, "Query")}'`
      }, "query"`;
      const inputDeps = [
        usesQuerySelection ? "JSON.stringify(query)" : null,
        hasArgs ? "JSON.stringify(args)" : null,
      ].filter(Boolean);

      return [
        `export const use${name[0].toUpperCase()}${name.slice(1)}Query = ${
          usesQuerySelection
            ? `<${fieldsConstraint(field.type, scalars, enums)}>`
            : ""
        }(`,
        `  ${queryFunctionParameters(field, scalars, enums)}${
          usesQuerySelection || hasArgs ? ", " : ""
        }options: { skip?: boolean; fetchPolicy?: HookFetchPolicy } = {}`,
        `): QueryResult<${queryResult(field.type, scalars, enums)}> => {`,
        `  const { skip, fetchPolicy = '${defaultFetchPolicy}' } = options;`,
        "  const [error, setError] = useState<Error | null>(null);",
        "  // We use undefined as the empty value so we can discriminate between the loading state and the null returned by the API",
        `  const [data, setData] = useState<${queryResult(
          field.type,
          scalars,
          enums,
        )} | undefined>(undefined);`,
        "",
        "  const fetch = useCallback(",
        "    () =>",
        `      ${callPrefix}, { fetchPolicy: 'network-only' })`,
        "        .then(({ data }) => {",
        `          setData(data.${name});`,
        `          return data.${name};`,
        "        })",
        "        .catch((error: Error) => {",
        "          setError(error);",
        "        }),",
        `    [${inputDeps.join(", ")}]`,
        "  );",
        "",
        "  useEffect(() => {",
        "    if (!skip) {",
        "      if (fetchPolicy === 'cache-and-network') {",
        `        ${callPrefix}, { fetchPolicy: 'cache-only' })`,
        `          .then(({ data }) => { setData(data.${name}); })`,
        "          .catch(() => {});",
        "      }",
        "",
        `      ${callPrefix}, { fetchPolicy: fetchPolicy === 'cache-and-network' ? 'network-only' : fetchPolicy })`,
        "        .then(({ data }) => {",
        `          setData(data.${name});`,
        `          return data.${name};`,
        "        })",
        "        .catch((error: Error) => {",
        "          setError(error);",
        "        })",
        "    }",
        `  }, [${["skip", ...inputDeps, "fetchPolicy"].join(", ")}]);`,
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
      ].join("\n");
    })
    .concat(
      (mutations?.fields || []).map((field) =>
        [
          `export const use${field.name.value[0].toUpperCase()}${field.name.value.slice(
            1,
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
            enums,
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
        ].join("\n"),
      ),
    )
    .join("\n\n");
};

// Client generator

type Options = {
  scalarTypes: Record<string, ScalarTypeInfo>;
  scalarImports: string;
  withReact?: { url: string };
  defaultFetchPolicy?: HookFetchPolicy;
};

const schemaToWeb = (
  schema: DocumentNode,
  {
    scalarTypes,
    scalarImports,
    withReact,
    defaultFetchPolicy = "network-only",
  }: Options,
) => {
  const { scalars, enums, unions } = resolveScalars(schema, scalarTypes);
  const withCodecs = hasCodecs(scalars);
  const callDefaultFetchPolicy: FetchPolicy =
    defaultFetchPolicy === "cache-and-network"
      ? "network-only"
      : defaultFetchPolicy;

  return [
    imports(!!withReact),
    scalarImports,
    types(schema, scalars, enums, unions),
    clientTypes(schema, !!withReact),
    queryArgsToTypes(schema, scalars, enums, unions),
    fieldsToQuery(),
    resultsToArgs(),
    argsToGql(),
    variablesToArgs(),
    returnsToVariables(),
    withCodecs ? clientCodecRuntime(schema, scalars, enums, unions) : "",
    cache(),
    call(withCodecs, callDefaultFetchPolicy),
    queriesTypes(schema, scalars, enums, unions),
    client(schema, scalars, enums),
    withReact
      ? react(withReact.url, schema, scalars, enums, defaultFetchPolicy)
      : "",
  ].join("\n\n");
};

export default schemaToWeb;
