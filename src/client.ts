import { Kind, DocumentNode, ObjectTypeDefinitionNode } from "graphql";
import ts, { PropertyAssignment } from "typescript";

const queriesToFunctions = (
  queries: ObjectTypeDefinitionNode
): Array<PropertyAssignment> =>
  (queries.fields || []).map((field) =>
    ts.factory.createPropertyAssignment(
      field.name.value,
      ts.factory.createArrowFunction(
        undefined,
        undefined,
        [],
        undefined,
        undefined,
        ts.factory.createCallExpression(
          ts.factory.createIdentifier("fetch"),
          undefined,
          [
            ts.factory.createIdentifier("graphqlServerUrl"),
            ts.factory.createObjectLiteralExpression(
              [
                ts.factory.createPropertyAssignment(
                  "method",
                  ts.factory.createStringLiteral("POST")
                ),
              ],
              true
            ),
          ]
        )
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
    ts.factory.createExportDefault(
      ts.factory.createArrowFunction(
        undefined,
        undefined,
        [
          ts.factory.createParameterDeclaration(
            undefined,
            undefined,
            "graphqlServerUrl",
            undefined,
            ts.factory.createTypeReferenceNode("string")
          ),
        ],
        undefined,
        undefined,
        ts.factory.createObjectLiteralExpression(
          (queries
            ? [
                ts.factory.createPropertyAssignment(
                  "query",
                  ts.factory.createObjectLiteralExpression(
                    queriesToFunctions(queries),
                    true
                  )
                ),
              ]
            : []
          ).concat(
            mutations
              ? ts.factory.createPropertyAssignment(
                  "mutate",
                  ts.factory.createArrowFunction(
                    undefined,
                    undefined,
                    [],
                    undefined,
                    undefined,
                    ts.factory.createObjectLiteralExpression([], true)
                  )
                )
              : []
          ),
          true
        )
      )
    ),
  ]);
};
