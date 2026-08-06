import {
  DocumentNode,
  EnumTypeDefinitionNode,
  FieldDefinitionNode,
  Kind,
  ObjectTypeDefinitionNode,
  UnionTypeDefinitionNode,
} from "graphql";
import {
  getInterfaces,
  getMutations,
  getQueries,
  getSubscriptions,
  gqlTypeToGqlString,
  gqlTypeToTsName,
  isEnum,
  isScalar,
} from "./helpers.ts";
import { GqlScalarToTs } from "../types.ts";

export const clientTypes = (schema: DocumentNode, react: boolean = false) =>
  (
    [
      "type FetchPolicy$ = 'cache-first' | 'network-only' | 'no-cache' | 'cache-only';",
      "",
      "type CallOptions$ = {",
      "  fetch?: typeof fetch;",
      "  fetchPolicy?: FetchPolicy$",
      "  headers?: Record<string, string>",
      // Internal: lets a query hook learn which entity keys its result depends
      // on, so it can subscribe to live updates from mutations/subscriptions.
      "  onEntitiesTouched?: (keys: Array<string>) => void",
      ...(getSubscriptions(schema)
        ? [
            // Overrides the WS endpoint derived from the query/mutation URL
            // (protocol swapped: http(s) -> ws(s)) for setups that serve
            // subscriptions on a different endpoint.
            "  wsUrl?: string",
          ]
        : []),
      "};",
    ] as Array<string>
  )
    .concat(
      // `Error$` is used by the plain client's subscription callbacks too
      // (`subscribe()`, generated whenever the schema has a `Subscription`
      // root), not just by hooks - so it can't be gated on `react` alone.
      react || getSubscriptions(schema) ? ["", "type Error$ = Error;"] : [],
    )
    .concat(
      react && getQueries(schema)
        ? [
            "",
            "type HookFetchPolicy$ = FetchPolicy$ | 'cache-and-network';",
            "",
            "/**",
            " * The type returned by the query hook for every fetch policy other",
            " * than `cache-and-network`. Loading is true whenever a request for",
            " * the current query/args is in flight - including on refetches",
            " * triggered by a query or args change (e.g. pagination) - and it is",
            " * mutually exclusive with `data`: while a request is loading (or has",
            " * errored) there is no result to show yet. The last element is a",
            " * function to manually call the API.",
            " */",
            "type QueryResult$<Data> =",
            "  | readonly [true, null, null, () => Promise<Data>]",
            "  | readonly [false, Error$, null, () => Promise<Data>]",
            "  | readonly [false, null, Data, () => Promise<Data>];",
            "",
            "/**",
            " * The type returned by the query hook when using the",
            " * `cache-and-network` fetch policy. It differs from `QueryResult$` in",
            " * that `loading` and `error` can both be reported alongside a",
            " * `data` value: a cache hit delivers `data` immediately while the",
            " * network request keeps `loading`, and a failed refetch keeps the",
            " * last successful `data` around instead of clearing it. Consumers",
            " * can use the presence of `data` for stale-while-revalidate instead",
            " * of forcing a skeleton on every refetch.",
            " */",
            "type CacheAndNetworkQueryResult$<Data> =",
            "  | readonly [true, null, Data | null, () => Promise<Data>]",
            "  | readonly [false, Error$, Data | null, () => Promise<Data>]",
            "  | readonly [false, null, Data, () => Promise<Data>];",
          ]
        : [],
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
            "type MutationResult$<Payload, Data> =",
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
            "  | [(payload: Payload) => Promise<Data>, false, Error$, null]",
            "  /**",
            "   * If the call has come through, the array contains `false` as the",
            "   * loading variable, `null` for the error, and finally the data",
            "   * returned by the API.",
            "   */",
            "  | [(payload: Payload) => Promise<Data>, false, null, Data];",
          ]
        : [],
    )
    .concat(
      react && getSubscriptions(schema)
        ? [
            "",
            "/**",
            " * The type returned by a subscription hook. Unlike a query, there is",
            " * no manual refetch: the effect resubscribes automatically whenever",
            " * the query/args change, and unsubscribes on unmount.",
            " */",
            "type SubscriptionResult$<Data> =",
            "  | readonly [true, null, null]",
            "  | readonly [false, Error$, null]",
            "  | readonly [false, null, Data];",
          ]
        : [],
    )
    .join("\n");

