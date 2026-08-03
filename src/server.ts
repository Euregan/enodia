import {
  DocumentNode,
  EnumTypeDefinitionNode,
  FieldDefinitionNode,
  InputObjectTypeDefinitionNode,
  Kind,
  ObjectTypeDefinitionNode,
  TypeNode,
  UnionTypeDefinitionNode,
} from "graphql";
import { GqlScalarToTs, ScalarTypeInfo } from "./types.ts";
import {
  baseScalars,
  getMutations,
  getObjectTypes,
  getQueries,
  gqlTypeToTsName,
  gqlTypeToTsString,
  isEnum,
  isGqlTypeOptional,
  isScalar,
  isUnion,
  queriesTypes,
  resolveScalars,
  types,
} from "./generator/helpers.ts";

// Helper

const toReturn = (type: string) => `${type} | Promise<${type}>`;

const wrapPermission = (type: string, permissions: boolean) =>
  permissions ? `Authorized<${type}> | Denied` : type;

const partialize = (type: string) => `Prettify$<Omit<${type}, ${type}Keys>>`;

const gqlTypeToReturnTsString = (
  type: TypeNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
  unions: Array<UnionTypeDefinitionNode>,
  optional = true,
): string => {
  switch (type.kind) {
    case Kind.NAMED_TYPE:
      if (isUnion(type, unions)) {
        const members = (
          unions.find((union) => union.name.value === type.name.value)!.types ||
          []
        )
          .map(
            (member) =>
              `(${partialize(member.name.value)} & { __typename: '${
                member.name.value
              }' })`,
          )
          .join(" | ");
        return `(${members})${optional ? " | undefined" : ""}`;
      }
      const tsName = gqlTypeToTsName(type, scalars, enums);
      const partialized =
        !isScalar(type, scalars) && !isEnum(type, enums)
          ? partialize(tsName)
          : tsName;
      return `${partialized}${optional ? " | undefined" : ""}`;
    case Kind.LIST_TYPE:
      return `Array<${gqlTypeToReturnTsString(
        type.type.kind === Kind.NON_NULL_TYPE ? type.type.type : type.type,
        scalars,
        enums,
        unions,
        false,
      )}>${optional ? " | undefined" : ""}`;
    case Kind.NON_NULL_TYPE:
      return gqlTypeToReturnTsString(type.type, scalars, enums, unions, false);
  }
};

const queryFunctionParameters = (
  field: FieldDefinitionNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
  withArgs = true,
) =>
  [
    withArgs && field.arguments && field.arguments.length > 0
      ? `args: { ${field.arguments
          .map(
            (arg) =>
              `${arg.name.value}${
                isGqlTypeOptional(arg.type) ? "?" : ""
              }: ${gqlTypeToTsString(
                { type: arg.type, scalars, enums },
                { suffix: "", optional: false },
              )}`,
          )
          .join(", ")} }${
          field.arguments.every((arg) => isGqlTypeOptional(arg.type))
            ? " | undefined"
            : ""
        }`
      : null,
  ]
    .filter(Boolean)
    .join(", ");

const fieldResolversContraint = (
  schema: DocumentNode,
  enums: Array<EnumTypeDefinitionNode>,
) => {
  const types = getObjectTypes(schema, enums);

  return types
    .map((node) => `${node.name.value}Keys extends keyof ${node.name.value}`)
    .join(", ");
};

const fieldResolversGenericSpread = (
  schema: DocumentNode,
  enums: Array<EnumTypeDefinitionNode>,
) => {
  const types = getObjectTypes(schema, enums);

  return types.map((node) => `${node.name.value}Keys`).join(", ");
};

const fieldTypeToSchemaType = (
  type: TypeNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
): string => {
  switch (type.kind) {
    case Kind.NAMED_TYPE:
      if (isScalar(type, scalars)) {
        switch (type.name.value) {
          case "String":
            return "GraphQLString";
          case "Int":
            return "GraphQLInt";
          case "ID":
            return "GraphQLID";
          case "Float":
            return "GraphQLFloat";
          case "Boolean":
            return "GraphQLBoolean";
        }
        return type.name.value;
      }

      return type.name.value;
    case Kind.LIST_TYPE:
      return `new GraphQLList(${fieldTypeToSchemaType(
        type.type,
        scalars,
        enums,
      )})`;
    case Kind.NON_NULL_TYPE:
      return `new GraphQLNonNull(${fieldTypeToSchemaType(
        type.type,
        scalars,
        enums,
      )})`;
  }
};

