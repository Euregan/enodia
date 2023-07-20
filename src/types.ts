import {
  Kind,
  DefinitionNode,
  FieldDefinitionNode,
  TypeNode,
  DocumentNode,
} from "graphql";
import ts, {
  TypeReferenceNode,
  ArrayTypeNode,
  PropertySignature,
  SyntaxKind,
} from "typescript";

const gqlTypeToTsDeclaration = (
  type: TypeNode
): TypeReferenceNode | ArrayTypeNode => {
  switch (type.kind) {
    case Kind.NAMED_TYPE:
      return ts.factory.createTypeReferenceNode(type.name.value);
    case Kind.LIST_TYPE:
      return ts.factory.createArrayTypeNode(gqlTypeToTsDeclaration(type.type));
    case Kind.NON_NULL_TYPE:
      return gqlTypeToTsDeclaration(type.type);
  }
};

const gqlFieldDefinitionToTsDeclaration = (
  node: FieldDefinitionNode
): PropertySignature =>
  ts.factory.createPropertySignature(
    undefined,
    node.name.value,
    undefined,
    gqlTypeToTsDeclaration(node.type)
  );

const gqlDefinitionToTsDeclaration = (node: DefinitionNode) => {
  switch (node.kind) {
    case Kind.OBJECT_TYPE_DEFINITION:
      return ts.factory.createInterfaceDeclaration(
        // We don't expose these types
        ["Query", "Mutation"].includes(node.name.value)
          ? []
          : [ts.factory.createModifier(SyntaxKind.ExportKeyword)],
        node.name.value,
        undefined,
        undefined,
        (node.fields || []).map(gqlFieldDefinitionToTsDeclaration)
      );
    case Kind.OPERATION_DEFINITION:
    case Kind.FRAGMENT_DEFINITION:
    case Kind.SCHEMA_DEFINITION:
    case Kind.SCALAR_TYPE_DEFINITION:
    case Kind.INTERFACE_TYPE_DEFINITION:
    case Kind.UNION_TYPE_DEFINITION:
    case Kind.ENUM_TYPE_DEFINITION:
    case Kind.INPUT_OBJECT_TYPE_DEFINITION:
    case Kind.DIRECTIVE_DEFINITION:
    case Kind.SCHEMA_EXTENSION:
    case Kind.SCALAR_TYPE_EXTENSION:
    case Kind.OBJECT_TYPE_EXTENSION:
    case Kind.INTERFACE_TYPE_EXTENSION:
    case Kind.UNION_TYPE_EXTENSION:
    case Kind.ENUM_TYPE_EXTENSION:
    case Kind.INPUT_OBJECT_TYPE_EXTENSION:
      return ts.factory.createThrowStatement(
        ts.factory.createStringLiteral(
          `Node type ${node.kind} is not supported yet`
        )
      );
  }
};

export const schemaToTypes = (schema: DocumentNode) =>
  ts.factory.createNodeArray(
    schema.definitions.map(gqlDefinitionToTsDeclaration),
    false
  );