const queryToGqlTypesEntry = (
  node: {
    name: { value: string };
    fields?: ReadonlyArray<FieldDefinitionNode>;
  },
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
) =>
  `  ${node.name.value}Query: { ${(node.fields || [])
    .filter(
      (field) => !isEnum(field.type, enums) && !isScalar(field.type, scalars),
    )
    .map(
      (field) =>
        `${field.name.value}: { query: '${gqlTypeToTsName(
          field.type,
          scalars,
          enums,
          "Query",
        )}' as const${
          (field.arguments || []).length > 0
            ? `, $args: { ${(field.arguments || [])
                .map(
                  (argument) =>
                    `${argument.name.value}: '${gqlTypeToGqlString(
                      argument.type,
                    )}' as const`,
                )
                .join(", ")}}`
            : ""
        } }`,
    )
    .join(", ")} },`;

export const queryArgsToTypes = (
  schema: DocumentNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
  unions: Array<UnionTypeDefinitionNode>,
) =>
  ["const queryToGqlTypes = {"]
    .concat(
      (
        schema.definitions.filter(
          (node) =>
            node.kind === Kind.OBJECT_TYPE_DEFINITION &&
            // We don't expose these types
            !["Query", "Mutation", "Subscription"].includes(node.name.value),
        ) as Array<ObjectTypeDefinitionNode>
      ).map((node) => queryToGqlTypesEntry(node, scalars, enums)),
    )
    // An interface's own fields are directly selectable (like an object's),
    // unlike a union which only ever exposes its members through `$on`.
    .concat(
      getInterfaces(schema).map((node) =>
        queryToGqlTypesEntry(node, scalars, enums),
      ),
    )
    .concat(unions.map((node) => `  ${node.name.value}Query: {},`))
    .concat(["};"])
    .join("\n");

export const fieldsToQuery = () =>
  [
    "const fieldsToQuery = (query: Fields$, path: Array<string> = []): string => {",
    "    if (query === null) {",
    "        return '';",
    "    }",
    "",
    "    const scalars = query.filter(field => typeof field === 'string') as Array<string>;",
    // Not every schema has a field whose selection is itself an object,
    // which collapses `Exclude<Query, string>` to `never` and makes every
    // property access below a real compile error even though this branch
    // is unreachable at runtime for such schemas. `any` here matches how
    // the cache's own normalize/denormalize functions already type this.
    "    const objects = query.filter(field => typeof field !== 'string') as Array<any>;",
    "",
    "    return `{\\n  ${scalars.join('\\n')}\\n${objects",
    "      .map((field) => {",
    "        if ('$on' in field && field.$on) {",
    "          return Object.entries(field.$on)",
    "            .map(([type, selection]) => `... on ${type} ${fieldsToQuery(selection as Fields$, path)}`)",
    "            .join('\\n');",
    "        }",
    "",
    "        const key = Object.keys(field).filter((k) => k !== '$args')[0] as string;",
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
    "        queryField += ` ${fieldsToQuery((field as MergedUnion$<typeof field>)[key], path.concat(key))}`",
    "",
    "        return queryField;",
    "      })",
    "      .join('\\n')}\\n}`;",
    "}",
  ].join("\n");

export const resultsToArgs = () =>
  [
    "const resultsToArgs = (query: keyof typeof queryToGqlTypes, returns: Fields$, path: Array<string> = []): string =>",
    "  returns",
    "    ? (",
    "        returns.filter((field) => typeof field !== 'string') as Array<",
    "          any",
    "        >",
    "      )",
    "        .map((field) => {",
    "          if ('$on' in field && field.$on) {",
    "            return Object.entries(field.$on)",
    "              .map(([type, selection]) => resultsToArgs(`${type}Query` as keyof typeof queryToGqlTypes, selection as Fields$, path))",
    "              .join('\\n');",
    "          }",
    "",
    "          const key = Object.keys(field).filter((k) => k !== '$args')[0] as string;",
    "",
    "          const queryTypes = queryToGqlTypes[query];",
    "          const types = (queryTypes as any)[key];",
    "",
    "          let args = '';",
    "          if ('$args' in field && field.$args && '$args' in types) {",
    "            args += Object.keys(field.$args)",
    "              .map(",
    "                (arg) =>",
    "                  `$${path.concat([key, arg]).join('_')}: ${(types as { $args: Record<string, string> }).$args[arg]}`",
    "              )",
    "              .join('\\n');",
    "          }",
    "",
    "          args += resultsToArgs(types.query, (field as MergedUnion$<typeof field>)[key], path.concat(key))",
    "",
    "          return args;",
    "        })",
    "        .join('\\n')",
    "    : '';",
  ].join("\n");

export const argsToGql = () =>
  [
    "const argsToGql = (argTypes: ArgumentTypes$, args: Record<string, Arguments$>, query: keyof typeof queryToGqlTypes | null, returns: Fields$ | null) =>",
    "  Object.keys(args)",
    "    .map((key) => `$${key}: ${argTypes[key]}`)",
    "    .concat(query && returns ? resultsToArgs(query, returns) : [])",
    "    .join(', ');",
  ].join("\n");

export const variablesToArgs = () =>
  [
    "const variablesToArgs = (args: Record<string, Arguments$>) =>",
    "  Object.keys(args)",
    "    .map((key) => `${key}: $${key}`)",
    "    .join(', ');",
  ].join("\n");

export const returnsToVariables = () =>
  [
    "const returnsToVariables = (returns: Fields$, path: Array<string> = []): Record<string, Arguments$> =>",
    "  returns",
    "    ? Object.assign({}, ...(",
    "        returns.filter((field) => typeof field !== 'string') as Array<",
    "          any",
    "        >",
    "      )",
    "        .map((field) => {",
    "          if ('$on' in field && field.$on) {",
    "            return Object.assign({}, ...Object.values(field.$on).map((selection) => returnsToVariables(selection as Fields$, path)));",
    "          }",
    "",
    "          const key = Object.keys(field).filter((k) => k !== '$args')[0] as string;",
    "",
    "          let args: Record<string, Arguments$> = {};",
    "          if ('$args' in field && field.$args) {",
    "            args = Object.fromEntries(Object.entries(field.$args)",
    "              .map(",
    "                ([arg, value]) =>",
    "                  [path.concat([key, arg]).join('_'), value]",
    "              )) as Record<string, Arguments$>;",
    "          }",
    "",
    "          args = {...args, ...returnsToVariables((field as MergedUnion$<typeof field>)[key], path.concat(key))}",
    "",
    "          return args;",
    "        }))",
    "    : {};",
    ,
  ].join("\n");
