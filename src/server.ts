import {
  DocumentNode,
  EnumTypeDefinitionNode,
  FieldDefinitionNode,
  InputObjectTypeDefinitionNode,
  Kind,
  ObjectTypeDefinitionNode,
  TypeNode,
} from "graphql";
import { GqlScalarToTs, ScalarType } from "./types.ts";
import {
  baseScalars,
  customScalarsImports,
  getCustomScalars,
  getMutations,
  getQueries,
  gqlTypeToTsName,
  gqlTypeToTsString,
  isEnum,
  isGqlTypeOptional,
  isScalar,
  queriesTypes,
  types,
} from "./generator/helpers.ts";

// Helper

const toReturn = (type: string) => `${type} | Promise<${type}>`;

const partialize = (type: string) => `Prettify<Omit<${type}, ${type}Keys>>`;

const gqlTypeToReturnTsString = (
  type: TypeNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
  optional = true
): string => {
  switch (type.kind) {
    case Kind.NAMED_TYPE:
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
        false
      )}>${optional ? " | undefined" : ""}`;
    case Kind.NON_NULL_TYPE:
      return gqlTypeToReturnTsString(type.type, scalars, enums, false);
  }
};

const queryFunctionParameters = (
  field: FieldDefinitionNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
  withArgs = true
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
                { suffix: "", optional: false }
              )}`
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
  enums: Array<EnumTypeDefinitionNode>
) => {
  const types = schema.definitions.filter(
    (node) =>
      node.kind === Kind.OBJECT_TYPE_DEFINITION &&
      // These types are not concerned by resolver contraints
      !["Query", "Mutation"].includes(node.name.value) &&
      !isEnum(node, enums)
  ) as Array<ObjectTypeDefinitionNode>;

  return types
    .map((node) => `${node.name.value}Keys extends keyof ${node.name.value}`)
    .join(", ");
};

const fieldResolversGenericSpread = (
  schema: DocumentNode,
  enums: Array<EnumTypeDefinitionNode>
) => {
  const types = schema.definitions.filter(
    (node) =>
      node.kind === Kind.OBJECT_TYPE_DEFINITION &&
      // These types are not concerned by resolver contraints
      !["Query", "Mutation"].includes(node.name.value) &&
      !isEnum(node, enums)
  ) as Array<ObjectTypeDefinitionNode>;

  return types.map((node) => `${node.name.value}Keys`).join(", ");
};

const fieldTypeToSchemaType = (
  type: TypeNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>
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

      if (isEnum(type, enums)) {
        return type.name.value;
      }

      return type.name.value;
    case Kind.LIST_TYPE:
      return `new GraphQLList(${fieldTypeToSchemaType(
        type.type,
        scalars,
        enums
      )})`;
    case Kind.NON_NULL_TYPE:
      return `new GraphQLNonNull(${fieldTypeToSchemaType(
        type.type,
        scalars,
        enums
      )})`;
  }
};

// Generators

const imports = () =>
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
      "GraphQLEnumType",
      "GraphQLString",
      "GraphQLInt",
      "GraphQLFloat",
      "GraphQLBoolean",
    ].join(", ")} } from "graphql"`,
  ].join("\n");

const serverTypes = () =>
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
  ].join("\n");

const fieldsResolversType = (
  schema: DocumentNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>
) => {
  const types = schema.definitions.filter(
    (node) =>
      node.kind === Kind.OBJECT_TYPE_DEFINITION &&
      // These types are not concerned by resolver contraints
      !["Query", "Mutation"].includes(node.name.value) &&
      !isEnum(node, enums)
  ) as Array<ObjectTypeDefinitionNode>;

  const partialResolverConstraints = fieldResolversContraint(schema, enums);

  const extenders = (node: ObjectTypeDefinitionNode) =>
    ["("]
      .concat(
        (node.fields || []).map(
          (field) =>
            `Key extends "${field.name.value}" ? ${gqlTypeToReturnTsString(
              field.type,
              scalars,
              enums
            )} : `
        )
      )
      .concat([" never", ")"])
      .join("");

  const partialResolvers = types
    .map((node) =>
      [
        `    ${node.name.value}: {`,
        `        [Key in ${node.name.value}Keys]:`,
        `            (${node.name.value}: ${partialize(
          node.name.value
        )}, context: Context) =>`,
        `            ${toReturn(extenders(node))}`,
        "    };",
      ].join("\n")
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
  enums: Array<EnumTypeDefinitionNode>
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
                  enums
                )}${
                  field.arguments && field.arguments.length > 0 ? ", " : ""
                }context: Context) => ${toReturn(
                  gqlTypeToReturnTsString(field.type, scalars, enums)
                )}`
            )
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
                enums
              );
              return `        ${field.name.value}: (${queryFunctionParameters(
                field,
                scalars,
                enums
              )}${
                field.arguments && field.arguments.length > 0 ? ", " : ""
              }context: Context) => DetailedResponse<${returnType}> | ${returnType} | Promise<DetailedResponse<${returnType}> | ${returnType}>`;
            })
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

