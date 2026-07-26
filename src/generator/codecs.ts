import {
  DocumentNode,
  EnumTypeDefinitionNode,
  InputObjectTypeDefinitionNode,
  ObjectTypeDefinitionNode,
  UnionTypeDefinitionNode,
} from "graphql";
import { GqlScalarToTs } from "../types.ts";
import { baseName, getInputTypes, getObjectTypes } from "./helpers.ts";

export const hasCodecs = (scalars: Array<GqlScalarToTs>): boolean =>
  scalars.some((scalar) => scalar.encode || scalar.decode);

const relevantTypes = (
  types: Array<{ name: string; fieldBases: Array<string> }>,
  scalars: Set<string>,
  unionMembers: Map<string, Array<string>>,
): Set<string> => {
  const relevant = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const type of types) {
      if (relevant.has(type.name)) {
        continue;
      }
      const leadsToCodec = type.fieldBases.some(
        (base) =>
          scalars.has(base) ||
          relevant.has(base) ||
          (unionMembers.get(base) || []).some((member) => relevant.has(member)),
      );
      if (leadsToCodec) {
        relevant.add(type.name);
        changed = true;
      }
    }
  }
  return relevant;
};

const objectMap = (
  objectTypes: Array<ObjectTypeDefinitionNode>,
  relevant: Set<string>,
  decodeScalars: Set<string>,
  unionMembers: Map<string, Array<string>>,
): Array<string> =>
  objectTypes
    .filter((type) => relevant.has(type.name.value))
    .flatMap((type) => {
      const fields = (type.fields || []).flatMap((field) => {
        const base = baseName(field.type);
        if (decodeScalars.has(base)) {
          return [`${field.name.value}: 'scalar:${base}'`];
        }
        if (
          relevant.has(base) ||
          (unionMembers.get(base) || []).some((member) => relevant.has(member))
        ) {
          return [`${field.name.value}: 'object:${base}'`];
        }
        return [];
      });
      return fields.length > 0
        ? [`  ${type.name.value}: { ${fields.join(", ")} },`]
        : [];
    });

const inputMap = (
  inputTypes: Array<InputObjectTypeDefinitionNode>,
  relevant: Set<string>,
  encodeScalars: Set<string>,
): Array<string> =>
  inputTypes
    .filter((type) => relevant.has(type.name.value))
    .flatMap((type) => {
      const fields = (type.fields || []).flatMap((field) => {
        const base = baseName(field.type);
        return encodeScalars.has(base) || relevant.has(base)
          ? [`${field.name.value}: '${base}'`]
          : [];
      });
      return fields.length > 0
        ? [`  ${type.name.value}: { ${fields.join(", ")} },`]
        : [];
    });

const walkers = [
  "const decodeScalar = (scalar: string, value: any): any =>",
  "  value == null",
  "    ? value",
  "    : Array.isArray(value)",
  "      ? value.map((item) => decodeScalar(scalar, item))",
  "      : scalarCodecs[scalar].decode!(value);",
  "",
  "const decodeResult = (typeName: string, value: any): any => {",
  "  if (value == null) return value;",
  "  if (Array.isArray(value)) return value.map((item) => decodeResult(typeName, item));",
  "  const type = value.__typename && decoderFields[value.__typename] ? value.__typename : typeName;",
  "  const fields = decoderFields[type];",
  "  if (!fields) return value;",
  "  for (const key of Object.keys(fields)) {",
  "    if (!(key in value)) continue;",
  "    const [kind, name] = fields[key].split(':');",
  "    value[key] = kind === 'scalar' ? decodeScalar(name, value[key]) : decodeResult(name, value[key]);",
  "  }",
  "  return value;",
  "};",
  "",
  "const encodeValue = (typeName: string, value: any): any => {",
  "  if (value == null) return value;",
  "  if (Array.isArray(value)) return value.map((item) => encodeValue(typeName, item));",
  "  if (scalarCodecs[typeName] && scalarCodecs[typeName].encode) return scalarCodecs[typeName].encode!(value);",
  "  const fields = encoderFields[typeName];",
  "  if (!fields) return value;",
  "  const encoded: Record<string, any> = { ...value };",
  "  for (const key of Object.keys(fields)) {",
  "    if (key in encoded) encoded[key] = encodeValue(fields[key], encoded[key]);",
  "  }",
  "  return encoded;",
  "};",
  "",
  "const encodeArguments = (",
  "  args: Record<string, any> | undefined,",
  "  argTypes: Record<string, string> | undefined,",
  ") => {",
  "  if (!args || !argTypes) return args;",
  "  const encoded: Record<string, any> = {};",
  "  for (const key of Object.keys(args)) {",
  "    encoded[key] = argTypes[key] ? encodeValue(argTypes[key].replace(/[\\[\\]!]/g, ''), args[key]) : args[key];",
  "  }",
  "  return encoded;",
  "};",
].join("\n");

// Client-only: the server relies on graphql-js to apply the codecs through each
// scalar's serialize/parseValue, so it needs none of these maps or walkers.
export const clientCodecRuntime = (
  schema: DocumentNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>,
  unions: Array<UnionTypeDefinitionNode>,
): string => {
  const withCodec = scalars.filter((scalar) => scalar.encode || scalar.decode);
  if (withCodec.length === 0) {
    return "";
  }

  const decodeScalars = new Set(
    scalars.filter((scalar) => scalar.decode).map((scalar) => scalar.gql),
  );
  const encodeScalars = new Set(
    scalars.filter((scalar) => scalar.encode).map((scalar) => scalar.gql),
  );

  const objectTypes = getObjectTypes(schema, enums);
  const inputTypes = getInputTypes(schema);
  const unionMembers = new Map(
    unions.map((union) => [
      union.name.value,
      (union.types || []).map((member) => member.name.value),
    ]),
  );

  const decodeRelevant = relevantTypes(
    objectTypes.map((type) => ({
      name: type.name.value,
      fieldBases: (type.fields || []).map((field) => baseName(field.type)),
    })),
    decodeScalars,
    unionMembers,
  );
  const encodeRelevant = relevantTypes(
    inputTypes.map((type) => ({
      name: type.name.value,
      fieldBases: (type.fields || []).map((field) => baseName(field.type)),
    })),
    encodeScalars,
    new Map(),
  );

  return [
    "const scalarCodecs: Record<string, { encode?: (value: any) => any; decode?: (value: any) => any }> = {",
    ...withCodec.map(
      (scalar) =>
        `  ${scalar.gql}: { ${[
          scalar.encode ? `encode: ${scalar.encode}` : null,
          scalar.decode ? `decode: ${scalar.decode}` : null,
        ]
          .filter(Boolean)
          .join(", ")} },`,
    ),
    "};",
    "",
    "const decoderFields: Record<string, Record<string, string>> = {",
    ...objectMap(objectTypes, decodeRelevant, decodeScalars, unionMembers),
    "};",
    "",
    "const encoderFields: Record<string, Record<string, string>> = {",
    ...inputMap(inputTypes, encodeRelevant, encodeScalars),
    "};",
    "",
    walkers,
  ].join("\n");
};
