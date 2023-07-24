import {
  Kind,
  DocumentNode,
  ObjectTypeDefinitionNode,
  TypeNode,
  FieldDefinitionNode,
  InputValueDefinitionNode,
  InputObjectTypeDefinitionNode,
} from "graphql";
import ts, {
  PropertyAssignment,
  SyntaxKind,
  LiteralTypeNode,
  TypeLiteralNode,
  Expression,
} from "typescript";
import {
  createArrowFunction,
  createCallExpression,
  createObjectLiteralExpression,
  createParameterDeclaration,
  createVariableDeclaration,
} from "./helpers.ts";

const isGqlTypeOptional = (type: TypeNode): boolean =>
  type.kind !== Kind.NON_NULL_TYPE;

const gqlTypeToTsString = (type: TypeNode, scalars: GqlScalarToTs): string => {
  switch (type.kind) {
    case Kind.NAMED_TYPE: {
      const tsType = scalars.find(({ gql }) => gql === type.name.value);
      return tsType ? tsType.ts : type.name.value;
    }
    case Kind.LIST_TYPE:
    case Kind.NON_NULL_TYPE:
      return gqlTypeToTsString(type.type, scalars);
  }
};

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

const gqlArgumentsToTsParameterDeclaration = (
  args: readonly InputValueDefinitionNode[],
  scalars: GqlScalarToTs
) => [
  createParameterDeclaration(
    "args",
    ts.factory.createTypeLiteralNode(
      args.map((arg) =>
        ts.factory.createPropertySignature(
          undefined,
          arg.name.value,
          isGqlTypeOptional(arg.type)
            ? ts.factory.createToken(SyntaxKind.QuestionToken)
            : undefined,
          ts.factory.createTypeReferenceNode(
            gqlTypeToTsString(arg.type, scalars)
          )
        )
      )
    ),
    args.every((arg) => isGqlTypeOptional(arg.type))
  ),
];

const gqlArgumentsToTsArgumentTypesDeclaration = (
  args: readonly InputValueDefinitionNode[]
) =>
  createObjectLiteralExpression(
    Object.fromEntries(
      args.map((node) => [node.name.value, gqlTypeToString(node.type)])
    )
  );

const gqlQueriesToTsFunctionDefinitions = (
  queries: ObjectTypeDefinitionNode,
  scalars: GqlScalarToTs
): Array<PropertyAssignment> =>
  (queries.fields || []).map((field) =>
    ts.factory.createPropertyAssignment(
      field.name.value,
      createArrowFunction(
        [
          createParameterDeclaration(
            "query",
            `${gqlTypeToTsString(field.type, scalars)}Query`
          ),
        ].concat(
          field.arguments && field.arguments.length > 0
            ? gqlArgumentsToTsParameterDeclaration(field.arguments, scalars)
            : []
        ),
        createCallExpression(
          ts.factory.createIdentifier("call"),
          (
            [
              ts.factory.createIdentifier("graphqlServerUrl"),
              ts.factory.createStringLiteral(field.name.value),
              ts.factory.createIdentifier("query"),
            ] as Array<Expression>
          ).concat(
            field.arguments && field.arguments.length > 0
              ? [
                  ts.factory.createIdentifier("args"),
                  gqlArgumentsToTsArgumentTypesDeclaration(field.arguments),
                ]
              : []
          )
        )
      )
    )
  );

const gqlTypeToTsLiteralNode = (
  type: TypeNode,
  name: string,
  scalars: GqlScalarToTs
): LiteralTypeNode | TypeLiteralNode => {
  switch (type.kind) {
    case Kind.NAMED_TYPE:
      return scalars.some((scalar) => scalar.gql === type.name.value)
        ? ts.factory.createLiteralTypeNode(ts.factory.createStringLiteral(name))
        : ts.factory.createTypeLiteralNode([
            ts.factory.createPropertySignature(
              undefined,
              ts.factory.createIdentifier(name),
              undefined,
              ts.factory.createTypeReferenceNode(`${type.name.value}Query`)
            ),
          ]);
    case Kind.LIST_TYPE:
    case Kind.NON_NULL_TYPE:
      return gqlTypeToTsLiteralNode(type.type, name, scalars);
  }
};

const gqlFieldToTsLiteralNode = (
  field: FieldDefinitionNode,
  scalars: GqlScalarToTs
) => gqlTypeToTsLiteralNode(field.type, field.name.value, scalars);

