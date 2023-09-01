import { beforeAll, expect, test, vi } from "vitest";
import fs from "fs/promises";
import { gql } from "graphql-tag";
import schemaToClient from "./client.ts";
import ts from "typescript";
import justQueries from "../generated-tests-files/justQueries.ts";

beforeAll(async () => {
  const justQueries = schemaToClient(
    gql`
      scalar Date

      type User {
        id: ID!
        name: String!
        comments(postId: ID): [Comment]!
        posts: [Post]!
      }

      type Post {
        id: ID!
        content: String!
        author: User!
        comments(userId: ID): [Comment]!
      }

      type Comment {
        id: ID!
        post: Post!
        content: String!
        postedAt: Date!
      }

      type Query {
        user(id: ID!): User
      }
    `,
    { scalarTypes: { Date: { name: "Date" } } }
  );
  // The path is relative to the root of the project
  await fs.mkdir("./generated-tests-files", { recursive: true });
  await fs.writeFile("./generated-tests-files/justQueries.ts", justQueries);
});

test("validate files", () => {
  const program = ts.createProgram({
    options: {
      noEmit: true,
      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noFallthroughCasesInSwitch: true,
    },
    rootNames: ["./generated-tests-files/justQueries.ts"],
  });

  console.log(
    ts
      .getPreEmitDiagnostics(program)
      .concat(program.emit().diagnostics)
      .map((error) => error.messageText)
  );

  expect(
    ts.getPreEmitDiagnostics(program).concat(program.emit().diagnostics)
  ).toHaveLength(0);
});

test("args", () => {
  let query = "";
  let variables = "";
  const client = justQueries("", {
    fetch: vi.fn(async (_, { body }) => {
      query = JSON.parse(body).query;
      variables = JSON.parse(body).variables;
      return { json: async () => ({}) };
    }),
  });

  expect(
    client.query.user(
      [
        "name",
        {
          posts: [
            "content",
            {
              comments: ["content"],
              $args: { userId: "user-ea97-40d2-9e1c-766288fa6037" },
            },
          ],
        },
      ],
      { id: "user-875f-4277-8de0-4501f8b58070" }
    )
  );

  expect(query).toMatchSnapshot();
  expect(variables).toMatchSnapshot();
});
