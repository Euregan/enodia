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
): boolean =>
  "name" in type && enums.some((e) => e.name.value === type.name.value);

const isScalar = (type: TypeNode, scalars: Array<GqlScalarToTs>): boolean => {
  switch (type.kind) {
    case Kind.NAMED_TYPE:
      return scalars.some(({ gql }) => gql === type.name.value);
    case Kind.LIST_TYPE:
      return false;
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

const types = () =>
  [
    "type Arguments = string | number | boolean | null | {",
    "    [K in string]: Arguments;",
    "} | Array<Arguments>;",
    "",
    "type ArgumentTypes = Record<string, string>;",
    "",
    "type Fields = null | (string | ({",
    "    $args?: Arguments;",
    "} & Record<string, Fields>))[];",
  ].join("\n");

const fieldsToQuery = () =>
  [
    "const fieldsToQuery = (query: Fields): string => {",
    "    if (query === null) {",
    "        return '';",
    "    }",
    "",
    "    const scalars = query.filter(field => typeof field === 'string') as Array<string>;",
    "    const objects = query.filter(field => typeof field !== 'string') as Array<Record<string, Fields>>;",
    "",
    "    return `{${scalars.join('\\n')}\\n${objects.map(object => Object.entries(object).map(([key, value]) => `${key} ${fieldsToQuery(value)}`)).join('\\n')}\\n}`;",
    "}",
  ].join("\n");

const argsToGql = () =>
  [
    "const argsToGql = (argTypes: ArgumentTypes, args: Record<string, Arguments>) =>",
    "  Object.keys(args)",
    "    .map((key) => `$${key}: ${argTypes[key]}`)",
    "    .join('\\n');",
  ].join("\n");

const variablesToArgs = () =>
  [
    "const variablesToArgs = (args: Record<string, Arguments>) =>",
    "  Object.keys(args)",
    "    .map((key) => `${key}: $${key}`)",
    "    .join('\\n');",
  ].join("\n");

const call = () =>
  [
    "const call = (",
    "  graphqlServerUrl: string,",
    "  query: string,",
    "  returns: Fields,",
    "  args?: Record<string, Arguments>,",
    "  argTypes?: ArgumentTypes",
    ") =>",
    "  fetch(graphqlServerUrl, {",
    "    method: 'POST',",
    "    body: JSON.stringify({",
    "      operationName: query,",
    "      query: `query ${query}${",
    "        argTypes && args ? `(${argsToGql(argTypes, args)})` : ''",
    "      } {\\n ${query}${",
    "        args ? `(${variablesToArgs(args)})` : ''",
    "      }\\n ${fieldsToQuery(returns)} }`,",
    "      variables: args,",
    "    }),",
    "    headers: {",
    "      'Content-Type': 'application/json',",
    "    },",
    "  }).then((response: Response) => response.json());",
  ].join("\n");

const fieldQuery = (
  type: TypeNode,
  name: string,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>
): string => {
  switch (type.kind) {
    case Kind.NAMED_TYPE:
      return isScalar(type, scalars) || isEnum(type, enums)
        ? `'${name}'`
        : `{ ${name}: ${type.name.value}Query }`;
    case Kind.LIST_TYPE:
    case Kind.NON_NULL_TYPE:
      return fieldQuery(type.type, name, scalars, enums);
  }
};

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
  const types = (
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
        // TODO: Handle args at the field level
        .concat(
          (node.fields || []).map(
            (field) =>
              `  | ${fieldQuery(field.type, field.name.value, scalars, enums)}`
          )
        )
        .concat([">;"])
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

  return [types, inputs, enumerations].join("\n\n");
};

const queryFunctionParameters = (
  field: FieldDefinitionNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>
) =>
  [
    !isScalar(field.type, scalars)
      ? `query: ${typeToString(field.type, scalars, enums, "Query")}`
      : null,
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

const queryFunctions = (
  queries: ObjectTypeDefinitionNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>
): string =>
  (queries.fields || [])
    .map((field) =>
      [
        `    ${field.name.value}: (${queryFunctionParameters(
          field,
          scalars,
          enums
        )}) => call(graphqlServerUrl, '${field.name.value}', ${
          !isScalar(field.type, scalars) ? "query" : "null"
        }${
          field.arguments && field.arguments.length > 0
            ? `, args, { ${gqlArgTypes(field.arguments)} }`
            : ""
        }),`,
        // TODO: Add the dynamic return type
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
    [`const enodia = (graphqlServerUrl: string) => ({`]
      .concat(
        queries
          ? ["  query: {", queryFunctions(queries, scalars, enums), "  }"]
          : []
      )
      // TODO: Handle mutations as well
      .concat(mutations ? [] : [])
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
    types(),
    fieldsToQuery(),
    argsToGql(),
    variablesToArgs(),
    call(),
    queriesTypes(schema, scalars, enums),
    client(schema, scalars, enums),
  ].join("\n\n");
};

export default schemaToClient;
