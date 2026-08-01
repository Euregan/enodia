import { beforeAll, expect, test, vi } from "vitest";
import fs from "fs/promises";
import { gql } from "graphql-tag";
import schemaToWeb from "./web.js";
import ts from "typescript";

beforeAll(async () => {
  const justQueries = schemaToWeb(
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

      union Feed = Post | Comment

      type Query {
        user(id: ID!): User
        users: [User]!
        userCount: Int!
        feed: [Feed!]!
      }
    `,
    {
      scalarTypes: {
        Date: {
          type: "Date",
          encode: "(value) => value.toISOString()",
          decode: "(value) => new Date(value)",
          imports: [],
        },
      },
      scalarImports: "",
      withReact: { url: "http://localhost:3000/graphql" },
    },
  );

  const queriesAndMutations = schemaToWeb(
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

      union Feed = Post | Comment

      type Query {
        user(id: ID!): User
        users: [User]!
        userCount: Int!
        feed: [Feed!]!
      }

      type Mutation {
        createUser(name: String!, email: String!): User!
      }
    `,
    {
      scalarTypes: {
        Date: {
          type: "Date",
          encode: "(value) => value.toISOString()",
          decode: "(value) => new Date(value)",
          imports: [],
        },
      },
      scalarImports: "",
      withReact: { url: "http://localhost:3000/graphql" },
    },
  );

  // The path is relative to the root of the project
  await fs.mkdir("./generated-tests-files", { recursive: true });
  await fs.writeFile("./generated-tests-files/justQueries.ts", justQueries);
  await fs.writeFile(
    "./generated-tests-files/queriesAndMutations.ts",
    queriesAndMutations,
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
          .map((error) => error.messageText),
      );
    }

    expect(errors).toHaveLength(0);
  },
);

test("args generation for justQueries", async () => {
  let query = "";
  let variables = "";

  const justQueries = (await import("../generated-tests-files/justQueries.js"))
    .default;

  const client = justQueries("", {
    // @ts-ignore
    fetch: vi.fn(async (_, { body }) => {
      query = JSON.parse(body).query;
      variables = JSON.parse(body).variables;
      return { json: async () => ({ data: [] }) };
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
      { id: "user-875f-4277-8de0-4501f8b58070" },
    ),
  );

  expect(query).toMatchSnapshot();
  expect(variables).toMatchSnapshot();
});

test("union query generation", async () => {
  let query = "";

  const justQueries = (await import("../generated-tests-files/justQueries.js"))
    .default;

  const client = justQueries("", {
    // @ts-ignore
    fetch: vi.fn(async (_, { body }) => {
      query = JSON.parse(body).query;
      return { json: async () => ({ data: { feed: [] } }) };
    }),
  });

  await client.query.feed([
    "__typename",
    {
      $on: {
        Post: ["content", { comments: ["content"] }],
        Comment: ["content"],
      },
    },
  ]);

  expect(query).toContain("... on Post");
  expect(query).toContain("... on Comment");
  expect(query).toContain("__typename");
  expect(query).toMatchSnapshot();
});

test("args generation for queriesAndMutations", async () => {
  let query = "";
  let variables = "";

  const queriesAndMutations = (
    await import("../generated-tests-files/queriesAndMutations.js")
  ).default;

  const client = queriesAndMutations("", {
    // @ts-ignore
    fetch: vi.fn(async (_, { body }) => {
      query = JSON.parse(body).query;
      variables = JSON.parse(body).variables;
      return { json: async () => ({ data: [] }) };
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
      { id: "user-875f-4277-8de0-4501f8b58070" },
    ),
  );

  expect(query).toMatchSnapshot();
  expect(variables).toMatchSnapshot();
});

test("schema types colliding with reserved generator names typecheck cleanly", async () => {
  const client = schemaToWeb(
    gql`
      type Error {
        message: String!
      }

      type SpendingLimit {
        amount: Int!
        lastError: Error
      }

      type SpendingLimitResult {
        success: Boolean!
        limit: SpendingLimit
      }

      type Query {
        lastError: Error
        spendingLimit: SpendingLimit
        spendingLimitResult: SpendingLimitResult
      }
    `,
    {
      scalarTypes: {},
      scalarImports: "",
      withReact: { url: "http://localhost:3000/graphql" },
    },
  );

  await fs.mkdir("./generated-tests-files", { recursive: true });
  await fs.writeFile("./generated-tests-files/nameCollisions.ts", client);

  const program = ts.createProgram({
    options: {
      noEmit: true,
      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noFallthroughCasesInSwitch: true,
    },
    rootNames: ["./generated-tests-files/nameCollisions.ts"],
  });

  const errors = ts
    .getPreEmitDiagnostics(program)
    .concat(program.emit().diagnostics)
    .map((error) => error.messageText);

  if (errors.length > 0) {
    console.log(errors);
  }

  expect(errors).toHaveLength(0);
});

test("enum-returning fields with only-optional args typecheck cleanly", async () => {
  const client = schemaToWeb(
    gql`
      enum Entitlement {
        ADMIN
        MEMBER
      }

      type Organisation {
        id: ID!
        name: String!
        parent: Organisation
      }

      type Query {
        organisation(id: ID!): Organisation
        getOrgAdminEntitlementsForUser(
          userId: ID!
          accountId: String
        ): [Entitlement!]!
        getInvitationExpiration(invitationToken: String): Entitlement
      }

      type Mutation {
        addOrganisationEntitlement(
          orgId: ID!
          entitlements: [Entitlement!]!
        ): [Entitlement!]!
      }
    `,
    {
      scalarTypes: {},
      scalarImports: "",
      withReact: { url: "http://localhost:3000/graphql" },
    },
  );

  await fs.mkdir("./generated-tests-files", { recursive: true });
  await fs.writeFile("./generated-tests-files/enumOnlyOptionalArgs.ts", client);

  const program = ts.createProgram({
    options: {
      noEmit: true,
      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noFallthroughCasesInSwitch: true,
    },
    rootNames: ["./generated-tests-files/enumOnlyOptionalArgs.ts"],
  });

  const errors = ts
    .getPreEmitDiagnostics(program)
    .concat(program.emit().diagnostics)
    .map((error) => error.messageText);

  if (errors.length > 0) {
    console.log(errors);
  }

  expect(errors).toHaveLength(0);
});

test("interface-typed fields with $on fragments typecheck cleanly", async () => {
  const client = schemaToWeb(
    gql`
      interface EventGQL {
        id: ID!
        title: String!
      }

      type RegularEventGQL implements EventGQL {
        id: ID!
        title: String!
        location: String!
      }

      type TrainingEventGQL implements EventGQL {
        id: ID!
        title: String!
        trainer: String!
      }

      type Organisation {
        id: ID!
        name: String!
        parent: Organisation
      }

      type Query {
        event(id: ID!): EventGQL
        organisation(id: ID!): Organisation
      }
    `,
    {
      scalarTypes: {},
      scalarImports: "",
      withReact: { url: "http://localhost:3000/graphql" },
    },
  );

  await fs.mkdir("./generated-tests-files", { recursive: true });
  await fs.writeFile("./generated-tests-files/interfaceTypes.ts", client);

  const program = ts.createProgram({
    options: {
      noEmit: true,
      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noFallthroughCasesInSwitch: true,
    },
    rootNames: ["./generated-tests-files/interfaceTypes.ts"],
  });

  const errors = ts
    .getPreEmitDiagnostics(program)
    .concat(program.emit().diagnostics)
    .map((error) => error.messageText);

  if (errors.length > 0) {
    console.log(errors);
  }

  expect(errors).toHaveLength(0);
});
