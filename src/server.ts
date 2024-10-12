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
  getQueries,
  gqlTypeToTsName,
  isEnum,
  isGqlTypeOptional,
  isScalar,
  queriesTypes,
  types,
} from "./generator/helpers.ts";

// Helper

export const gqlTypeToTsString = (
  type: TypeNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
  wrapper: (type: string) => string = (type) => type,
  nullable = true
): string => {
  switch (type.kind) {
    case Kind.NAMED_TYPE:
      return `${wrapper(gqlTypeToTsName(type, scalars, enums))}${
        nullable ? " | null" : ""
      }`;
    case Kind.LIST_TYPE:
      return `Array<${gqlTypeToTsString(
        type.type,
        scalars,
        enums,
        wrapper,
        nullable
      )}>`;
    case Kind.NON_NULL_TYPE:
      return gqlTypeToTsString(type.type, scalars, enums, wrapper, false);
  }
};

const toReturn = (type: string) => `${type} | Promise<${type}>`;

const partialize = (type: string) => `Prettify<Omit<${type}, ${type}Key>>`;

const queryFunctionParameters = (
  field: FieldDefinitionNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
  withArgs = true
) =>
  [
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
    .map((node) => `${node.name.value}Key extends keyof ${node.name.value}`)
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

  return types.map((node) => `${node.name.value}Key`).join(", ");
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
      "buildSchema",
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
            `Key extends "${field.name.value}" ? ${gqlTypeToTsString(
              field.type,
              scalars,
              enums,
              isScalar(field.type, scalars) || isEnum(field.type, enums)
                ? undefined
                : partialize
            )} : `
        )
      )
      .concat([" never", ")"])
      .join("");

  const partialResolvers = types
    .map((node) =>
      [
        `    ${node.name.value}: {`,
        `        [Key in ${node.name.value}Key]:`,
        `            (${node.name.value}: ${partialize(node.name.value)}) =>`,
        `            ${toReturn(extenders(node))}`,
        "    };",
      ].join("\n")
    )
    .join("\n");

  return [`export type FieldsResolvers<${partialResolverConstraints}> = {`]
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
                )}) => ${toReturn(
                  gqlTypeToTsString(
                    field.type,
                    scalars,
                    enums,
                    isScalar(field.type, scalars) ? undefined : partialize
                  )
                )}`
            )
          )
          .concat(["    }"])
      : [];

  return [
    `export type QueriesAndMutationsResolvers<${partialResolverConstraints}> = {`,
  ]
    .concat(query)
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
        `const ${type.name.value} = new GraphQLObjectType({`,
        `    name: "${type.name.value}",`,
        "    fields: () => ({",
        ...(type.fields || []).flatMap((field) => [
          `        ${field.name.value}: {`,
          `            type: ${fieldTypeToSchemaType(
            field.type,
            scalars,
            enums
          )},`,
          `            resolve: "${field.name.value}" in fieldsConfiguration.${type.name.value} ? (source, args, context, info) => fieldsConfiguration.${type.name.value}.${field.name.value}(source) : undefined`,
          "        },",
        ]),
        "    })",
        "})",
      ])
    )
    .concat("")
    .concat(
      inputs.flatMap((input) => [
        `const ${input.name.value} = new GraphQLInputObjectType({`,
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
          }(${field.arguments && field.arguments.length > 0 ? "args" : ""})`,
          "            },",
        ])
      : [];

  return [
    "const schema = new GraphQLSchema({",
    "    assumeValid: true,",
    "    query: new GraphQLObjectType({",
    '        name: "Query",',
    "        fields: {",
    ...queryFields,
    "        },",
    "    }),",
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

  return [
    `export const server = <${partialResolverConstraints}>(fieldsConfiguration: FieldsResolvers<${resolversGenerics}>) => async ({ Query }: QueriesAndMutationsResolvers<${resolversGenerics}>) => {`,
    ...typesFromConfiguration(schema, scalars, enums).map(
      (line) => `    ${line}`
    ),
    "    Object.entries(fieldsConfiguration)",
    "",
    ...schemaFromConfiguration(schema, scalars, enums).map(
      (line) => `    ${line}`
    ),
    "",
    "    return async (request: IncomingMessage, response: ServerResponse<IncomingMessage>) => {",
    "        let body = ''",
    "",
    "        request.on('data', (chunk) => {",
    "            body += chunk.toString()",
    "        })",
    "",
    "        request.on('end', async () => {",
    "            const { query, variables } = JSON.parse(body)",
    "",
    "            const result = await graphql({",
    "                schema,",
    "                source: query,",
    "                variableValues: variables,",
    "            })",
    "",
    "            response.statusCode = 200",
    "            response.end(JSON.stringify(result))",
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
    queriesTypes(schema, scalars, enums),
    fieldsResolversType(schema, scalars, enums),
    queriesAndMutationsResolversType(schema, scalars, enums),
    server(schema, scalars, enums),
  ].join("\n\n");
};

export default schemaToServer;