const typesFromConfiguration = (
  schema: DocumentNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>
) => {
  const types = schema.definitions.filter(
    (node) =>
      node.kind === Kind.OBJECT_TYPE_DEFINITION &&
      // These types are not concerned by resolver contraints
      !["Query", "Mutation"].includes(node.name.value) &&
      !isEnum(node, enums)
  ) as Array<ObjectTypeDefinitionNode>;

  const inputs = schema.definitions.filter(
    (node) => node.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION
  ) as Array<InputObjectTypeDefinitionNode>;

  const scalarTypes = scalars
    .filter((scalar) => !baseScalars.some((base) => base.gql === scalar.gql))
    .map(
      (scalar) =>
        `const ${
          scalar.gql
        } = ${`new GraphQLScalarType({ name: "${scalar.gql}" })`}`
    );

  const enumTypes = enums.map(
    (en) =>
      `const ${en.name.value} = new GraphQLEnumType({ name: "${
        en.name.value
      }", values: {${(en.values || [])
        .map((value) => `${value.name.value}: {}`)
        .join(", ")}} })`
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
            enums
          )},`,
          // TODO: Add the proper source type to the cast
          `            resolve: "${field.name.value}" in fieldsConfiguration.${type.name.value} ? (source, args, context, info) => (fieldsConfiguration.${type.name.value} as { ${field.name.value}: (source: any, context: { userContext: Context }) => unknown }).${field.name.value}(source, context.userContext) : undefined`,
          "        },",
        ]),
        "    })",
        "})",
      ])
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
            enums
          )},`,
          "        },",
        ]),
        "    })",
        "})",
      ])
    );
};

const schemaFromConfiguration = (
  schema: DocumentNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>
) => {
  const types = schema.definitions.filter(
    (node) =>
      node.kind === Kind.OBJECT_TYPE_DEFINITION &&
      // These types are not concerned by resolver contraints
      !["Query", "Mutation"].includes(node.name.value) &&
      !isEnum(node, enums)
  ) as Array<ObjectTypeDefinitionNode>;

  const queries = getQueries(schema);

  const queryFields =
    queries && queries.fields
      ? queries.fields.flatMap((field) => [
          `            ${field.name.value}: {`,
          `                type: ${fieldTypeToSchemaType(
            field.type,
            scalars,
            enums
          )},`,
          "                args: {",
          ...(field.arguments || []).map(
            (arg) =>
              `                    ${
                arg.name.value
              }: { type: ${fieldTypeToSchemaType(arg.type, scalars, enums)} },`
          ),
          "                },",
          `                resolve: (source, args, context, info) => Query.${
            field.name.value
          }(${
            field.arguments && field.arguments.length > 0 ? "args, " : ""
          }context.userContext)`,
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
            enums
          )},`,
          "                args: {",
          ...(field.arguments || []).map(
            (arg) =>
              `                    ${
                arg.name.value
              }: { type: ${fieldTypeToSchemaType(arg.type, scalars, enums)} },`
          ),
          "                },",
          "                resolve: async (source, args, context, info) => {",
          `                    const result = await Mutation.${
            field.name.value
          }(${
            field.arguments && field.arguments.length > 0 ? "args, " : ""
          }context.userContext)`,
          "",
          "                    if (result instanceof DetailedResponse) {",
          "                        context.response.setHeaders(new Map(Object.entries(result.headers)))",
          "                        context.response.setHeader('Set-Cookie', Object.entries(result.cookies).map(([key, value]) => `${key}=${value}`))",
          "                    }",
          "",
          "                    return result instanceof DetailedResponse ? result.content : result",
          "                }",
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
          (scalar) => !baseScalars.some((base) => base.gql === scalar.gql)
        )
        .map((scalar) => scalar.gql)
        .join(", ")}`,
      `        ${enums.map((en) => en.name.value).join(", ")}`,
      `        ${types.map((type) => type.name.value).join(", ")}`,
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
  enums: Array<EnumTypeDefinitionNode>
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
    ...typesFromConfiguration(schema, scalars, enums).map(
      (line) => `    ${line}`
    ),
    "    Object.entries(fieldsConfiguration)",
    "",
    ...schemaFromConfiguration(schema, scalars, enums).map(
      (line) => `    ${line}`
    ),
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
    "            const { query, variables } = global.JSON.parse(body)",
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
  scalarTypes: Record<string, ScalarType>;
};

const schemaToServer = (schema: DocumentNode, { scalarTypes }: Options) => {
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
    imports(),
    customScalarsImports(scalarTypes, customScalars),
    types(schema, scalars, enums),
    serverTypes(),
    queriesTypes(schema, scalars, enums),
    fieldsResolversType(schema, scalars, enums),
    queriesAndMutationsResolversType(schema, scalars, enums),
    server(schema, scalars, enums),
  ].join("\n\n");
};

export default schemaToServer;
