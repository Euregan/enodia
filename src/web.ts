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
  getSubscriptions,
  gqlTypeToGqlString,
  gqlTypeToTsName,
  isEnum,
  isGqlTypeOptional,
  isListType,
  isScalar,
  jsDoc,
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

const imports = (hooks: boolean, subscriptions: boolean) =>
  (hooks ? ["import { useState, useEffect, useCallback } from 'react'"] : [])
    .concat(
      subscriptions ? ["import { createClient } from 'graphql-ws'"] : [],
    )
    .join("\n");

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
    // Entity-level pub-sub: a hook that displayed a given entity subscribes to
    // its key, so a write from anywhere (a mutation, a subscription event)
    // re-renders it without an explicit refetch.
    "const entityListeners: Record<string, Set<() => void>> = {};",
    "",
    // Arrays/`.forEach` rather than `for...of`/spread over `Set`, so the
    // generated file typechecks regardless of the consumer's `target`/`lib`
    // (iterating a `Set` needs `--downlevelIteration` or an ES2015+ target).
    "const notifyEntities = (keys: Set<string>) => {",
    "  const listeners = new Set<() => void>();",
    "  keys.forEach((key) => {",
    "    const perKey = entityListeners[key];",
    "    if (perKey) {",
    "      perKey.forEach((listener) => listeners.add(listener));",
    "    }",
    "  });",
    "  listeners.forEach((listener) => listener());",
    "};",
    "",
    "const subscribeEntities = (keys: Array<string>, callback: () => void): (() => void) => {",
    "  for (const key of keys) {",
    "    if (!entityListeners[key]) entityListeners[key] = new Set();",
    "    entityListeners[key].add(callback);",
    "  }",
    "  return () => {",
    "    for (const key of keys) {",
    "      entityListeners[key]?.delete(callback);",
    "    }",
    "  };",
    "};",
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
    "const rootKey = (query: string, args: Record<string, Arguments$> | undefined) =>",
    "  `${query}|${JSON.stringify(args ?? null)}`;",
    "",
    "const childQuery = (query: keyof typeof queryToGqlTypes, key: string): keyof typeof queryToGqlTypes =>",
    "  (queryToGqlTypes[query] as any)[key].query;",
    "",
    // Add each entity's key field (and `__typename` on unions) to a selection so
    // the response always carries what we need to identify and merge entities.
    "const withEntityIds = (query: keyof typeof queryToGqlTypes, returns: Fields$): Fields$ => {",
    "  if (!returns) return returns;",
    "  const mapped: any[] = returns.map((field: any) => {",
    "    if (typeof field === 'string') return field;",
    "    if ('$on' in field && field.$on) {",
    "      const on: Record<string, any> = {};",
    "      for (const [member, selection] of Object.entries(field.$on)) {",
    "        on[member] = withEntityIds(`${member}Query` as keyof typeof queryToGqlTypes, selection as Fields$);",
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
    "const normalize = (query: keyof typeof queryToGqlTypes, returns: Fields$, data: any, written: Set<string>): any => {",
    "  if (data === null || data === undefined) return data ?? null;",
    "  const record: Record<string, any> = {};",
    // Interface fields (unlike unions) can select their own fields alongside
    // `$on`, so those shared field names are folded into the member's own
    // selection below - keeping the whole entity in one `normalize` call
    // instead of losing the shared fields to a separate, discarded record.
    // Typed `any[]` (rather than `Array<string>`) so spreading it together
    // with `selection` below infers as a plain `any[]`: spelling out the
    // precise union against a schema's full `Query` type can make that
    // spread's literal type too large for TS to represent.
    "  const ownFields = (returns ?? []).filter((field) => typeof field === 'string') as Array<any>;",
    "  for (const field of returns ?? []) {",
    "    if (typeof field === 'string') { record[field] = data[field]; continue; }",
    "    if ('$on' in field && field.$on) {",
    "      const selection = (field.$on as Record<string, Fields$>)[data.__typename];",
    "      if (selection) {",
    "        const member = normalize(`${data.__typename}Query` as keyof typeof queryToGqlTypes, [...ownFields, ...selection] as Fields$, data, written);",
    "        if (member && typeof member === 'object' && '__ref' in member) return member;",
    "        Object.assign(record, member);",
    "      }",
    "      continue;",
    "    }",
    "    const key = Object.keys(field).filter((k) => k !== '$args')[0] as string;",
    "    record[key] = normalizeChild(childQuery(query, key), (field as any)[key], data[key], written);",
    "  }",
    "  const type = query.replace(/Query$/, '');",
    "  const keyField = entityKeys[type];",
    "  if (keyField && data[keyField] != null) {",
    "    const id = `${type}:${data[keyField]}`;",
    "    entities[id] = { ...(entities[id] || {}), ...record, __typename: type };",
    "    written.add(id);",
    "    return { __ref: id };",
    "  }",
    "  return record;",
    "};",
    "",
    "const normalizeChild = (query: keyof typeof queryToGqlTypes, returns: Fields$, value: any, written: Set<string>): any =>",
    "  value === null || value === undefined",
    "    ? value ?? null",
    "    : Array.isArray(value)",
    "    ? value.map((item) => normalize(query, returns, item, written))",
    "    : normalize(query, returns, value, written);",
    "",
    // Rebuild a value from its stored ref shape, resolving entities. Returns MISS
    // if any referenced entity or selected field is absent from the cache.
    "const denormalize = (query: keyof typeof queryToGqlTypes, returns: Fields$, node: any, touched: Array<string>): any => {",
    "  if (node === null || node === undefined) return node ?? null;",
    "  const source = node.__ref ? entities[node.__ref] : node;",
    "  if (!source) return MISS;",
    "  if (node.__ref) touched.push(node.__ref);",
    "  const out: Record<string, any> = {};",
    "  for (const field of returns ?? []) {",
    "    if (typeof field === 'string') {",
    "      if (!(field in source)) return MISS;",
    "      out[field] = source[field];",
    "      continue;",
    "    }",
    "    if ('$on' in field && field.$on) {",
    "      const selection = (field.$on as Record<string, Fields$>)[source.__typename];",
    "      if (selection) {",
    "        const member = denormalize(`${source.__typename}Query` as keyof typeof queryToGqlTypes, selection, node, touched);",
    "        if (member === MISS) return MISS;",
    "        Object.assign(out, member);",
    "      }",
    "      continue;",
    "    }",
    "    const key = Object.keys(field).filter((k) => k !== '$args')[0] as string;",
    "    if (!(key in source)) return MISS;",
    "    const child = denormalizeChild(childQuery(query, key), (field as any)[key], source[key], touched);",
    "    if (child === MISS) return MISS;",
    "    out[key] = child;",
    "  }",
    "  return out;",
    "};",
    "",
    "const denormalizeChild = (query: keyof typeof queryToGqlTypes, returns: Fields$, value: any, touched: Array<string>): any => {",
    "  if (value === null || value === undefined) return value ?? null;",
    "  if (!Array.isArray(value)) return denormalize(query, returns, value, touched);",
    "  const items: any[] = [];",
    "  for (const item of value) {",
    "    const child = denormalize(query, returns, item, touched);",
    "    if (child === MISS) return MISS;",
    "    items.push(child);",
    "  }",
    "  return items;",
    "};",
    "",
    "const readCache = (query: string, returns: Fields$, args: Record<string, Arguments$> | undefined, queryType: keyof typeof queryToGqlTypes | null, touched: Array<string>) => {",
    "  const key = rootKey(query, args);",
    "  if (key in roots) {",
    "    return queryType === null ? roots[key] : denormalizeChild(queryType, returns, roots[key], touched);",
    "  }",
    // No stored root, but a single-entity `ID` query can reach the entity
    // directly, so a user loaded by one query is served to another.
    "  const idArg = redirects[query];",
    "  if (idArg && queryType !== null && args && args[idArg] != null) {",
    "    return denormalize(queryType, returns, { __ref: `${queryType.replace(/Query$/, '')}:${args[idArg]}` }, touched);",
    "  }",
    "  return MISS;",
    "};",
    "",
    "const writeCache = (query: string, returns: Fields$, args: Record<string, Arguments$> | undefined, queryType: keyof typeof queryToGqlTypes | null, queryOrMutation: 'query' | 'mutation', value: any) => {",
    "  if (queryType === null) {",
    "    if (queryOrMutation === 'query') roots[rootKey(query, args)] = value;",
    "    return value;",
    "  }",
    "  const written = new Set<string>();",
    "  const structure = normalizeChild(queryType, returns, value, written);",
    "  if (queryOrMutation === 'query') roots[rootKey(query, args)] = structure;",
    "  notifyEntities(written);",
    "  return structure;",
    "};",
  ].join("\n");
};

