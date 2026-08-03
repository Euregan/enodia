import { expect, test } from "vitest";
import { gql } from "graphql-tag";
import { Kind, type ObjectTypeDefinitionNode } from "graphql";
import { argsToTsDeclaration, baseScalars, queriesTypes } from "./helpers.ts";

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

test("fieldQuery types a list-typed argument on a nested field selection as an array, not its element type", () => {
  // `comments` is a non-scalar field with its own list-typed argument, so
  // `fieldQuery` (used by `queriesTypes` to build `PostQuery`) has to go
  // through the same `$args` declaration as a top-level query argument.
  const schema = gql`
    type Comment {
      id: ID!
      content: String!
    }

    type Post {
      id: ID!
      comments(ids: [ID!]): [Comment!]!
    }

    type Query {
      post(id: ID!): Post
    }
  `;

  const generated = queriesTypes(schema, baseScalars, [], []);

  expect(generated).toContain("$args?: { ids?: Array<string> }");
});