// Generators

const imports = (permissions: boolean) =>
  [
    'import { IncomingMessage, ServerResponse } from "http"',
    `import { ${[
      "graphql",
      "GraphQLSchema",
      "GraphQLObjectType",
      "GraphQLInputObjectType",
      "GraphQLNonNull",
      "GraphQLList",
      "GraphQLID",
      "GraphQLScalarType",
      "GraphQLUnionType",
      "GraphQLEnumType",
      "GraphQLString",
      "GraphQLInt",
      "GraphQLFloat",
      "GraphQLBoolean",
      ...(permissions ? ["GraphQLError"] : []),
    ].join(", ")} } from "graphql"`,
  ].join("\n");

const serverTypes = (permissions: boolean) =>
  [
    "export class DetailedResponse<T> {",
    "  public content: T",
    "  public headers: Record<string, string>",
    "  public cookies: Record<string, string>",
    "",
    "  constructor({ content, headers = {}, cookies = {} }: { content: T, headers?: Record<string, string>, cookies?: Record<string, string> }) {",
    "    this.content = content",
    "    this.headers = headers",
    "    this.cookies = cookies",
    "  }",
    "}",
  ]
    .concat(
      permissions
        ? [
            "",
            "export class Authorized<T> {",
            "  public content: T",
            "",
            "  constructor(content: T) {",
            "    this.content = content",
            "  }",
            "}",
            "",
            "export class Denied {",
            "  public reason?: string",
            "",
            "  constructor(reason?: string) {",
            "    this.reason = reason",
            "  }",
            "}",
          ]
        : [],
    )
    .join("\n");

const fieldsResolversType = (
  schema: DocumentNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
  unions: Array<UnionTypeDefinitionNode>,
  permissions: boolean,
) => {
  const types = getObjectTypes(schema, enums);

  const partialResolverConstraints = fieldResolversContraint(schema, enums);

  const extenders = (node: ObjectTypeDefinitionNode) =>
    ["("]
      .concat(
        (node.fields || []).map(
          (field) =>
            `Key extends "${field.name.value}" ? ${gqlTypeToReturnTsString(
              field.type,
              scalars,
              enums,
              unions,
            )} : `,
        ),
      )
      .concat([" never", ")"])
      .join("");

  const partialResolvers = types
    .map((node) =>
      [
        `    ${node.name.value}: {`,
        `        [Key in ${node.name.value}Keys]:`,
        `            (${node.name.value}: ${partialize(
          node.name.value,
        )}, context: Context) =>`,
        `            ${toReturn(wrapPermission(extenders(node), permissions))}`,
        "    };",
      ].join("\n"),
    )
    .join("\n");

  return [
    `export type FieldsResolvers<Context, ${partialResolverConstraints}> = {`,
  ]
    .concat(partialResolvers)
    .concat(["}"])
    .join("\n");
};

const queriesAndMutationsResolversType = (
  schema: DocumentNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
  unions: Array<UnionTypeDefinitionNode>,
  permissions: boolean,
) => {
  const partialResolverConstraints = fieldResolversContraint(schema, enums);

  const queries = getQueries(schema);
  const query =
    queries && queries.fields
      ? ["    Query: {"]
          .concat(
            queries.fields.map(
              (field) =>
                `        ${field.name.value}: (${queryFunctionParameters(
                  field,
                  scalars,
                  enums,
                )}${
                  field.arguments && field.arguments.length > 0 ? ", " : ""
                }context: Context) => ${toReturn(
                  wrapPermission(
                    gqlTypeToReturnTsString(field.type, scalars, enums, unions),
                    permissions,
                  ),
                )}`,
            ),
          )
          .concat(["    }"])
      : [];

  const mutations = getMutations(schema);
  const mutation =
    mutations && mutations.fields
      ? ["    Mutation: {"]
          .concat(
            mutations.fields.map((field) => {
              const returnType = gqlTypeToReturnTsString(
                field.type,
                scalars,
                enums,
                unions,
              );
              const mutationReturnType = wrapPermission(
                `DetailedResponse<${returnType}> | ${returnType}`,
                permissions,
              );
              return `        ${field.name.value}: (${queryFunctionParameters(
                field,
                scalars,
                enums,
              )}${
                field.arguments && field.arguments.length > 0 ? ", " : ""
              }context: Context) => ${mutationReturnType} | Promise<${mutationReturnType}>`;
            }),
          )
          .concat(["    }"])
      : [];

  return [
    `export type QueriesAndMutationsResolvers<Context, ${partialResolverConstraints}> = {`,
  ]
    .concat(query)
    .concat(mutation)
    .concat(["}"])
    .join("\n");
};

