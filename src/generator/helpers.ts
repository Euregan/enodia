import {
  DocumentNode,
  EnumTypeDefinitionNode,
  FieldDefinitionNode,
  InputObjectTypeDefinitionNode,
  InputValueDefinitionNode,
  Kind,
  ObjectTypeDefinitionNode,
  ScalarTypeDefinitionNode,
  TypeNode,
  UnionTypeDefinitionNode,
} from "graphql";
import { GqlScalarToTs, ScalarType } from "../types.ts";

// Helpers

export const baseScalars: Array<GqlScalarToTs> = [
  { gql: "Int", ts: "number" },
  { gql: "Float", ts: "number" },
  { gql: "String", ts: "string" },
  { gql: "Boolean", ts: "boolean" },
  { gql: "ID", ts: "string" },
];

export const getCustomScalars = (schema: DocumentNode) =>
  schema.definitions.filter(
    (node) => node.kind === Kind.SCALAR_TYPE_DEFINITION,
  ) as Array<ScalarTypeDefinitionNode>;

export const isEnum = (
  type: TypeNode | ObjectTypeDefinitionNode,
  enums: Array<EnumTypeDefinitionNode>,
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

export const isUnion = (
  type: TypeNode,
  unions: Array<UnionTypeDefinitionNode>,
): boolean => {
  switch (type.kind) {
    case Kind.NAMED_TYPE:
      return unions.some((union) => union.name.value === type.name.value);
    case Kind.LIST_TYPE:
    case Kind.NON_NULL_TYPE:
      return isUnion(type.type, unions);
  }
};

export const isScalar = (
  type: TypeNode,
  scalars: Array<GqlScalarToTs>,
): boolean => {
  switch (type.kind) {
    case Kind.NAMED_TYPE:
      return scalars.some(({ gql }) => gql === type.name.value);
    case Kind.LIST_TYPE:
    case Kind.NON_NULL_TYPE:
      return isScalar(type.type, scalars);
  }
};

export const isGqlTypeOptional = (type: TypeNode): boolean =>
  type.kind !== Kind.NON_NULL_TYPE;

export const gqlTypeToGqlString = (type: TypeNode): string => {
  switch (type.kind) {
    case Kind.NAMED_TYPE: {
      return type.name.value;
    }
    case Kind.LIST_TYPE:
      return `[${gqlTypeToGqlString(type.type)}]`;
    case Kind.NON_NULL_TYPE:
      return `${gqlTypeToGqlString(type.type)}!`;
  }
};

export const gqlTypeToTsName = (
  type: TypeNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
  suffix?: string,
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
      return gqlTypeToTsName(type.type, scalars, enums, suffix);
  }
};

export const gqlTypeToTsString = (
  {
    type,
    scalars,
    enums,
  }: {
    type: TypeNode;
    scalars: Array<GqlScalarToTs>;
    enums: Array<EnumTypeDefinitionNode>;
  },
  {
    suffix,
    optional = true,
    optionalAsUndefined = true,
  }: {
    suffix?: string;
    optional?: boolean;
    optionalAsUndefined?: boolean;
  } = {},
): string => {
  switch (type.kind) {
    case Kind.NAMED_TYPE:
      return `${gqlTypeToTsName(type, scalars, enums, suffix)}${
        optional && optionalAsUndefined ? " | undefined" : ""
      }`;
    case Kind.LIST_TYPE:
      return `Array<${gqlTypeToTsString(
        {
          type:
            type.type.kind === Kind.NON_NULL_TYPE ? type.type.type : type.type,
          scalars,
          enums,
        },
        { suffix, optional: false, optionalAsUndefined },
      )}>${optional && optionalAsUndefined ? " | undefined" : ""}`;
    case Kind.NON_NULL_TYPE:
      return gqlTypeToTsString(
        { type: type.type, scalars, enums },
        { suffix, optional: false, optionalAsUndefined },
      );
  }
};

export const fieldsConstraint = (
  type: TypeNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
  generic = "T",
) => `${generic} extends ${gqlTypeToTsName(type, scalars, enums)}Query[number]`;

export const queryResult = (
  type: TypeNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
) =>
  isScalar(type, scalars)
    ? gqlTypeToTsString({ type, scalars, enums })
    : `${gqlTypeToTsString(
        { type, scalars, enums },
        { suffix: "Result<T>", optionalAsUndefined: false },
      )}${type.kind !== Kind.NON_NULL_TYPE ? " | null" : ""}`;