const gqlDefinitionsToTsDeclarations = (
  schema: DocumentNode,
  scalars: GqlScalarToTs
) =>
  (
    schema.definitions.filter(
      (node) =>
        node.kind === Kind.OBJECT_TYPE_DEFINITION &&
        // We don't expose these types
        !["Query", "Mutation"].includes(node.name.value)
    ) as Array<ObjectTypeDefinitionNode>
  )
    .map((node) =>
      ts.factory.createTypeAliasDeclaration(
        [ts.factory.createModifier(SyntaxKind.ExportKeyword)],
        ts.factory.createIdentifier(`${node.name.value}Query`),
        undefined,
        ts.factory.createArrayTypeNode(
          ts.factory.createUnionTypeNode(
            (node.fields || []).map((field) =>
              gqlFieldToTsLiteralNode(field, scalars)
            )
          )
        )
      )
    )
    .concat(
      (
        schema.definitions.filter(
          (node) => node.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION
        ) as Array<InputObjectTypeDefinitionNode>
      ).map((node) =>
        ts.factory.createTypeAliasDeclaration(
          [ts.factory.createModifier(SyntaxKind.ExportKeyword)],
          ts.factory.createIdentifier(node.name.value),
          undefined,
          ts.factory.createTypeLiteralNode(
            (node.fields || []).map((field) =>
              // TODO: Add handling of nested objects
              ts.factory.createPropertySignature(
                undefined,
                ts.factory.createStringLiteral(field.name.value),
                undefined,
                ts.factory.createTypeReferenceNode(
                  gqlTypeToTsString(field.type, scalars)
                )
              )
            )
          )
        )
      )
    );

const declareArgumentsTypes = () => [
  ts.factory.createTypeAliasDeclaration(
    undefined,
    ts.factory.createIdentifier("Arguments"),
    undefined,
    ts.factory.createTypeLiteralNode([
      ts.factory.createPropertySignature(
        undefined,
        ts.factory.createComputedPropertyName(
          ts.factory.createBinaryExpression(
            ts.factory.createIdentifier("K"),
            ts.factory.createToken(SyntaxKind.InKeyword),
            ts.factory.createIdentifier("string")
          )
        ),
        undefined,
        ts.factory.createUnionTypeNode([
          ts.factory.createTypeReferenceNode("string"),
          ts.factory.createTypeReferenceNode("number"),
          ts.factory.createTypeReferenceNode("boolean"),
          ts.factory.createTypeReferenceNode("Arguments"),
        ])
      ),
    ])
  ),
  ts.factory.createTypeAliasDeclaration(
    undefined,
    ts.factory.createIdentifier("ArgumentTypes"),
    undefined,
    ts.factory.createTypeReferenceNode("Record", [
      ts.factory.createTypeReferenceNode("string"),
      ts.factory.createTypeReferenceNode("string"),
    ])
  ),
];

const declareFieldsType = () =>
  ts.factory.createTypeAliasDeclaration(
    undefined,
    ts.factory.createIdentifier("Fields"),
    undefined,
    ts.factory.createArrayTypeNode(
      ts.factory.createUnionTypeNode([
        ts.factory.createTypeReferenceNode("string"),
        ts.factory.createIntersectionTypeNode([
          ts.factory.createTypeLiteralNode([
            ts.factory.createPropertySignature(
              undefined,
              ts.factory.createIdentifier("$args"),
              ts.factory.createToken(SyntaxKind.QuestionToken),
              ts.factory.createTypeReferenceNode("Arguments")
            ),
          ]),
          ts.factory.createTypeReferenceNode("Record", [
            ts.factory.createTypeReferenceNode("string"),
            ts.factory.createTypeReferenceNode("Fields"),
          ]),
        ]),
      ])
    )
  );