const call = (withCodecs: boolean, defaultFetchPolicy: FetchPolicy) =>
  [
    "const call = async (",
    "  graphqlServerUrl: string,",
    "  query: string,",
    "  returns: Fields$,",
    "  args: Record<string, Arguments$> | undefined,",
    "  argTypes: ArgumentTypes$ | undefined,",
    "  queryType: keyof typeof queryToGqlTypes | null,",
    "  queryOrMutation: 'query' | 'mutation',",
    "  options: CallOptions$ = {}",
    ") => {",
    `    const fetchPolicy = options.fetchPolicy || '${defaultFetchPolicy}';`,
    // Fetch the entities' key fields too, so responses can be normalized.
    "    const effectiveReturns = queryType !== null && fetchPolicy !== 'no-cache' ? withEntityIds(queryType, returns) : returns;",
    "",
    // Mutations always hit the network; only queries read the cache.
    "    if (queryOrMutation === 'query' && fetchPolicy !== 'network-only' && fetchPolicy !== 'no-cache') {",
    "      const cacheTouched: Array<string> = [];",
    "      const cached = readCache(query, returns, args, queryType, cacheTouched);",
    "      if (cached !== MISS) {",
    "        options.onEntitiesTouched?.(cacheTouched);",
    "        return { data: { [query]: cached } };",
    "      }",
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
    "      const networkTouched: Array<string> = [];",
    // Return the normalized value rebuilt for the original selection, so
    // callers never see the key fields injected above
    "      const clean = queryType === null ? structure : denormalizeChild(queryType, returns, structure, networkTouched);",
    "      options.onEntitiesTouched?.(networkTouched);",
    "      if (clean !== MISS) result.data[query] = clean;",
    "    }",
    "",
    "    return result;",
    "}",
  ].join("\n");