export const argsToTsDeclaration = (
  args: ReadonlyArray<InputValueDefinitionNode>,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
  withProperty = true,
) =>
  `${
    withProperty
      ? `args${args.every((arg) => isGqlTypeOptional(arg.type)) ? "?" : ""}: `
      : ""
  }{ ${args
    .map(
      (arg) =>
        `${arg.name.value}${
          isGqlTypeOptional(arg.type) ? "?" : ""
        }: ${gqlTypeToTsName(arg.type, scalars, enums)}`,
    )
    .join(", ")} }`;

const getRootType = (schema: DocumentNode, name: "Query" | "Mutation") =>
  schema.definitions.find(
    (node) =>
      node.kind === Kind.OBJECT_TYPE_DEFINITION && node.name.value === name,
  ) as ObjectTypeDefinitionNode | undefined;

export const getQueries = (schema: DocumentNode) =>
  getRootType(schema, "Query");

export const getMutations = (schema: DocumentNode) =>
  getRootType(schema, "Mutation");

export const getEnums = (schema: DocumentNode) =>
  schema.definitions.filter(
    (node) => node.kind === Kind.ENUM_TYPE_DEFINITION,
  ) as Array<EnumTypeDefinitionNode>;

export const getUnions = (schema: DocumentNode) =>
  schema.definitions.filter(
    (node) => node.kind === Kind.UNION_TYPE_DEFINITION,
  ) as Array<UnionTypeDefinitionNode>;

export const getObjectTypes = (
  schema: DocumentNode,
  enums: Array<EnumTypeDefinitionNode>,
) =>
  schema.definitions.filter(
    (node) =>
      node.kind === Kind.OBJECT_TYPE_DEFINITION &&
      !["Query", "Mutation"].includes(node.name.value) &&
      !isEnum(node, enums),
  ) as Array<ObjectTypeDefinitionNode>;

export const resolveScalars = (
  schema: DocumentNode,
  scalarTypes: Record<string, ScalarType>,
) => {
  const customScalars = getCustomScalars(schema);

  const scalars: Array<GqlScalarToTs> = baseScalars.concat(
    customScalars.map((scalar) => {
      const type = scalarTypes[scalar.name.value];
      if (!type) {
        // TODO: Write a nicer, more detailed error, with steps to solve
        throw `No type for scalar ${scalar.name.value}.`;
      }
      return { gql: scalar.name.value, ts: type.name || scalar.name.value };
    }),
  );

  return {
    customScalars,
    scalars,
    enums: getEnums(schema),
    unions: getUnions(schema),
  };
};

// Generators

// TODO: Group imports from same file together
export const customScalarsImports = (
  scalarTypes: Record<string, ScalarType>,
  customScalars: Array<ScalarTypeDefinitionNode>,
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

export const types = (
  schema: DocumentNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
  unions: Array<UnionTypeDefinitionNode>,
) =>
  [
    "type Arguments = string | number | boolean | null | {",
    "    [K in string]: Arguments;",
    `} | Array<Arguments> | ${scalars.map((scalar) => scalar.ts).join(" | ")};`,
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
            !["Query", "Mutation"].includes(node.name.value),
        ) as Array<ObjectTypeDefinitionNode>
      ).map(
        (node) =>
          `  | ${node.name.value}${isEnum(node, enums) ? "" : "Query"}[number]`,
      ),
    )
    .concat(unions.map((node) => `  | ${node.name.value}Query[number]`))
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
      "type MergedUnion<T> = (T extends unknown ? (k: T) => void : never) extends ((k: infer I) => void) ? I : never;",
    ])
    .join("\n");

const fieldQuery = (
  field: FieldDefinitionNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
): string =>
  isScalar(field.type, scalars) || isEnum(field.type, enums)
    ? `'${field.name.value}'`
    : `{ ${field.name.value}: ${gqlTypeToTsName(
        field.type,
        scalars,
        enums,
        "Query",
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
                  }: ${gqlTypeToTsName(arg.type, scalars, enums)}`,
              )
              .join(", ")} }`
          : ""
      } }`;