const declareFieldsToQueryFunction = () =>
  createVariableDeclaration(
    "fieldsToQuery",
    createArrowFunction(
      [createParameterDeclaration("query", "Fields")],
      ts.factory.createBlock(
        [
          ts.factory.createVariableStatement(
            undefined,
            createVariableDeclaration(
              "scalars",
              ts.factory.createAsExpression(
                createCallExpression(
                  ts.factory.createPropertyAccessExpression(
                    ts.factory.createIdentifier("query"),
                    "filter"
                  ),
                  [
                    createArrowFunction(
                      [createParameterDeclaration("field")],
                      ts.factory.createBinaryExpression(
                        ts.factory.createTypeOfExpression(
                          ts.factory.createIdentifier("field")
                        ),
                        SyntaxKind.EqualsEqualsEqualsToken,
                        ts.factory.createStringLiteral("string")
                      )
                    ),
                  ]
                ),
                ts.factory.createTypeReferenceNode("Array", [
                  ts.factory.createTypeReferenceNode("string"),
                ])
              )
            )
          ),
          ts.factory.createVariableStatement(
            undefined,
            createVariableDeclaration(
              "objects",
              ts.factory.createAsExpression(
                createCallExpression(
                  ts.factory.createPropertyAccessExpression(
                    ts.factory.createIdentifier("query"),
                    "filter"
                  ),
                  [
                    createArrowFunction(
                      [createParameterDeclaration("field")],
                      ts.factory.createBinaryExpression(
                        ts.factory.createTypeOfExpression(
                          ts.factory.createIdentifier("field")
                        ),
                        SyntaxKind.ExclamationEqualsEqualsToken,
                        ts.factory.createStringLiteral("string")
                      )
                    ),
                  ]
                ),
                ts.factory.createTypeReferenceNode("Array", [
                  ts.factory.createTypeReferenceNode("Record", [
                    ts.factory.createTypeReferenceNode("string"),
                    ts.factory.createTypeReferenceNode("Fields"),
                  ]),
                ])
              )
            )
          ),
          ts.factory.createReturnStatement(
            ts.factory.createTemplateExpression(
              ts.factory.createTemplateHead(""),
              [
                ts.factory.createTemplateSpan(
                  createCallExpression(
                    ts.factory.createPropertyAccessExpression(
                      ts.factory.createIdentifier("scalars"),
                      "join"
                    ),
                    [ts.factory.createStringLiteral("\n")]
                  ),
                  ts.factory.createTemplateMiddle("\n")
                ),
                ts.factory.createTemplateSpan(
                  createCallExpression(
                    ts.factory.createPropertyAccessExpression(
                      createCallExpression(
                        ts.factory.createPropertyAccessExpression(
                          ts.factory.createIdentifier("objects"),
                          "map"
                        ),
                        [
                          createArrowFunction(
                            [createParameterDeclaration("object")],
                            createCallExpression(
                              ts.factory.createPropertyAccessExpression(
                                createCallExpression(
                                  ts.factory.createPropertyAccessExpression(
                                    ts.factory.createIdentifier("Object"),
                                    "entries"
                                  ),
                                  [ts.factory.createIdentifier("object")]
                                ),
                                "map"
                              ),
                              [
                                createArrowFunction(
                                  [
                                    ts.factory.createParameterDeclaration(
                                      undefined,
                                      undefined,
                                      ts.factory.createArrayBindingPattern([
                                        ts.factory.createBindingElement(
                                          undefined,
                                          undefined,
                                          "key"
                                        ),
                                        ts.factory.createBindingElement(
                                          undefined,
                                          undefined,
                                          "value"
                                        ),
                                      ])
                                    ),
                                  ],
                                  ts.factory.createTemplateExpression(
                                    ts.factory.createTemplateHead(""),
                                    [
                                      ts.factory.createTemplateSpan(
                                        ts.factory.createIdentifier("key"),
                                        ts.factory.createTemplateMiddle(" {")
                                      ),
                                      ts.factory.createTemplateSpan(
                                        createCallExpression("fieldsToQuery", [
                                          ts.factory.createIdentifier("value"),
                                        ]),
                                        ts.factory.createTemplateTail("}")
                                      ),
                                    ]
                                  )
                                ),
                              ]
                            )
                          ),
                        ]
                      ),
                      "join"
                    ),
                    [ts.factory.createStringLiteral("\n")]
                  ),
                  ts.factory.createTemplateTail("\n")
                ),
              ]
            )
          ),
        ],
        true
      ),
      ts.factory.createTypeReferenceNode("string")
    )
  );

const declareArgsToGqlFunction = () =>
  createVariableDeclaration(
    "argsToGql",
    createArrowFunction(
      [
        createParameterDeclaration("argTypes", "ArgumentTypes"),
        createParameterDeclaration("args", "Arguments"),
      ],
      createCallExpression(
        ts.factory.createPropertyAccessExpression(
          createCallExpression(
            ts.factory.createPropertyAccessExpression(
              createCallExpression(
                ts.factory.createPropertyAccessExpression(
                  ts.factory.createIdentifier("Object"),
                  "keys"
                ),
                [ts.factory.createIdentifier("args")]
              ),
              "map"
            ),
            [
              createArrowFunction(
                [createParameterDeclaration("key")],
                ts.factory.createTemplateExpression(
                  ts.factory.createTemplateHead("$"),
                  [
                    ts.factory.createTemplateSpan(
                      ts.factory.createIdentifier("key"),
                      ts.factory.createTemplateMiddle(": ")
                    ),
                    ts.factory.createTemplateSpan(
                      ts.factory.createElementAccessExpression(
                        ts.factory.createIdentifier("argTypes"),
                        ts.factory.createIdentifier("key")
                      ),

                      ts.factory.createTemplateTail("")
                    ),
                  ]
                )
              ),
            ]
          ),
          "join"
        ),
        [ts.factory.createStringLiteral("\n")]
      )
    )
  );

