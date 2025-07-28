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
import {
  argsToGql,
  clientTypes,
  fieldsToQuery,
  queryArgsToTypes,
  resultsToArgs,
  returnsToVariables,
  variablesToArgs,
} from "./generator/client.ts";

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

const schemaToWeb = (
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

export default schemaToWeb;
