import {
  DocumentNode,
  EnumTypeDefinitionNode,
  FieldDefinitionNode,
  InputObjectTypeDefinitionNode,
  InputValueDefinitionNode,
  InterfaceTypeDefinitionNode,
  Kind,
  ObjectTypeDefinitionNode,
  ScalarTypeDefinitionNode,
  TypeNode,
  UnionTypeDefinitionNode,
} from "graphql";
import { GqlScalarToTs, ScalarTypeInfo } from "../types.ts";

// Helpers

// Turns a GraphQL description into a JSDoc comment on the generated
// declaration, so editors surface the schema's own docs while writing or
// consuming generated code.
export const jsDoc = (
  description: string | null | undefined,
  indent = "",
): string => {
  if (!description) return "";
  const lines = description.split("\n");
  return lines.length === 1
    ? `${indent}/** ${lines[0]} */\n`
    : `${indent}/**\n${lines
        .map((line) => `${indent} * ${line}`)
        .join("\n")}\n${indent} */\n`;
};

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

export const isListType = (type: TypeNode): boolean =>
  type.kind === Kind.LIST_TYPE ||
  (type.kind === Kind.NON_NULL_TYPE && type.type.kind === Kind.LIST_TYPE);

export const baseName = (type: TypeNode): string =>
  type.kind === Kind.NAMED_TYPE ? type.name.value : baseName(type.type);

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
        { suffix: "Result$<T>", optionalAsUndefined: false },
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
        }: ${gqlTypeToTsString(
          { type: arg.type, scalars, enums },
          { optionalAsUndefined: false },
        )}`,
    )
    .join(", ")} }`;

const getRootType = (schema: DocumentNode, name: "Query" | "Mutation" | "Subscription") =>
  schema.definitions.find(
    (node) =>
      node.kind === Kind.OBJECT_TYPE_DEFINITION && node.name.value === name,
  ) as ObjectTypeDefinitionNode | undefined;

export const getQueries = (schema: DocumentNode) =>
  getRootType(schema, "Query");

export const getMutations = (schema: DocumentNode) =>
  getRootType(schema, "Mutation");

export const getSubscriptions = (schema: DocumentNode) =>
  getRootType(schema, "Subscription");

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
      !["Query", "Mutation", "Subscription"].includes(node.name.value) &&
      !isEnum(node, enums),
  ) as Array<ObjectTypeDefinitionNode>;

export const getInterfaces = (schema: DocumentNode) =>
  schema.definitions.filter(
    (node) => node.kind === Kind.INTERFACE_TYPE_DEFINITION,
  ) as Array<InterfaceTypeDefinitionNode>;

// The concrete object types a `... on Member` fragment ($on) can select on
// for a given interface, i.e. the types declaring `implements InterfaceName`.
const implementersOf = (
  schema: DocumentNode,
  enums: Array<EnumTypeDefinitionNode>,
  interfaceName: string,
) =>
  getObjectTypes(schema, enums).filter((node) =>
    (node.interfaces || []).some((i) => i.name.value === interfaceName),
  );

export const getInputTypes = (schema: DocumentNode) =>
  schema.definitions.filter(
    (node) => node.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION,
  ) as Array<InputObjectTypeDefinitionNode>;

export const resolveScalars = (
  schema: DocumentNode,
  scalarTypes: Record<string, ScalarTypeInfo>,
) => {
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
        ts: type.type,
        encode: type.encode,
        decode: type.decode,
      };
    }),
  );

  return {
    customScalars,
    scalars,
    enums: getEnums(schema),
    unions: getUnions(schema),
  };
};

export const types = (
  schema: DocumentNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
  unions: Array<UnionTypeDefinitionNode>,
) =>
  [
    "type Arguments$ = string | number | boolean | null | {",
    "    [K in string]: Arguments$;",
    `} | Array<Arguments$> | ${scalars.map((scalar) => scalar.ts).join(" | ")};`,
    "",
    "type ArgumentTypes$ = Record<string, string>;",
    "",
    "type Query = Prettify$<",
  ]
    .concat(
      (
        schema.definitions.filter(
          (node) =>
            node.kind === Kind.OBJECT_TYPE_DEFINITION &&
            // We don't expose these types
            !["Query", "Mutation", "Subscription"].includes(node.name.value),
        ) as Array<ObjectTypeDefinitionNode>
      ).map(
        (node) =>
          `  | ${node.name.value}${isEnum(node, enums) ? "" : "Query"}[number]`,
      ),
    )
    .concat(unions.map((node) => `  | ${node.name.value}Query[number]`))
    .concat(
      getInterfaces(schema).map((node) => `  | ${node.name.value}Query[number]`),
    )
    .concat([
      ">;",
      "",
      "type Fields$ = null | Array<Query>;",
      "",
      "type Prettify$<T> = {",
      "  [K in keyof T]: T[K];",
      "} & unknown;",
      "",
      "type MergedUnion$<T> = (T extends unknown ? (k: T) => void : never) extends ((k: infer I) => void) ? I : never;",
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
                  }: ${gqlTypeToTsString(
                    { type: arg.type, scalars, enums },
                    { optionalAsUndefined: false },
                  )}`,
              )
              .join(", ")} }`
          : ""
      } }`;

// The `[P in T extends string ? T : keyof T]: ...` branches shared by object
// and interface `Result$` types: one ternary per non-scalar/enum field,
// resolving to that field's own `Result$`.
const resultFieldBranches = (
  fields: ReadonlyArray<FieldDefinitionNode>,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
) =>
  fields
    .filter((field) => !isScalar(field.type, scalars) && !isEnum(field.type, enums))
    .map(
      (field) =>
        `    P extends '${field.name.value}' ? T extends { ${
          field.name.value
        }: ${gqlTypeToTsName(field.type, scalars, enums)}Query } ? ${
          isListType(field.type) ? "Array<" : ""
        }${gqlTypeToTsName(field.type, scalars, enums)}Result$<T['${
          field.name.value
        }'][number]>${isListType(field.type) ? ">" : ""} : never :`,
    );