// One `graphql-ws` client per WS URL: the library multiplexes every
// subscription for that URL over a single socket, so clients are memoized
// rather than opening a new connection per subscribed field.
const subscriptionRuntime = (withCodecs: boolean) =>
  [
    "const wsClients: Record<string, ReturnType<typeof createClient>> = {};",
    "",
    "const wsUrlFor = (graphqlServerUrl: string): string =>",
    "  graphqlServerUrl.replace(/^http/, 'ws');",
    "",
    "const getWsClient = (graphqlServerUrl: string, wsUrl?: string): ReturnType<typeof createClient> => {",
    "  const url = wsUrl || wsUrlFor(graphqlServerUrl);",
    "  if (!wsClients[url]) {",
    "    wsClients[url] = createClient({ url });",
    "  }",
    "  return wsClients[url];",
    "};",
    "",
    "const subscribe = (",
    "  graphqlServerUrl: string,",
    "  query: string,",
    "  returns: Fields$,",
    "  args: Record<string, Arguments$> | undefined,",
    "  argTypes: ArgumentTypes$ | undefined,",
    "  queryType: keyof typeof queryToGqlTypes | null,",
    "  callbacks: { onData: (data: any) => void; onError?: (error: Error$) => void; onComplete?: () => void },",
    "  options: CallOptions$ = {}",
    "): (() => void) => {",
    "  const effectiveReturns = queryType !== null ? withEntityIds(queryType, returns) : returns;",
    "",
    "  return getWsClient(graphqlServerUrl, options.wsUrl).subscribe(",
    "    {",
    "      operationName: query,",
    "      query: `subscription ${query}${",
    "        argTypes && args ? `(${argsToGql(argTypes, args, queryType, effectiveReturns)})` : ''",
    "      } {\\n ${query}${",
    "        args ? `(${variablesToArgs(args)})` : ''",
    "      }\\n ${fieldsToQuery(effectiveReturns)} }`,",
    withCodecs
      ? "      variables: { ...encodeArguments(args, argTypes), ...returnsToVariables(effectiveReturns) },"
      : "      variables: { ...args, ...returnsToVariables(effectiveReturns) },",
    "    },",
    "    {",
    "      next: (message) => {",
    "        if (!message.data || message.data[query] === undefined) {",
    "          return;",
    "        }",
    "",
    "        let value = message.data[query];",
    ...(withCodecs
      ? [
          "        if (queryType) {",
          "          value = decodeResult(queryType.replace(/Query$/, ''), value);",
          "        }",
          "",
        ]
      : []),
    "        if (queryType === null) {",
    "          callbacks.onData(value);",
    "          return;",
    "        }",
    "",
    // Entities are written (and any already-mounted query hook watching them
    // notified) the same way a query/mutation result is, but a subscription
    // event has no repeatable "root query" of its own, so nothing is written
    // to `roots`.
    "        const written = new Set<string>();",
    "        const structure = normalizeChild(queryType, effectiveReturns, value, written);",
    "        notifyEntities(written);",
    "",
    "        const touched: Array<string> = [];",
    "        const clean = denormalizeChild(queryType, returns, structure, touched);",
    "        callbacks.onData(clean !== MISS ? clean : value);",
    "      },",
    "      error: (error) => callbacks.onError?.(error as Error$),",
    "      complete: () => callbacks.onComplete?.(),",
    "    },",
    "  );",
    "};",
  ].join("\n");

