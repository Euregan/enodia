import {
  DocumentNode,
  EnumTypeDefinitionNode,
  Kind,
  ObjectTypeDefinitionNode,
} from "graphql";
import {
  getMutations,
  getQueries,
  gqlTypeToGqlString,
  gqlTypeToTsName,
  isEnum,
  isScalar,
} from "./helpers.ts";
import { GqlScalarToTs } from "../types.ts";

export const clientTypes = (schema: DocumentNode, react: boolean = false) =>
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

export const queryArgsToTypes = (
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

export const fieldsToQuery = () =>
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

export const argsToGql = () =>
  [
    "const argsToGql = (argTypes: ArgumentTypes, args: Record<string, Arguments>, query: keyof typeof queryToGqlTypes | null, returns: Fields | null) =>",
    "  Object.keys(args)",
    "    .map((key) => `$${key}: ${argTypes[key]}`)",
    "    .concat(query && returns ? resultsToArgs(query, returns) : [])",
    "    .join(', ');",
  ].join("\n");

export const variablesToArgs = () =>
  [
    "const variablesToArgs = (args: Record<string, Arguments>) =>",
    "  Object.keys(args)",
    "    .map((key) => `${key}: $${key}`)",
    "    .join(', ');",
  ].join("\n");

export const returnsToVariables = () =>
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