const fieldResolveExpression = (
  fieldName: string,
  typeName: string,
  permissions: boolean,
) =>
  permissions
    ? `"${fieldName}" in fieldsConfiguration.${typeName} ? async (source, args, context, info) => { const result = await (fieldsConfiguration.${typeName} as { ${fieldName}: (source: any, context: { userContext: Context }) => Authorized<unknown> | Denied | Promise<Authorized<unknown> | Denied> }).${fieldName}(source, context.userContext); if (result instanceof Denied) { throw new GraphQLError(result.reason ?? "Forbidden") } return result.content } : undefined`
    : `"${fieldName}" in fieldsConfiguration.${typeName} ? (source, args, context, info) => (fieldsConfiguration.${typeName} as { ${fieldName}: (source: any, context: { userContext: Context }) => unknown }).${fieldName}(source, context.userContext) : undefined`;

const typesFromConfiguration = (
  schema: DocumentNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
  unions: Array<UnionTypeDefinitionNode>,
  permissions: boolean,
) => {
  const types = getObjectTypes(schema, enums);

  const inputs = schema.definitions.filter(
    (node) => node.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION,
  ) as Array<InputObjectTypeDefinitionNode>;

  const scalarTypes = scalars
    .filter((scalar) => !baseScalars.some((base) => base.gql === scalar.gql))
    .map(
      (scalar) =>
        `const ${scalar.gql} = new GraphQLScalarType({ name: "${scalar.gql}"${
          scalar.encode
            ? `, serialize: (value: any) => (${scalar.encode})(value)`
            : ""
        }${
          scalar.decode
            ? `, parseValue: (value: any) => (${scalar.decode})(value)`
            : ""
        } })`,
    );

  const enumTypes = enums.map(
    (en) =>
      `const ${en.name.value} = new GraphQLEnumType({ name: "${
        en.name.value
      }", values: {${(en.values || [])
        .map((value) => `${value.name.value}: {}`)
        .join(", ")}} })`,
  );

  return scalarTypes
    .concat("")
    .concat(enumTypes)
    .concat("")
    .concat(
      types.flatMap((type) => [
        `const ${type.name.value}: GraphQLObjectType = new GraphQLObjectType({`,
        `    name: "${type.name.value}",`,
        "    fields: () => ({",
        ...(type.fields || []).flatMap((field) => [
          `        ${field.name.value}: {`,
          `            type: ${fieldTypeToSchemaType(
            field.type,
            scalars,
            enums,
          )},`,
          // TODO: Add the proper source type to the cast
          `            resolve: ${fieldResolveExpression(field.name.value, type.name.value, permissions)}`,
          "        },",
        ]),
        "    })",
        "})",
      ]),
    )
    .concat("")
    .concat(
      unions.flatMap((union) => [
        `const ${union.name.value}: GraphQLUnionType = new GraphQLUnionType({`,
        `    name: "${union.name.value}",`,
        `    types: [${(union.types || [])
          .map((member) => member.name.value)
          .join(", ")}],`,
        `    resolveType: (value) => (value as { __typename: string }).__typename,`,
        "})",
      ]),
    )
    .concat("")
    .concat(
      inputs.flatMap((input) => [
        `const ${input.name.value}: GraphQLInputObjectType = new GraphQLInputObjectType({`,
        `    name: "${input.name.value}",`,
        "    fields: () => ({",
        ...(input.fields || []).flatMap((field) => [
          `        ${field.name.value}: {`,
          `            type: ${fieldTypeToSchemaType(
            field.type,
            scalars,
            enums,
          )},`,
          "        },",
        ]),
        "    })",
        "})",
      ]),
    );
};