export const queriesTypes = (
  schema: DocumentNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
  unions: Array<UnionTypeDefinitionNode>,
) => {
  const queries = (
    schema.definitions.filter(
      (node) =>
        node.kind === Kind.OBJECT_TYPE_DEFINITION &&
        // We don't expose these types
        !["Query", "Mutation"].includes(node.name.value),
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
            (field) => `  | ${fieldQuery(field, scalars, enums)}`,
          ),
        )
        .concat([">;"])
        .join("\n"),
    )
    .join("\n\n");

  const types = getObjectTypes(schema, enums)
    .map((node) =>
      [`type ${node.name.value} = {`]
        .concat(
          (node.fields || []).map(
            (field) =>
              `  ${field.name.value}: ${gqlTypeToTsString(
                {
                  type: field.type,
                  scalars,
                  enums,
                },
                { optionalAsUndefined: false },
              )}${field.type.kind !== Kind.NON_NULL_TYPE ? " | null" : ""}`,
          ),
        )
        .concat(["};"])
        .join("\n"),
    )
    .join("\n\n");

  const results = getObjectTypes(schema, enums)
    .map((node) =>
      [
        `type ${node.name.value}Result<T extends ${node.name.value}Query[number]> = Prettify<Omit<{`,
        "  [P in T extends string ? T : keyof T]:",
      ]
        .concat(
          (node.fields || [])
            .filter(
              (field) =>
                !isScalar(field.type, scalars) && !isEnum(field.type, enums),
            )
            .map(
              (field) =>
                `    P extends '${field.name.value}' ? T extends { ${
                  field.name.value
                }: ${gqlTypeToTsName(field.type, scalars, enums)}Query } ? ${
                  field.type.kind === Kind.LIST_TYPE ||
                  (field.type.kind === Kind.NON_NULL_TYPE &&
                    field.type.type.kind === Kind.LIST_TYPE)
                    ? "Array<"
                    : ""
                }${gqlTypeToTsName(field.type, scalars, enums)}Result<T['${
                  field.name.value
                }'][number]>${
                  field.type.kind === Kind.LIST_TYPE ||
                  (field.type.kind === Kind.NON_NULL_TYPE &&
                    field.type.type.kind === Kind.LIST_TYPE)
                    ? ">"
                    : ""
                } : never :`,
            ),
        )
        .concat([
          `    P extends keyof ${node.name.value} ? ${node.name.value}[P] : never`,
          "}, '$args'>>;",
        ])
        .join("\n"),
    )
    .join("\n\n");

  const inputs = (
    schema.definitions.filter(
      (node) => node.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION,
    ) as Array<InputObjectTypeDefinitionNode>
  )
    .map((node) =>
      [`export type ${node.name.value} = {`]
        .concat(
          (node.fields || []).map(
            (field) =>
              `  ${field.name.value}${
                isGqlTypeOptional(field.type) ? "?" : ""
              }: ${gqlTypeToTsString(
                { type: field.type, scalars, enums },
                { suffix: "", optional: false },
              )}`,
          ),
        )
        .concat(["};"])
        .join("\n"),
    )
    .join("\n\n");

  const enumerations = getEnums(schema)
    .map((node) =>
      [`export type ${node.name.value} = `]
        .concat(
          (node.values || []).map(
            (value, index, values) =>
              `  | '${value.name.value}'${
                index === values.length - 1 ? ";" : ""
              }`,
          ),
        )
        .join("\n"),
    )
    .join("\n\n");

  const unionQueries = unions
    .map(
      (node) =>
        `export type ${node.name.value}Query = Array<\n  | '__typename'\n  | { $on: { ${(
          node.types || []
        )
          .map((member) => `${member.name.value}?: ${member.name.value}Query`)
          .join(", ")} } }\n>;`,
    )
    .join("\n\n");

  const unionTypes = unions
    .map(
      (node) =>
        `export type ${node.name.value} = ${(node.types || [])
          .map((member) => member.name.value)
          .join(" | ")};`,
    )
    .join("\n\n");

  const unionResults = unions
    .map(
      (node) =>
        `type ${node.name.value}Result<T extends ${
          node.name.value
        }Query[number], WithTypename = '__typename' extends T ? true : false> =\n${(
          node.types || []
        )
          .map(
            (member) =>
              `  | (T extends { $on: { ${member.name.value}: Array<infer Q extends ${member.name.value}Query[number]> } } ? Prettify<${member.name.value}Result<Q> & (WithTypename extends true ? { __typename: '${member.name.value}' } : {})> : never)`,
          )
          .join("\n")};`,
    )
    .join("\n\n");

  return [
    queries,
    unionQueries,
    types,
    unionTypes,
    results,
    unionResults,
    inputs,
    enumerations,
  ]
    .filter(Boolean)
    .join("\n\n");
};
