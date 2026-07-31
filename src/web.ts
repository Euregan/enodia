import {
  DocumentNode,
  ObjectTypeDefinitionNode,
  FieldDefinitionNode,
  InputValueDefinitionNode,
  EnumTypeDefinitionNode,
  Kind,
  TypeNode,
} from "graphql";
import {
  FetchPolicy,
  GqlScalarToTs,
  HookFetchPolicy,
  ScalarTypeInfo,
} from "./types.ts";
import {
  argsToTsDeclaration,
  baseName,
  fieldsConstraint,
  getMutations,
  getObjectTypes,
  getQueries,
  gqlTypeToGqlString,
  gqlTypeToTsName,
  isEnum,
  isGqlTypeOptional,
  isListType,
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

// A single (non-list) `ID` argument, so its value is safe to treat as the id.
const isIdArgument = (type: TypeNode): boolean => {
  const inner = type.kind === Kind.NON_NULL_TYPE ? type.type : type;
  return inner.kind === Kind.NAMED_TYPE && inner.name.value === "ID";
};

const store = (schema: DocumentNode, enums: Array<EnumTypeDefinitionNode>) => {
  const entityTypes = getObjectTypes(schema, enums).filter((node) =>
    (node.fields || []).some((f) => f.name.value === "id"),
  );
  const entityTypeNames = entityTypes.map((node) => node.name.value);
  const entityKeys = entityTypes.map((node) => `  ${node.name.value}: 'id',`);

  // Cache redirects: a query returning a single entity via one `ID` argument
  // can be answered straight from the entity store, keyed by that argument.
  const redirects = (getQueries(schema)?.fields || [])
    .filter(
      (field) =>
        !isListType(field.type) &&
        entityTypeNames.includes(baseName(field.type)) &&
        field.arguments?.length === 1 &&
        isIdArgument(field.arguments[0].type),
    )
    .map(
      (field) => `  ${field.name.value}: '${field.arguments![0].name.value}',`,
    );

  return [
    // Normalized cache: any object carrying an `id` is stored once under
    // `Type:id`, so the same entity fetched through different queries stays in
    // sync. `roots` keeps, per query+args, the shape of refs to rebuild from.
    "const entities: Record<string, any> = {};",
    "const roots: Record<string, any> = {};",
    "const MISS = Symbol('miss');",
    "",
    // The key field for each entity type (only types that expose an `id`).
    "const entityKeys: Record<string, string> = {",
    ...entityKeys,
    "};",
    "",
    // Query name -> the `ID` argument whose value identifies the returned entity.
    "const redirects: Record<string, string> = {",
    ...redirects,
    "};",
    "",
    "const rootKey = (query: string, args: Record<string, Arguments> | undefined) =>",
    "  `${query}|${JSON.stringify(args ?? null)}`;",
    "",
    "const childQuery = (query: keyof typeof queryToGqlTypes, key: string): keyof typeof queryToGqlTypes =>",
    "  (queryToGqlTypes[query] as any)[key].query;",
    "",
    // Add each entity's key field (and `__typename` on unions) to a selection so
    // the response always carries what we need to identify and merge entities.
    "const withEntityIds = (query: keyof typeof queryToGqlTypes, returns: Fields): Fields => {",
    "  if (!returns) return returns;",
    "  const mapped: any[] = returns.map((field: any) => {",
    "    if (typeof field === 'string') return field;",
    "    if ('$on' in field && field.$on) {",
    "      const on: Record<string, any> = {};",
    "      for (const [member, selection] of Object.entries(field.$on)) {",
    "        on[member] = withEntityIds(`${member}Query` as keyof typeof queryToGqlTypes, selection as Fields);",
    "      }",
    "      return { ...field, $on: on };",
    "    }",
    "    const key = Object.keys(field).filter((k) => k !== '$args')[0] as string;",
    "    return { ...field, [key]: withEntityIds(childQuery(query, key), field[key]) };",
    "  });",
    "  const additions: any[] = [];",
    "  const keyField = entityKeys[query.replace(/Query$/, '')];",
    "  if (keyField && !mapped.some((f) => f === keyField)) additions.push(keyField);",
    "  if (mapped.some((f) => typeof f !== 'string' && '$on' in f) && !mapped.some((f) => f === '__typename')) additions.push('__typename');",
    "  return [...additions, ...mapped];",
    "};",
    "",
    // Walk a response along its selection, writing entities and returning the
    // ref shape to store as a root (an object with `id` becomes `{ __ref }`).
    "const normalize = (query: keyof typeof queryToGqlTypes, returns: Fields, data: any): any => {",
    "  if (data === null || data === undefined) return data ?? null;",
    "  const record: Record<string, any> = {};",
    "  for (const field of returns ?? []) {",
    "    if (typeof field === 'string') { record[field] = data[field]; continue; }",
    "    if ('$on' in field && field.$on) {",
    "      const selection = (field.$on as Record<string, Fields>)[data.__typename];",
    "      if (selection) return normalize(`${data.__typename}Query` as keyof typeof queryToGqlTypes, selection, data);",
    "      continue;",
    "    }",
    "    const key = Object.keys(field).filter((k) => k !== '$args')[0] as string;",
    "    record[key] = normalizeChild(childQuery(query, key), (field as any)[key], data[key]);",
    "  }",
    "  const type = query.replace(/Query$/, '');",
    "  const keyField = entityKeys[type];",
    "  if (keyField && data[keyField] != null) {",
    "    const id = `${type}:${data[keyField]}`;",
    "    entities[id] = { ...(entities[id] || {}), ...record, __typename: type };",
    "    return { __ref: id };",
    "  }",
    "  return record;",
    "};",
    "",
    "const normalizeChild = (query: keyof typeof queryToGqlTypes, returns: Fields, value: any): any =>",
    "  value === null || value === undefined",
    "    ? value ?? null",
    "    : Array.isArray(value)",
    "    ? value.map((item) => normalize(query, returns, item))",
    "    : normalize(query, returns, value);",
    "",
    // Rebuild a value from its stored ref shape, resolving entities. Returns MISS
    // if any referenced entity or selected field is absent from the cache.
    "const denormalize = (query: keyof typeof queryToGqlTypes, returns: Fields, node: any): any => {",
    "  if (node === null || node === undefined) return node ?? null;",
    "  const source = node.__ref ? entities[node.__ref] : node;",
    "  if (!source) return MISS;",
    "  const out: Record<string, any> = {};",
    "  for (const field of returns ?? []) {",
    "    if (typeof field === 'string') {",
    "      if (!(field in source)) return MISS;",
    "      out[field] = source[field];",
    "      continue;",
    "    }",
    "    if ('$on' in field && field.$on) {",
    "      const selection = (field.$on as Record<string, Fields>)[source.__typename];",
    "      if (selection) {",
    "        const member = denormalize(`${source.__typename}Query` as keyof typeof queryToGqlTypes, selection, node);",
    "        if (member === MISS) return MISS;",
    "        Object.assign(out, member);",
    "      }",
    "      continue;",
    "    }",
    "    const key = Object.keys(field).filter((k) => k !== '$args')[0] as string;",
    "    if (!(key in source)) return MISS;",
    "    const child = denormalizeChild(childQuery(query, key), (field as any)[key], source[key]);",
    "    if (child === MISS) return MISS;",
    "    out[key] = child;",
    "  }",
    "  return out;",
    "};",
    "",
    "const denormalizeChild = (query: keyof typeof queryToGqlTypes, returns: Fields, value: any): any => {",
    "  if (value === null || value === undefined) return value ?? null;",
    "  if (!Array.isArray(value)) return denormalize(query, returns, value);",
    "  const items: any[] = [];",
    "  for (const item of value) {",
    "    const child = denormalize(query, returns, item);",
    "    if (child === MISS) return MISS;",
    "    items.push(child);",
    "  }",
    "  return items;",
    "};",
    "",
    "const readCache = (query: string, returns: Fields, args: Record<string, Arguments> | undefined, queryType: keyof typeof queryToGqlTypes | null) => {",
    "  const key = rootKey(query, args);",
    "  if (key in roots) {",
    "    return queryType === null ? roots[key] : denormalizeChild(queryType, returns, roots[key]);",
    "  }",
    // No stored root, but a single-entity `ID` query can reach the entity
    // directly, so a user loaded by one query is served to another.
    "  const idArg = redirects[query];",
    "  if (idArg && queryType !== null && args && args[idArg] != null) {",
    "    return denormalize(queryType, returns, { __ref: `${queryType.replace(/Query$/, '')}:${args[idArg]}` });",
    "  }",
    "  return MISS;",
    "};",
    "",
    "const writeCache = (query: string, returns: Fields, args: Record<string, Arguments> | undefined, queryType: keyof typeof queryToGqlTypes | null, queryOrMutation: 'query' | 'mutation', value: any) => {",
    "  if (queryType === null) {",
    "    if (queryOrMutation === 'query') roots[rootKey(query, args)] = value;",
    "    return value;",
    "  }",
    "  const structure = normalizeChild(queryType, returns, value);",
    "  if (queryOrMutation === 'query') roots[rootKey(query, args)] = structure;",
    "  return structure;",
    "};",
  ].join("\n");
};

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
    // Fetch the entities' key fields too, so responses can be normalized.
    "    const effectiveReturns = queryType !== null && fetchPolicy !== 'no-cache' ? withEntityIds(queryType, returns) : returns;",
    "",
    // Mutations always hit the network; only queries read the cache.
    "    if (queryOrMutation === 'query' && fetchPolicy !== 'network-only' && fetchPolicy !== 'no-cache') {",
    "      const cached = readCache(query, returns, args, queryType);",
    "      if (cached !== MISS) return { data: { [query]: cached } };",
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
    "          argTypes && args ? `(${argsToGql(argTypes, args, queryType, effectiveReturns)})` : ''",
    "        } {\\n ${query}${",
    "          args ? `(${variablesToArgs(args)})` : ''",
    "        }\\n ${fieldsToQuery(effectiveReturns)} }`,",
    withCodecs
      ? "        variables: { ...encodeArguments(args, argTypes), ...returnsToVariables(effectiveReturns) },"
      : "        variables: { ...args, ...returnsToVariables(effectiveReturns) },",
    "      }),",
    "      headers: {",
    "        'Content-Type': 'application/json',",
    "        ...options.headers",
    "      },",
    "      credentials: 'include',",
    "    }).then((response: Response) => response.json());",
    "",
    "    if (!result || !result.data || result.data[query] === undefined) {",
    "      return result;",
    "    }",
    "",
    ...(withCodecs
      ? [
          "    if (queryType) {",
          "      result.data[query] = decodeResult(queryType.replace(/Query$/, ''), result.data[query]);",
          "    }",
          "",
        ]
      : []),
    "    if (fetchPolicy !== 'no-cache') {",
    "      const structure = writeCache(query, effectiveReturns, args, queryType, queryOrMutation, result.data[query]);",
    // Return the normalized value rebuilt for the original selection, so
    // callers never see the key fields injected above
    "      const clean = queryType === null ? structure : denormalizeChild(queryType, returns, structure);",
    "      if (clean !== MISS) result.data[query] = clean;",
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
      // Identifies the query+args a request was made for, so a resolving
      // request can be ignored once it's no longer the latest one.
      const keyExpr = inputDeps.length > 0 ? inputDeps.join(" + '|' + ") : "''";
      const dataType = queryResult(field.type, scalars, enums);
      const capitalizedName = `${name[0].toUpperCase()}${name.slice(1)}`;
      const generic = usesQuerySelection
        ? `<${fieldsConstraint(field.type, scalars, enums)}>`
        : "";
      const params = `${queryFunctionParameters(field, scalars, enums)}${
        usesQuerySelection || hasArgs ? ", " : ""
      }`;
      // Reset `data` on a new request unless the policy is `cache-and-network`,
      // whose whole point is to keep showing the last result while revalidating.
      const nextData =
        "fetchPolicy === 'cache-and-network' ? s.data : undefined";

      return [
        // `cache-and-network` reports `data` alongside `loading`/`error` (stale-while-revalidate);
        // every other policy keeps them mutually exclusive. Overloads let callers get the
        // right shape back based on the `fetchPolicy` they actually pass.
        `export function use${capitalizedName}Query${generic}(`,
        `  ${params}options: { skip?: boolean; fetchPolicy: 'cache-and-network' }`,
        `): CacheAndNetworkQueryResult<${dataType}>;`,
        `export function use${capitalizedName}Query${generic}(`,
        `  ${params}options?: { skip?: boolean; fetchPolicy?: Exclude<HookFetchPolicy, 'cache-and-network'> }`,
        `): QueryResult<${dataType}>;`,
        `export function use${capitalizedName}Query${generic}(`,
        `  ${params}options: { skip?: boolean; fetchPolicy?: HookFetchPolicy } = {}`,
        `): CacheAndNetworkQueryResult<${dataType}> {`,
        `  const { skip, fetchPolicy = '${defaultFetchPolicy}' } = options;`,
        `  const [state, setState] = useState<{ key: string; loading: boolean; error: Error | null; data: ${dataType} | undefined }>({`,
        "    key: '',",
        "    loading: true,",
        "    error: null,",
        "    data: undefined,",
        "  });",
        "",
        "  const fetch = useCallback(",
        "    () => {",
        `      const key = ${keyExpr};`,
        `      setState((s) => ({ ...s, loading: true, error: null, key, data: ${nextData} }));`,
        "",
        `      return ${callPrefix}, { fetchPolicy: 'network-only' })`,
        "        .then(({ data }) => {",
        `          setState((s) => (s.key === key ? { ...s, loading: false, data: data.${name} } : s));`,
        `          return data.${name};`,
        "        })",
        "        .catch((error: Error) => {",
        "          setState((s) => (s.key === key ? { ...s, loading: false, error } : s));",
        "        });",
        "    },",
        `    [${[...inputDeps, "fetchPolicy"].join(", ")}]`,
        "  );",
        "",
        "  useEffect(() => {",
        "    if (skip) {",
        "      return;",
        "    }",
        "",
        `    const key = ${keyExpr};`,
        "    let active = true;",
        "",
        `    setState((s) => ({ ...s, loading: true, error: null, key, data: ${nextData} }));`,
        "",
        "    if (fetchPolicy === 'cache-and-network') {",
        `      ${callPrefix}, { fetchPolicy: 'cache-only' })`,
        "        .then(({ data }) => {",
        "          if (active) {",
        `            setState((s) => (s.key === key ? { ...s, loading: false, data: data.${name} } : s));`,
        "          }",
        "        })",
        "        .catch(() => {});",
        "    }",
        "",
        `    ${callPrefix}, { fetchPolicy: fetchPolicy === 'cache-and-network' ? 'network-only' : fetchPolicy })`,
        "      .then(({ data }) => {",
        "        if (active) {",
        `          setState((s) => (s.key === key ? { ...s, loading: false, data: data.${name} } : s));`,
        "        }",
        "      })",
        "      .catch((error: Error) => {",
        "        if (active) {",
        "          setState((s) => (s.key === key ? { ...s, loading: false, error } : s));",
        "        }",
        "      });",
        "",
        "    return () => {",
        "      active = false;",
        "    };",
        `  }, [${["skip", ...inputDeps, "fetchPolicy"].join(", ")}]);`,
        "",
        "  if (state.loading) {",
        "    return [true, null, state.data ?? null, fetch];",
        "  }",
        "",
        "  if (state.error) {",
        "    return [false, state.error, state.data ?? null, fetch];",
        "  }",
        "",
        "  if (state.data !== undefined) {",
        "    return [false, null, state.data, fetch];",
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
    store(schema, enums),
    call(withCodecs, callDefaultFetchPolicy),
    queriesTypes(schema, scalars, enums, unions),
    client(schema, scalars, enums),
    withReact
      ? react(withReact.url, schema, scalars, enums, defaultFetchPolicy)
      : "",
  ].join("\n\n");
};

export default schemaToWeb;