const queryResolveExpression = (
  fieldName: string,
  withArgs: boolean,
  permissions: boolean,
) =>
  permissions
    ? [
        "                resolve: async (source, args, context, info) => {",
        `                    const result = await Query.${fieldName}(${
          withArgs ? "args, " : ""
        }context.userContext)`,
        "",
        "                    if (result instanceof Denied) {",
        `                        throw new GraphQLError(result.reason ?? "Forbidden")`,
        "                    }",
        "",
        "                    return result.content",
        "                }",
      ]
    : [
        `                resolve: (source, args, context, info) => Query.${fieldName}(${
          withArgs ? "args, " : ""
        }context.userContext)`,
      ];

const schemaFromConfiguration = (
  schema: DocumentNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
  unions: Array<UnionTypeDefinitionNode>,
  permissions: boolean,
) => {
  const types = getObjectTypes(schema, enums);

  const queries = getQueries(schema);

  const queryFields =
    queries && queries.fields
      ? queries.fields.flatMap((field) => [
          `            ${field.name.value}: {`,
          `                type: ${fieldTypeToSchemaType(
            field.type,
            scalars,
            enums,
          )},`,
          "                args: {",
          ...(field.arguments || []).map(
            (arg) =>
              `                    ${
                arg.name.value
              }: { type: ${fieldTypeToSchemaType(arg.type, scalars, enums)} },`,
          ),
          "                },",
          ...queryResolveExpression(
            field.name.value,
            Boolean(field.arguments && field.arguments.length > 0),
            permissions,
          ),
          "            },",
        ])
      : [];

  const query =
    queryFields.length > 0
      ? [
          "    query: new GraphQLObjectType({",
          '        name: "Query",',
          "        fields: {",
          ...queryFields,
          "        },",
          "    }),",
        ]
      : [];

  const mutations = getMutations(schema);

  const mutationFields =
    mutations && mutations.fields
      ? mutations.fields.flatMap((field) => [
          `            ${field.name.value}: {`,
          `                type: ${fieldTypeToSchemaType(
            field.type,
            scalars,
            enums,
          )},`,
          "                args: {",
          ...(field.arguments || []).map(
            (arg) =>
              `                    ${
                arg.name.value
              }: { type: ${fieldTypeToSchemaType(arg.type, scalars, enums)} },`,
          ),
          "                },",
          ...(permissions
            ? [
                "                resolve: async (source, args, context, info) => {",
                `                    const permissionResult = await Mutation.${
                  field.name.value
                }(${
                  field.arguments && field.arguments.length > 0
                    ? "args, "
                    : ""
                }context.userContext)`,
                "",
                "                    if (permissionResult instanceof Denied) {",
                `                        throw new GraphQLError(permissionResult.reason ?? "Forbidden")`,
                "                    }",
                "",
                "                    const result = permissionResult.content",
                "",
                "                    if (result instanceof DetailedResponse) {",
                "                        context.response.setHeaders(new Map(Object.entries(result.headers)))",
                "                        context.response.setHeader('Set-Cookie', Object.entries(result.cookies).map(([key, value]) => `${key}=${value}`))",
                "                    }",
                "",
                "                    return result instanceof DetailedResponse ? result.content : result",
                "                }",
              ]
            : [
                "                resolve: async (source, args, context, info) => {",
                `                    const result = await Mutation.${
                  field.name.value
                }(${
                  field.arguments && field.arguments.length > 0
                    ? "args, "
                    : ""
                }context.userContext)`,
                "",
                "                    if (result instanceof DetailedResponse) {",
                "                        context.response.setHeaders(new Map(Object.entries(result.headers)))",
                "                        context.response.setHeader('Set-Cookie', Object.entries(result.cookies).map(([key, value]) => `${key}=${value}`))",
                "                    }",
                "",
                "                    return result instanceof DetailedResponse ? result.content : result",
                "                }",
              ]),
          "            },",
        ])
      : [];

  const mutation =
    mutationFields.length > 0
      ? [
          "    mutation: new GraphQLObjectType({",
          '        name: "Mutation",',
          "        fields: {",
          ...mutationFields,
          "        },",
          "    }),",
        ]
      : [];

  return [
    "const schema = new GraphQLSchema({",
    "    assumeValid: true,",
    ...query,
    ...mutation,
    "    types: [",
    ...[
      `        ${scalars
        .filter(
          (scalar) => !baseScalars.some((base) => base.gql === scalar.gql),
        )
        .map((scalar) => scalar.gql)
        .join(", ")}`,
      `        ${enums.map((en) => en.name.value).join(", ")}`,
      `        ${types.map((type) => type.name.value).join(", ")}`,
      `        ${unions.map((union) => union.name.value).join(", ")}`,
    ]
      // We remove empty lines
      .filter((line) => line.trim())
      .flatMap((element) => `${element},`),
    "    ],",
    "})",
  ];
};

