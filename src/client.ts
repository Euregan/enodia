import {
  Kind,
  DocumentNode,
  ObjectTypeDefinitionNode,
  TypeNode,
  FieldDefinitionNode,
} from "graphql";
import ts, {
  PropertyAssignment,
  SyntaxKind,
  LiteralTypeNode,
  TypeLiteralNode,
} from "typescript";
import {
  createArrowFunction,
  createCallExpression,
  createObjectLiteralExpression,
  createParameterDeclaration,
  createVariableDeclaration,
} from "./helpers.ts";

const gqlTypeToString = (type: TypeNode): string => {
  switch (type.kind) {
    case Kind.NAMED_TYPE:
      return type.name.value;
    case Kind.LIST_TYPE:
    case Kind.NON_NULL_TYPE:
      return gqlTypeToString(type.type);
  }
};

const gqlQueriesToTsFunctionDefinitions = (
  queries: ObjectTypeDefinitionNode
): Array<PropertyAssignment> =>
  (queries.fields || []).map((field) =>
    ts.factory.createPropertyAssignment(
      field.name.value,
      ts.factory.createArrowFunction(
        undefined,
        undefined,
        [
          ts.factory.createParameterDeclaration(
            undefined,
            undefined,
            "query",
            undefined,
            ts.factory.createTypeReferenceNode(
              `${gqlTypeToString(field.type)}Query`
            )
          ),
        ],
        undefined,
        undefined,
        ts.factory.createCallExpression(
          ts.factory.createIdentifier("call"),
          undefined,
          [
            ts.factory.createIdentifier("graphqlServerUrl"),
            ts.factory.createStringLiteral(field.name.value),
            ts.factory.createIdentifier("query"),
          ]
        )
      )
    )
  );

const gqlTypeToTsLiteralNode = (
  type: TypeNode,
  name: string
): LiteralTypeNode | TypeLiteralNode => {
  switch (type.kind) {
    case Kind.NAMED_TYPE:
      switch (type.name.value) {
        case "String":
        case "Int":
        case "Float":
        case "Boolean":
        case "ID":
        // TODO: These two are hardcoded for now, but will need to be parsed from the schema
        case "Date":
        case "Url":
          return ts.factory.createLiteralTypeNode(
            ts.factory.createStringLiteral(name)
          );
        default:
          // TODO: We need to fuse the object declarations in one object with optional properties
          return ts.factory.createTypeLiteralNode([
            ts.factory.createPropertySignature(
              undefined,
              ts.factory.createIdentifier(name),
              undefined,
              ts.factory.createTypeReferenceNode(`${type.name.value}Query`)
            ),
          ]);
      }
    case Kind.LIST_TYPE:
    case Kind.NON_NULL_TYPE:
      return gqlTypeToTsLiteralNode(type.type, name);
  }
};

const gqlFieldToTsLiteralNode = (field: FieldDefinitionNode) =>
  gqlTypeToTsLiteralNode(field.type, field.name.value);

const gqlDefinitionsToTsDeclarations = (schema: DocumentNode) =>
  (
    schema.definitions.filter(
      (node) =>
        node.kind === Kind.OBJECT_TYPE_DEFINITION &&
        // We don't expose these types
        !["Query", "Mutation"].includes(node.name.value)
    ) as Array<ObjectTypeDefinitionNode>
  ).map((node) =>
    ts.factory.createTypeAliasDeclaration(
      [ts.factory.createModifier(SyntaxKind.ExportKeyword)],
      ts.factory.createIdentifier(`${node.name.value}Query`),
      undefined,
      ts.factory.createArrayTypeNode(
        ts.factory.createUnionTypeNode(
          (node.fields || []).map(gqlFieldToTsLiteralNode)
        )
      )
    )
  );

const declareFieldsType = () =>
  ts.factory.createTypeAliasDeclaration(
    undefined,
    ts.factory.createIdentifier("Fields"),
    undefined,
    ts.factory.createArrayTypeNode(
      ts.factory.createUnionTypeNode([
        ts.factory.createTypeReferenceNode("string"),
        ts.factory.createTypeReferenceNode("Record", [
          ts.factory.createTypeReferenceNode("string"),
          ts.factory.createTypeReferenceNode("Fields"),
        ]),
      ])
    )
  );

const declareCallFunction = () =>
  createVariableDeclaration(
    "call",
    createArrowFunction(
      [
        createParameterDeclaration("graphqlServerUrl", "string"),
        createParameterDeclaration("query", "string"),
        createParameterDeclaration("returns", "Fields"),
      ],

      ts.factory.createCallChain(
        ts.factory.createPropertyAccessChain(
          createCallExpression("fetch", [
            "graphqlServerUrl",
            createObjectLiteralExpression({
              method: "POST",
              body: createCallExpression("JSON.stringify", [
                createObjectLiteralExpression({
                  operationName: ts.factory.createIdentifier("query"),
                  query: ts.factory.createTemplateExpression(
                    ts.factory.createTemplateHead("query "),
                    [
                      ts.factory.createTemplateSpan(
                        ts.factory.createIdentifier("query"),
                        ts.factory.createTemplateMiddle(" {\n ")
                      ),
                      ts.factory.createTemplateSpan(
                        ts.factory.createIdentifier("query"),
                        ts.factory.createTemplateMiddle(" {\n ")
                      ),
                      ts.factory.createTemplateSpan(
                        createCallExpression("listFields", [
                          ts.factory.createIdentifier("returns"),
                        ]),
                        ts.factory.createTemplateTail(" } }")
                      ),
                    ]
                  ),
                }),
              ]),
              headers: {
                "Content-Type": "application/json",
              },
            }),
          ]),
          undefined,
          "then"
        ),
        undefined,
        [],
        [
          createArrowFunction(
            [createParameterDeclaration("response", "Response")],
            createCallExpression(
              ts.factory.createPropertyAccessExpression(
                ts.factory.createIdentifier("response"),
                "json"
              ),
              []
            )
          ),
        ]
      )
    )
  );

export const schemaToClient = (schema: DocumentNode) => {
  const queries = schema.definitions.find(
    (node) =>
      node.kind === Kind.OBJECT_TYPE_DEFINITION && node.name.value === "Query"
  ) as ObjectTypeDefinitionNode | undefined;
  const mutations = schema.definitions.find(
    (node) =>
      node.kind === Kind.OBJECT_TYPE_DEFINITION &&
      node.name.value === "Mutation"
  ) as ObjectTypeDefinitionNode | undefined;

  return ts.factory.createNodeArray([
    declareFieldsType(),
    declareCallFunction(),
    ...gqlDefinitionsToTsDeclarations(schema),
    ts.factory.createExportDefault(
      createArrowFunction(
        [createParameterDeclaration("graphqlServerUrl", "string")],
        ts.factory.createObjectLiteralExpression(
          (queries
            ? [
                ts.factory.createPropertyAssignment(
                  "query",
                  ts.factory.createObjectLiteralExpression(
                    gqlQueriesToTsFunctionDefinitions(queries),
                    true
                  )
                ),
              ]
            : []
          ).concat(
            mutations
              ? ts.factory.createPropertyAssignment(
                  "mutate",
                  createArrowFunction([], createObjectLiteralExpression({}))
                )
              : []
          ),
          true
        )
      )
    ),
  ]);
};