export const queriesTypes = (
  schema: DocumentNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
  unions: Array<UnionTypeDefinitionNode>,
) => {
  const interfaces = getInterfaces(schema);

  const queries = (
    schema.definitions.filter(
      (node) =>
        node.kind === Kind.OBJECT_TYPE_DEFINITION &&
        // We don't expose these types
        !["Query", "Mutation", "Subscription"].includes(node.name.value),
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
      [`${jsDoc(node.description?.value)}type ${node.name.value} = {`]
        .concat(
          (node.fields || []).map(
            (field) =>
              `${jsDoc(field.description?.value, "  ")}  ${field.name.value}: ${gqlTypeToTsString(
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
        `type ${node.name.value}Result$<T extends ${node.name.value}Query[number]> = Prettify$<Omit<{`,
        "  [P in T extends string ? T : keyof T]:",
      ]
        .concat(resultFieldBranches(node.fields || [], scalars, enums))
        .concat([
          `    P extends keyof ${node.name.value} ? ${node.name.value}[P] : never`,
          "}, '$args'>>;",
        ])
        .join("\n"),
    )
    .join("\n\n");

  // An interface field is queried like an object (its own fields, directly),
  // plus one extra `$on` entry for `... on Member` fragments - same shape
  // unions already use for their (fields-less) `$on`-only selections.
  const interfaceQueries = interfaces
    .map((node) => {
      const members = implementersOf(schema, enums, node.name.value);
      return [`export type ${node.name.value}Query = Array<`]
        .concat(
          (node.fields || []).map(
            (field) => `  | ${fieldQuery(field, scalars, enums)}`,
          ),
        )
        .concat(
          members.length > 0
            ? [
                `  | { $on: { ${members
                  .map(
                    (member) => `${member.name.value}?: ${member.name.value}Query`,
                  )
                  .join(", ")} } }`,
              ]
            : [],
        )
        .concat([">;"])
        .join("\n");
    })
    .join("\n\n");

  const interfaceTypes = interfaces
    .map((node) =>
      [`${jsDoc(node.description?.value)}type ${node.name.value} = {`]
        .concat(
          (node.fields || []).map(
            (field) =>
              `${jsDoc(field.description?.value, "  ")}  ${field.name.value}: ${gqlTypeToTsString(
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

  // The own fields resolve exactly like an object's `Result$`; a selected
  // `$on` fragment additionally merges in whichever member was requested
  // (same per-member conditional as `unionResults`, guarded so omitting
  // `$on` entirely still resolves to just the own-fields shape).
  const interfaceResults = interfaces
    .map((node) => {
      const members = implementersOf(schema, enums, node.name.value);
      return (
        [
          `type ${node.name.value}Result$<T extends ${node.name.value}Query[number]> = Prettify$<Omit<{`,
          "  [P in T extends string ? T : keyof T]:",
        ]
          .concat(resultFieldBranches(node.fields || [], scalars, enums))
          .concat([
            `    P extends keyof ${node.name.value} ? ${node.name.value}[P] : never`,
            members.length > 0
              ? "}, '$args' | '$on'>> & (T extends { $on: unknown } ? ("
              : "}, '$args'>>;",
          ])
          .concat(
            members.length > 0
              ? members.map(
                  (member) =>
                    `  | (T extends { $on: { ${member.name.value}: Array<infer Q extends ${member.name.value}Query[number]> } } ? Prettify$<${member.name.value}Result$<Q>> : never)`,
                )
              : [],
          )
          .concat(members.length > 0 ? [") : {});"] : [])
          .join("\n")
      );
    })
    .join("\n\n");

  const inputs = (
    schema.definitions.filter(
      (node) => node.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION,
    ) as Array<InputObjectTypeDefinitionNode>
  )
    .map((node) =>
      [`${jsDoc(node.description?.value)}export type ${node.name.value} = {`]
        .concat(
          (node.fields || []).map(
            (field) =>
              `${jsDoc(field.description?.value, "  ")}  ${field.name.value}${
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
      [`${jsDoc(node.description?.value)}export type ${node.name.value} = `]
        .concat(
          (node.values || []).map(
            (value, index, values) =>
              `${jsDoc(value.description?.value, "  ")}  | '${value.name.value}'${
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
        `${jsDoc(node.description?.value)}export type ${node.name.value} = ${(
          node.types || []
        )
          .map((member) => member.name.value)
          .join(" | ")};`,
    )
    .join("\n\n");

  const unionResults = unions
    .map(
      (node) =>
        `type ${node.name.value}Result$<T extends ${
          node.name.value
        }Query[number], WithTypename = '__typename' extends T ? true : false> =\n${(
          node.types || []
        )
          .map(
            (member) =>
              `  | (T extends { $on: { ${member.name.value}: Array<infer Q extends ${member.name.value}Query[number]> } } ? Prettify$<${member.name.value}Result$<Q> & (WithTypename extends true ? { __typename: '${member.name.value}' } : {})> : never)`,
          )
          .join("\n")};`,
    )
    .join("\n\n");

  return [
    queries,
    unionQueries,
    interfaceQueries,
    types,
    unionTypes,
    interfaceTypes,
    results,
    unionResults,
    interfaceResults,
    inputs,
    enumerations,
  ]
    .filter(Boolean)
    .join("\n\n");
};