const queryFunctionParameters = (
  field: FieldDefinitionNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
  withArgs = true,
  requireArgs = false,
) =>
  [
    !isScalar(field.type, scalars) && !isEnum(field.type, enums)
      ? "query: Array<T>"
      : null,
    withArgs && field.arguments && field.arguments.length > 0
      ? `args${
          !requireArgs &&
          field.arguments.every((arg) => isGqlTypeOptional(arg.type))
            ? "?"
            : ""
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
  queryOrMutation: "query" | "mutation",
): string =>
  (queries.fields || [])
    .map((field) =>
      [
        `${jsDoc(field.description?.value, "    ")}    ${field.name.value}: ${
          isScalar(field.type, scalars) || isEnum(field.type, enums)
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
          !isScalar(field.type, scalars) && !isEnum(field.type, enums)
            ? "query"
            : "null"
        }${
          field.arguments && field.arguments.length > 0
            ? `, args, { ${gqlArgTypes(field.arguments)} }`
            : ", undefined, undefined"
        }, ${
          isEnum(field.type, enums) || isScalar(field.type, scalars)
            ? "null"
            : `'${gqlTypeToTsName(field.type, scalars, enums, "Query")}'`
        }, "${queryOrMutation}", options).then(({ data }) => data.${field.name.value}),`,
      ].join("\n"),
    )
    .join("\n");

const subscriptionFunctions = (
  subscriptions: ObjectTypeDefinitionNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
): string =>
  (subscriptions.fields || [])
    .map((field) => {
      const usesQuerySelection =
        !isScalar(field.type, scalars) && !isEnum(field.type, enums);
      const hasArgs = !!(field.arguments && field.arguments.length > 0);
      const params = queryFunctionParameters(field, scalars, enums);
      const dataType = queryResult(field.type, scalars, enums);
      return [
        `${jsDoc(field.description?.value, "    ")}    ${field.name.value}: ${
          usesQuerySelection
            ? `<T extends ${gqlTypeToTsName(field.type, scalars, enums)}Query[number]>`
            : ""
        }(${params}${
          params ? ", " : ""
        }callbacks: { onData: (data: ${dataType}) => void; onError?: (error: Error$) => void; onComplete?: () => void }): (() => void) => subscribe(graphqlServerUrl, '${field.name.value}', ${
          usesQuerySelection ? "query" : "null"
        }${
          hasArgs
            ? `, args, { ${gqlArgTypes(field.arguments)} }`
            : ", undefined, undefined"
        }, ${
          usesQuerySelection
            ? `'${gqlTypeToTsName(field.type, scalars, enums, "Query")}'`
            : "null"
        }, callbacks, options),`,
      ].join("\n");
    })
    .join("\n");

const client = (
  schema: DocumentNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
) => {
  const queries = getQueries(schema);
  const mutations = getMutations(schema);
  const subscriptions = getSubscriptions(schema);

  return (
    // TODO: Handle custom headers (i.e. for authentication)
    [`const enodia = (graphqlServerUrl: string, options?: CallOptions$) => ({`]
      .concat(
        queries
          ? [
              "  query: {",
              queryOrMutationFunctions(queries, scalars, enums, "query"),
              `  }${mutations || subscriptions ? "," : ""}`,
            ]
          : [],
      )
      .concat(
        mutations
          ? [
              "  mutation: {",
              queryOrMutationFunctions(mutations, scalars, enums, "mutation"),
              `  }${subscriptions ? "," : ""}`,
            ]
          : [],
      )
      .concat(
        subscriptions
          ? [
              "  subscription: {",
              subscriptionFunctions(subscriptions, scalars, enums),
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
  wsUrl: string | undefined,
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
        usesQuerySelection ? "query" : "null"
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
      // This overload's `options` is required (it pins `fetchPolicy` to the
      // 'cache-and-network' literal), so `args` can't be optional here even
      // when every arg field is - a required parameter can't follow one.
      const paramsWithRequiredArgs = `${queryFunctionParameters(
        field,
        scalars,
        enums,
        true,
        true,
      )}${usesQuerySelection || hasArgs ? ", " : ""}`;
      // Reset `data` on a new request unless the policy is `cache-and-network`,
      // whose whole point is to keep showing the last result while revalidating.
      const nextData =
        "fetchPolicy === 'cache-and-network' ? s.data : undefined";

      return [
        // `cache-and-network` reports `data` alongside `loading`/`error` (stale-while-revalidate);
        // every other policy keeps them mutually exclusive. Overloads let callers get the
        // right shape back based on the `fetchPolicy` they actually pass.
        // JSDoc is repeated on both overload signatures (not the implementation) since
        // that's what TS surfaces on hover for whichever overload a call site matches.
        `${jsDoc(field.description?.value)}export function use${capitalizedName}Query${generic}(`,
        `  ${paramsWithRequiredArgs}options: { skip?: boolean; fetchPolicy: 'cache-and-network' }`,
        `): CacheAndNetworkQueryResult$<${dataType}>;`,
        `${jsDoc(field.description?.value)}export function use${capitalizedName}Query${generic}(`,
        `  ${params}options?: { skip?: boolean; fetchPolicy?: Exclude<HookFetchPolicy$, 'cache-and-network'> }`,
        `): QueryResult$<${dataType}>;`,
        `export function use${capitalizedName}Query${generic}(`,
        `  ${params}options: { skip?: boolean; fetchPolicy?: HookFetchPolicy$ } = {}`,
        `): CacheAndNetworkQueryResult$<${dataType}> {`,
        `  const { skip, fetchPolicy = '${defaultFetchPolicy}' } = options;`,
        `  const [state, setState] = useState<{ key: string; loading: boolean; error: Error$ | null; data: ${dataType} | undefined; touched: Array<string> }>({`,
        "    key: '',",
        "    loading: true,",
        "    error: null,",
        "    data: undefined,",
        "    touched: [],",
        "  });",
        "",
        "  const fetch = useCallback(",
        "    () => {",
        `      const key = ${keyExpr};`,
        "      let touched: Array<string> = [];",
        `      setState((s) => ({ ...s, loading: true, error: null, key, data: ${nextData} }));`,
        "",
        `      return ${callPrefix}, { fetchPolicy: 'network-only', onEntitiesTouched: (keys) => { touched = keys } })`,
        "        .then(({ data }) => {",
        `          setState((s) => (s.key === key ? { ...s, loading: false, data: data.${name}, touched } : s));`,
        `          return data.${name};`,
        "        })",
        "        .catch((error: Error$) => {",
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
        "      let cacheTouched: Array<string> = [];",
        `      ${callPrefix}, { fetchPolicy: 'cache-only', onEntitiesTouched: (keys) => { cacheTouched = keys } })`,
        "        .then(({ data }) => {",
        "          if (active) {",
        `            setState((s) => (s.key === key ? { ...s, loading: false, data: data.${name}, touched: cacheTouched } : s));`,
        "          }",
        "        })",
        "        .catch(() => {});",
        "    }",
        "",
        "    let networkTouched: Array<string> = [];",
        `    ${callPrefix}, { fetchPolicy: fetchPolicy === 'cache-and-network' ? 'network-only' : fetchPolicy, onEntitiesTouched: (keys) => { networkTouched = keys } })`,
        "      .then(({ data }) => {",
        "        if (active) {",
        `          setState((s) => (s.key === key ? { ...s, loading: false, data: data.${name}, touched: networkTouched } : s));`,
        "        }",
        "      })",
        "      .catch((error: Error$) => {",
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
        // Live updates: once a fetch resolves, re-render this hook whenever any
        // entity it displayed changes elsewhere (a mutation or a subscription
        // event), without an explicit refetch.
        "  useEffect(() => {",
        "    if (state.touched.length === 0) {",
        "      return;",
        "    }",
        "",
        `    const key = ${keyExpr};`,
        "",
        "    return subscribeEntities(state.touched, () => {",
        `      ${callPrefix}, { fetchPolicy: 'cache-only' })`,
        "        .then(({ data }) => {",
        `          setState((s) => (s.key === key ? { ...s, data: data.${name} } : s));`,
        "        })",
        "        .catch(() => {});",
        "    });",
        "  }, [state.touched]);",
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
          `${jsDoc(field.description?.value)}export const use${field.name.value[0].toUpperCase()}${field.name.value.slice(
            1,
          )}Mutation = ${
            !isScalar(field.type, scalars) && !isEnum(field.type, enums)
              ? `<${fieldsConstraint(field.type, scalars, enums)}>`
              : ""
          }(`,
          `  ${queryFunctionParameters(field, scalars, enums, false)}${
            !isScalar(field.type, scalars) && !isEnum(field.type, enums)
              ? ", "
              : ""
          }callbacks: Array<(data: ${
            !isScalar(field.type, scalars) && !isEnum(field.type, enums)
              ? "T"
              : queryResult(field.type, scalars, enums)
          }) => Promise<unknown>> = []`,
          `): MutationResult$<${
            field.arguments && field.arguments.length > 0
              ? argsToTsDeclaration(field.arguments, scalars, enums, false)
              : "undefined"
          }, ${queryResult(field.type, scalars, enums)}> => {`,
          "  const [loading, setLoading] = useState<boolean>(false);",
          "  const [error, setError] = useState<Error$ | null>(null);",
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
            !isScalar(field.type, scalars) && !isEnum(field.type, enums)
              ? "query"
              : "null"
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
          "      .catch((error: Error$) => {",
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
    .concat(
      (getSubscriptions(schema)?.fields || []).map((field) => {
        const name = field.name.value;
        const usesQuerySelection =
          !isScalar(field.type, scalars) && !isEnum(field.type, enums);
        const hasArgs = !!(field.arguments && field.arguments.length > 0);
        const dataType = queryResult(field.type, scalars, enums);
        const capitalizedName = `${name[0].toUpperCase()}${name.slice(1)}`;
        const generic = usesQuerySelection
          ? `<${fieldsConstraint(field.type, scalars, enums)}>`
          : "";
        const params = `${queryFunctionParameters(field, scalars, enums)}${
          usesQuerySelection || hasArgs ? ", " : ""
        }`;
        const inputDeps = [
          usesQuerySelection ? "JSON.stringify(query)" : null,
          hasArgs ? "JSON.stringify(args)" : null,
        ].filter(Boolean);
        const subscribeCall = `subscribe('${url}', '${name}', ${
          usesQuerySelection ? "query" : "null"
        }${
          hasArgs ? `, args, { ${gqlArgTypes(field.arguments)} }` : ", undefined, undefined"
        }, ${
          usesQuerySelection
            ? `'${gqlTypeToTsName(field.type, scalars, enums, "Query")}'`
            : "null"
        }`;

        return [
          `${jsDoc(field.description?.value)}export function use${capitalizedName}Subscription${generic}(`,
          `  ${params}options: { skip?: boolean } = {}`,
          `): SubscriptionResult$<${dataType}> {`,
          "  const { skip } = options;",
          `  const [state, setState] = useState<{ loading: boolean; error: Error$ | null; data: ${dataType} | undefined }>({`,
          "    loading: true,",
          "    error: null,",
          "    data: undefined,",
          "  });",
          "",
          "  useEffect(() => {",
          "    if (skip) {",
          "      return;",
          "    }",
          "",
          "    setState({ loading: true, error: null, data: undefined });",
          "",
          // No manual-refetch "key" guard needed here (unlike the query hook):
          // `unsubscribe` fully stops further `next` callbacks, so there is no
          // stale in-flight response that could land after args/query change.
          `    const unsubscribe = ${subscribeCall}, {`,
          "      onData: (data) => setState({ loading: false, error: null, data }),",
          "      onError: (error) => setState({ loading: false, error, data: undefined }),",
          `    }${wsUrl ? `, { wsUrl: '${wsUrl}' }` : ""});`,
          "",
          "    return () => {",
          "      unsubscribe();",
          "    };",
          `  }, [skip${inputDeps.length > 0 ? `, ${inputDeps.join(", ")}` : ""}]);`,
          "",
          "  if (state.loading) {",
          "    return [true, null, null];",
          "  }",
          "",
          "  if (state.error) {",
          "    return [false, state.error, null];",
          "  }",
          "",
          "  if (state.data !== undefined) {",
          "    return [false, null, state.data];",
          "  }",
          "",
          "  return [true, null, null];",
          "}",
        ].join("\n");
      }),
    )
    .join("\n\n");
};

// Client generator

type Options = {
  scalarTypes: Record<string, ScalarTypeInfo>;
  scalarImports: string;
  withReact?: { url: string; wsUrl?: string };
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
  const withSubscriptions = Boolean(getSubscriptions(schema));
  const callDefaultFetchPolicy: FetchPolicy =
    defaultFetchPolicy === "cache-and-network"
      ? "network-only"
      : defaultFetchPolicy;

  return [
    imports(!!withReact, withSubscriptions),
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
    withSubscriptions ? subscriptionRuntime(withCodecs) : "",
    queriesTypes(schema, scalars, enums, unions),
    client(schema, scalars, enums),
    withReact
      ? react(
          withReact.url,
          withReact.wsUrl,
          schema,
          scalars,
          enums,
          defaultFetchPolicy,
        )
      : "",
  ].join("\n\n");
};

export default schemaToWeb;
