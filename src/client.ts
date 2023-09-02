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

const gqlTypeToString = (type: TypeNode): string => {
  switch (type.kind) {
    case Kind.NAMED_TYPE: {
      return type.name.value;
    }
    case Kind.LIST_TYPE:
      return `[${gqlTypeToString(type.type)}]`;
    case Kind.NON_NULL_TYPE:
      return `${gqlTypeToString(type.type)}!`;
  }
};

// Generators

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

const types = (schema: DocumentNode, enums: Array<EnumTypeDefinitionNode>) =>
  [
    "type Arguments = string | number | boolean | null | {",
    "    [K in string]: Arguments;",
    "} | Array<Arguments>;",
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
      "type ClientOptions = {",
      "  fetch?: typeof fetch;",
      "};",
      "",
      "type MergedUnion<T> = (T extends any ? (k: T) => void : never) extends ((k: infer I) => void) ? I : never;",
    ])
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
                `${field.name.value}: { query: '${typeToString(
                  field.type,
                  scalars,
                  enums,
                  "Query"
                )}' as const${
                  (field.arguments || []).length > 0
                    ? `, $args: { ${(field.arguments || [])
                        .map(
                          (argument) =>
                            `${argument.name.value}: '${gqlTypeToString(
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
    "        const key = Object.keys(field).filter((key) => key !== '$args')[0] as Exclude<KeysOfUnion<Exclude<Query, string>>, '$args'>;",
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
    "          const key = Object.keys(field).filter((key) => key !== '$args')[0] as Exclude<KeysOfUnion<Exclude<Query, string>>, '$args'>;",
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
    "const argsToGql = <Q extends keyof typeof queryToGqlTypes>(argTypes: ArgumentTypes, args: Record<string, Arguments>, query: Q, returns: Fields) =>",
    "  Object.keys(args)",
    "    .map((key) => `$${key}: ${argTypes[key]}`)",
    "    .concat(resultsToArgs(query, returns))",
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
    "          const key = Object.keys(field).filter((key) => key !== '$args')[0] as Exclude<KeysOfUnion<Exclude<Query, string>>, '$args'>;",
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

const call = () =>
  [
    "const call = (",
    "  graphqlServerUrl: string,",
    "  query: string,",
    "  returns: Fields,",
    "  args: Record<string, Arguments> | null,",
    "  argTypes: ArgumentTypes | null,",
    "  queryType: keyof typeof queryToGqlTypes,",
    "  options: ClientOptions = {}",
    ") =>",
    "  (options.fetch || fetch)(graphqlServerUrl, {",
    "    method: 'POST',",
    "    body: JSON.stringify({",
    "      operationName: query,",
    "      query: `query ${query}${",
    "        argTypes && args ? `(${argsToGql(argTypes, args, queryType, returns)})` : ''",
    "      } {\\n ${query}${",
    "        args ? `(${variablesToArgs(args)})` : ''",
    "      }\\n ${fieldsToQuery(returns)} }`,",
    "      variables: { ...args, ...returnsToVariables(returns) },",
    "    }),",
    "    headers: {",
    "      'Content-Type': 'application/json',",
    "    },",
    "  }).then((response: Response) => response.json());",
  ].join("\n");

const fieldQuery = (
  field: FieldDefinitionNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>
): string =>
  isScalar(field.type, scalars) || isEnum(field.type, enums)
    ? `'${field.name.value}'`
    : `{ ${field.name.value}: ${typeToString(
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
                  }: ${typeToString(arg.type, scalars, enums)}`
              )
              .join(", ")} }`
          : ""
      } }`;

const typeToString = (
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
      return typeToString(type.type, scalars, enums, suffix);
  }
};

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
              `  ${field.name.value}: ${typeToString(
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
                }: ${typeToString(
                  field.type,
                  scalars,
                  enums
                )}Query } ? ${typeToString(
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
              `  ${field.name.value}: ${typeToString(
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
  enums: Array<EnumTypeDefinitionNode>
) =>
  [
    !isScalar(field.type, scalars) ? "query: Array<T>" : null,
    field.arguments && field.arguments.length > 0
      ? `args${
          field.arguments.every((arg) => isGqlTypeOptional(arg.type)) ? "?" : ""
        }: { ${field.arguments
          .map(
            (arg) =>
              `${arg.name.value}${
                isGqlTypeOptional(arg.type) ? "?" : ""
              }: ${typeToString(arg.type, scalars, enums)}`
          )
          .join(", ")} }`
      : null,
  ]
    .filter(Boolean)
    .join(", ");

const gqlArgTypes = (args: readonly InputValueDefinitionNode[]) =>
  args
    .map((node) => `${node.name.value}: '${gqlTypeToString(node.type)}'`)
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
            : `<T extends ${typeToString(
                field.type,
                scalars,
                enums
              )}Query[number]>`
        }(${queryFunctionParameters(field, scalars, enums)}): Promise<${
          isScalar(field.type, scalars)
            ? typeToString(field.type, scalars, enums)
            : `${typeToString(field.type, scalars, enums)}Result<T>`
        }> => call(graphqlServerUrl, '${field.name.value}', ${
          !isScalar(field.type, scalars) ? "query" : "null"
        }${
          field.arguments && field.arguments.length > 0
            ? `, args, { ${gqlArgTypes(field.arguments)} }`
            : ""
        }, '${typeToString(field.type, scalars, enums)}Query', options),`,
      ].join("\n")
    )
    .join("\n");

const client = (
  schema: DocumentNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>
) => {
  const queries = schema.definitions.find(
    (node) =>
      node.kind === Kind.OBJECT_TYPE_DEFINITION && node.name.value === "Query"
  ) as ObjectTypeDefinitionNode | undefined;
  const mutations = schema.definitions.find(
    (node) =>
      node.kind === Kind.OBJECT_TYPE_DEFINITION &&
      node.name.value === "Mutation"
  ) as ObjectTypeDefinitionNode | undefined;

  return (
    // TODO: Handle custom headers (i.e. for authentication)
    [`const enodia = (graphqlServerUrl: string, options: ClientOptions) => ({`]
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

// Client generator

export type ScalarType = { path: string; name?: string } | { name: string };

type Options = {
  scalarTypes: Record<string, ScalarType>;
};

const schemaToClient = (schema: DocumentNode, { scalarTypes }: Options) => {
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
    customScalarsImports(scalarTypes, customScalars),
    types(schema, enums),
    queryArgsToTypes(schema, scalars, enums),
    fieldsToQuery(),
    resultsToArgs(),
    argsToGql(),
    variablesToArgs(),
    returnsToVariables(),
    call(),
    queriesTypes(schema, scalars, enums),
    client(schema, scalars, enums),
  ].join("\n\n");
};

export default schemaToClient;
