import { beforeAll, expect, test, vi } from "vitest";
import fs from "fs/promises";
import { gql } from "graphql-tag";
import schemaToClient from "./client";
import ts from "typescript";

beforeAll(async () => {
  const justQueries = schemaToClient(
    gql`
      scalar Date

      type User {
        id: ID!
        name: String!
        email: String!
        birthday: Date
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
        users: [User]!
      }
    `,
    {
      url: "http://localhost:3000/graphql",
      scalarTypes: { Date: { name: "Date" } },
      withReact: true,
    }
  );

  const queriesAndMutations = schemaToClient(
    gql`
      scalar Date

      type User {
        id: ID!
        name: String!
        email: String!
        birthday: Date
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
        users: [User]!
      }

      type Mutation {
        createUser(name: String!, email: String!): User!
      }
    `,
    {
      url: "http://localhost:3000/graphql",
      scalarTypes: { Date: { name: "Date" } },
      withReact: true,
    }
  );

  // The path is relative to the root of the project
  await fs.mkdir("./generated-tests-files", { recursive: true });
  await fs.writeFile("./generated-tests-files/justQueries.ts", justQueries);
  await fs.writeFile(
    "./generated-tests-files/queriesAndMutations.ts",
    queriesAndMutations
  );
});

test.each(["justQueries", "queriesAndMutations"])(
  "validate file %s",
  (client) => {
    const program = ts.createProgram({
      options: {
        noEmit: true,
        strict: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        noFallthroughCasesInSwitch: true,
      },
      rootNames: [`./generated-tests-files/${client}.ts`],
    });

    const errors = ts
      .getPreEmitDiagnostics(program)
      .concat(program.emit().diagnostics)
      .map((error) => error.messageText);

    if (errors.length > 0) {
      console.log(
        ts
          .getPreEmitDiagnostics(program)
          .concat(program.emit().diagnostics)
          .map((error) => error.messageText)
      );
    }

    expect(errors).toHaveLength(0);
  }
);

test("args generation for justQueries", async () => {
  let query = "";
  let variables = "";

  const justQueries = (await import("../generated-tests-files/justQueries"))
    .default;

  const client = justQueries("", {
    // @ts-ignore
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

test("args generation for queriesAndMutations", async () => {
  let query = "";
  let variables = "";

  const queriesAndMutations = (
    await import("../generated-tests-files/queriesAndMutations")
  ).default;

  const client = queriesAndMutations("", {
    // @ts-ignore
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
