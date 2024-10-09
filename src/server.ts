import {
  DocumentNode,
  EnumTypeDefinitionNode,
  FieldDefinitionNode,
  Kind,
  ObjectTypeDefinitionNode,
  ScalarTypeDefinitionNode,
  TypeNode,
  buildASTSchema,
  printSchema,
} from "graphql";
import { GqlScalarToTs, ScalarType } from "./types.ts";
import {
  customScalarsImports,
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

const toReturn = (type: string) =>
  `Prettify<${type}> | Promise<Prettify<${type}>>`;

const partialize = (type: string) => `Omit<${type}, ${type}Key>`;

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

// Generators

const imports = () =>
  [
    'import { IncomingMessage, ServerResponse } from "http"',
    'import { buildSchema, graphql } from "graphql"',
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

  const extenders = (type: string) =>
    ["("]
      .concat(
        types.map(
          (node) =>
            `${type} extends ${node.name.value} ? ${partialize(
              node.name.value
            )} : NonNullable<${type}> extends ${node.name.value} ? ${partialize(
              node.name.value
            )} | null : ${type} extends Array<${
              node.name.value
            }> ? Array<${partialize(node.name.value)}> :`
        )
      )
      .concat([" never", ")"])
      .join(" ");

  const partialResolvers = types
    .map((node) =>
      [
        `    ${node.name.value}: {`,
        `        [Key in ${node.name.value}Key]:`,
        `            (${node.name.value}: Prettify<${partialize(
          node.name.value
        )}>) =>`,
        `            ${toReturn(extenders(`${node.name.value}[Key]`))}`,
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

const server = (schema: DocumentNode, enums: Array<EnumTypeDefinitionNode>) => {
  const partialResolverConstraints = fieldResolversContraint(schema, enums);
  const resolversGenerics = fieldResolversGenericSpread(schema, enums);

  return [
    `export const server = <${partialResolverConstraints}>(fieldsConfiguration: FieldsResolvers<${resolversGenerics}>) => async ({ Query }: QueriesAndMutationsResolvers<${resolversGenerics}>) => {`,
    `    const schema = buildSchema(\`${printSchema(
      buildASTSchema(schema)
    ).replaceAll("`", "\\`")}\`)`,
    "    ",
    "    return async (request: IncomingMessage, response: ServerResponse<IncomingMessage>) => {",
    "        let body = ''",
    "",
    "        request.on('data', (chunk) => {",
    "            body += chunk.toString()",
    "        })",
    "",
    "        request.on('end', async () => {",
    "            const result = await graphql({",
    "                schema,",
    "                source: body,",
    "                rootValue: Query",
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
    imports(),
    customScalarsImports(scalarTypes, customScalars),
    types(schema, scalars, enums),
    queriesTypes(schema, scalars, enums),
    fieldsResolversType(schema, scalars, enums),
    queriesAndMutationsResolversType(schema, scalars, enums),
    server(schema, enums),
  ].join("\n\n");
};

export default schemaToServer;