const declareVariablesToArgsFunction = () =>
  createVariableDeclaration(
    "variablesToArgs",
    createArrowFunction(
      [createParameterDeclaration("args", "Arguments")],
      createCallExpression(
        ts.factory.createPropertyAccessExpression(
          createCallExpression(
            ts.factory.createPropertyAccessExpression(
              createCallExpression(
                ts.factory.createPropertyAccessExpression(
                  ts.factory.createIdentifier("Object"),
                  "keys"
                ),
                [ts.factory.createIdentifier("args")]
              ),
              "map"
            ),
            [
              createArrowFunction(
                [createParameterDeclaration("key")],
                ts.factory.createTemplateExpression(
                  ts.factory.createTemplateHead(""),
                  [
                    ts.factory.createTemplateSpan(
                      ts.factory.createIdentifier("key"),
                      ts.factory.createTemplateMiddle(": $")
                    ),
                    ts.factory.createTemplateSpan(
                      ts.factory.createIdentifier("key"),
                      ts.factory.createTemplateTail("")
                    ),
                  ]
                )
              ),
            ]
          ),
          "join"
        ),
        [ts.factory.createStringLiteral("\n")]
      )
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
        createParameterDeclaration("args", "Arguments", true),
        createParameterDeclaration("argTypes", "ArgumentTypes", true),
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
                        ts.factory.createTemplateMiddle("")
                      ),
                      ts.factory.createTemplateSpan(
                        ts.factory.createConditionalExpression(
                          ts.factory.createBinaryExpression(
                            ts.factory.createIdentifier("argTypes"),
                            ts.factory.createToken(
                              SyntaxKind.AmpersandAmpersandToken
                            ),
                            ts.factory.createIdentifier("args")
                          ),
                          ts.factory.createToken(SyntaxKind.QuestionToken),
                          ts.factory.createTemplateExpression(
                            ts.factory.createTemplateHead("("),
                            [
                              ts.factory.createTemplateSpan(
                                createCallExpression("argsToGql", [
                                  "argTypes",
                                  "args",
                                ]),
                                ts.factory.createTemplateTail(")")
                              ),
                            ]
                          ),
                          ts.factory.createToken(SyntaxKind.ColonToken),
                          ts.factory.createStringLiteral("")
                        ),
                        ts.factory.createTemplateMiddle(" {\n ")
                      ),
                      ts.factory.createTemplateSpan(
                        ts.factory.createIdentifier("query"),
                        ts.factory.createTemplateMiddle("")
                      ),
                      ts.factory.createTemplateSpan(
                        ts.factory.createConditionalExpression(
                          ts.factory.createIdentifier("args"),
                          ts.factory.createToken(SyntaxKind.QuestionToken),
                          ts.factory.createTemplateExpression(
                            ts.factory.createTemplateHead("("),
                            [
                              ts.factory.createTemplateSpan(
                                createCallExpression("variablesToArgs", [
                                  "args",
                                ]),
                                ts.factory.createTemplateTail(")")
                              ),
                            ]
                          ),
                          ts.factory.createToken(SyntaxKind.ColonToken),
                          ts.factory.createStringLiteral("")
                        ),
                        ts.factory.createTemplateMiddle(" {\n ")
                      ),
                      ts.factory.createTemplateSpan(
                        createCallExpression("fieldsToQuery", [
                          ts.factory.createIdentifier("returns"),
                        ]),
                        ts.factory.createTemplateTail(" } }")
                      ),
                    ]
                  ),
                  variables: ts.factory.createIdentifier("args"),
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

type GqlScalarToTs = Array<{ gql: string; ts: string }>;

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

  // TODO: Make the user provide TS types for their custom scalars
  // const scalars = (
  //   schema.definitions.filter(
  //     (node) => node.kind === Kind.SCALAR_TYPE_DEFINITION
  //   ) as Array<ScalarTypeDefinitionNode>
  // ).concat();

  const baseScalars: GqlScalarToTs = [
    { gql: "Int", ts: "number" },
    { gql: "Float", ts: "number" },
    { gql: "String", ts: "string" },
    { gql: "Boolean", ts: "boolean" },
    { gql: "ID", ts: "string" },
  ];

  return ts.factory.createNodeArray([
    ...declareArgumentsTypes(),
    declareFieldsType(),
    declareFieldsToQueryFunction(),
    declareArgsToGqlFunction(),
    declareVariablesToArgsFunction(),
    declareCallFunction(),
    ...gqlDefinitionsToTsDeclarations(schema, baseScalars),
    ts.factory.createExportDefault(
      createArrowFunction(
        [createParameterDeclaration("graphqlServerUrl", "string")],
        ts.factory.createObjectLiteralExpression(
          (queries
            ? [
                ts.factory.createPropertyAssignment(
                  "query",
                  ts.factory.createObjectLiteralExpression(
                    gqlQueriesToTsFunctionDefinitions(queries, baseScalars),
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
