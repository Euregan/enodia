import { expect, test } from "vitest";
import { gql } from "graphql-tag";
import { Kind, type ObjectTypeDefinitionNode } from "graphql";
import { argsToTsDeclaration, baseScalars } from "./helpers.ts";

test("argsToTsDeclaration types a list-typed argument as an array, not its element type", () => {
  const schema = gql`
    type Query {
      search(ids: [Int!]): String
    }
  `;

  const queryType = schema.definitions.find(
    (node) =>
      node.kind === Kind.OBJECT_TYPE_DEFINITION && node.name.value === "Query",
  ) as ObjectTypeDefinitionNode;
  const [searchField] = queryType.fields ?? [];

  const declaration = argsToTsDeclaration(
    searchField.arguments ?? [],
    baseScalars,
    [],
  );

  expect(declaration).toBe("args?: { ids?: Array<number> }");
});