const server = (
  schema: DocumentNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
  unions: Array<UnionTypeDefinitionNode>,
  permissions: boolean,
) => {
  const partialResolverConstraints = fieldResolversContraint(schema, enums);
  const resolversGenerics = fieldResolversGenericSpread(schema, enums);

  const mutations = getMutations(schema);

  return [
    "type EnodiaOptions<Request extends IncomingMessage = IncomingMessage, Response extends ServerResponse<IncomingMessage> = ServerResponse<IncomingMessage>, Context = void> = {",
    "    instantiateContext?: (request: Request, response: Response) => Context | Promise<Context>",
    "}",
    "",
    "export const buildSchema =",
    "    <Context = void>() =>",
    `    <${partialResolverConstraints}>(fieldsConfiguration: FieldsResolvers<Context, ${resolversGenerics}>) =>`,
    `    ({ Query${
      mutations ? ", Mutation" : ""
    } }: QueriesAndMutationsResolvers<Context, ${resolversGenerics}>) => {`,
    ...typesFromConfiguration(schema, scalars, enums, unions, permissions).map(
      (line) => `    ${line}`,
    ),
    "    Object.entries(fieldsConfiguration)",
    "",
    ...schemaFromConfiguration(
      schema,
      scalars,
      enums,
      unions,
      permissions,
    ).map((line) => `    ${line}`),
    "",
    "    return schema",
    "}",
    "",
    "export const server =",
    "    <Request extends IncomingMessage = IncomingMessage, Response extends ServerResponse<IncomingMessage> = ServerResponse<IncomingMessage>, Context = void>({ instantiateContext }: EnodiaOptions<Request, Response, Context> = {}) =>",
    `    <${partialResolverConstraints}>(fieldsConfiguration: FieldsResolvers<Context, ${resolversGenerics}>) =>`,
    `    ({ Query${
      mutations ? ", Mutation" : ""
    } }: QueriesAndMutationsResolvers<Context, ${resolversGenerics}>) => {`,
    `    const schema = buildSchema<Context>()(fieldsConfiguration)({ Query${
      mutations ? ", Mutation" : ""
    } })`,
    "",
    "    return async (request: Request, response: Response) => {",
    "        let body = ''",
    "",
    "        request.on('data', (chunk) => {",
    "            body += chunk.toString()",
    "        })",
    "",
    "        request.on('end', async () => {",
    "            let parsedBody: { query: string, variables?: Record<string, unknown> }",
    "",
    "            try {",
    "                parsedBody = global.JSON.parse(body)",
    "            } catch {",
    "                response.statusCode = 400",
    "                response.end(global.JSON.stringify({ errors: [{ message: 'Invalid JSON body' }] }))",
    "                return",
    "            }",
    "",
    "            const { query, variables } = parsedBody",
    "",
    "            const result = await graphql({",
    "                schema,",
    "                source: query,",
    "                variableValues: variables,",
    "                contextValue: {",
    "                    request,",
    "                    response,",
    "                    userContext: await instantiateContext?.(request, response)",
    "                },",
    "            })",
    "",
    "            response.statusCode = 200",
    "            response.end(global.JSON.stringify(result))",
    "        })",
    "    }",
    "}",
  ].join("\n");
};

// Server generator

type Options = {
  scalarTypes: Record<string, ScalarTypeInfo>;
  scalarImports: string;
  permissions?: boolean;
};

const schemaToServer = (
  schema: DocumentNode,
  { scalarTypes, scalarImports, permissions = false }: Options,
) => {
  const { scalars, enums, unions } = resolveScalars(schema, scalarTypes);

  return [
    imports(permissions),
    scalarImports,
    types(schema, scalars, enums, unions),
    serverTypes(permissions),
    queriesTypes(schema, scalars, enums, unions),
    fieldsResolversType(schema, scalars, enums, unions, permissions),
    queriesAndMutationsResolversType(
      schema,
      scalars,
      enums,
      unions,
      permissions,
    ),
    server(schema, scalars, enums, unions, permissions),
  ].join("\n\n");
};

export default schemaToServer;
