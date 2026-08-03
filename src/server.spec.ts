import { beforeAll, expect, test } from "vitest";
import fs from "fs/promises";
import { gql } from "graphql-tag";
import { graphql } from "graphql";
import ts from "typescript";
import schemaToServer from "./server.js";

const schema = gql`
  type User {
    id: ID!
    name: String!
    posts: [Post]!
  }

  type Post {
    id: ID!
    title: String!
    author: User!
  }

  type Query {
    user(id: ID!): User
    users: [User]!
  }

  type Mutation {
    deleteUser(id: ID!): User!
  }
`;

const typecheck = (file: string) => {
  const program = ts.createProgram({
    options: {
      noEmit: true,
      strict: true,
      noFallthroughCasesInSwitch: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      allowImportingTsExtensions: true,
      target: ts.ScriptTarget.ES2022,
    },
    rootNames: [file],
  });

  const normalizedFile = file.replace(/^\.\//, "");

  return ts
    .getPreEmitDiagnostics(program)
    .concat(program.emit().diagnostics)
    .filter((diagnostic) => diagnostic.file?.fileName === normalizedFile);
};

beforeAll(async () => {
  await fs.mkdir("./generated-tests-files", { recursive: true });

  await fs.writeFile(
    "./generated-tests-files/permissionsEnabled.server.ts",
    schemaToServer(schema, {
      scalarTypes: {},
      scalarImports: "",
      permissions: true,
    }),
  );

  await fs.writeFile(
    "./generated-tests-files/permissionsDisabled.server.ts",
    schemaToServer(schema, {
      scalarTypes: {},
      scalarImports: "",
      permissions: false,
    }),
  );

  // A field resolver only needs to handle the fields it's given - the rest
  // pass straight through from the source object (hence `posts`/`author`
  // being the only resolvers below; `id`/`name`/`title` come from the data
  // returned by the Query/Mutation resolvers).
  await fs.writeFile(
    "./generated-tests-files/permissionsValidUsage.ts",
    [
      'import { buildSchema, Authorized, Denied } from "./permissionsEnabled.server.ts";',
      "",
      "type Context = { isAdmin: boolean };",
      "",
      "export const schema = buildSchema<Context>()({",
      "  User: {",
      '    posts: (_user, _context) => new Authorized([{ id: "p1", title: "hello" }]),',
      "  },",
      "  Post: {",
      '    author: (_post, _context) => new Authorized({ id: "u1", name: "Alice" }),',
      "  },",
      "})({",
      "  Query: {",
      '    user: (args, _context) => new Authorized({ id: args.id, name: "Alice" }),',
      '    users: (_context) => new Authorized([{ id: "u1", name: "Alice" }]),',
      "  },",
      "  Mutation: {",
      "    deleteUser: (args, context) =>",
      "      context.isAdmin",
      '        ? new Authorized({ id: args.id, name: "" })',
      '        : new Denied("must be an admin"),',
      "  },",
      "});",
    ].join("\n"),
  );

  await fs.writeFile(
    "./generated-tests-files/permissionsInvalidUsage.ts",
    [
      'import { buildSchema, Authorized } from "./permissionsEnabled.server.ts";',
      "",
      "type Context = { isAdmin: boolean };",
      "",
      "buildSchema<Context>()({",
      "  User: {",
      '    posts: (_user, _context) => [{ id: "p1", title: "hello" }],',
      "  },",
      "  Post: {",
      '    author: (_post, _context) => new Authorized({ id: "u1", name: "Alice" }),',
      "  },",
      "})({",
      "  Query: {",
      '    user: (args, _context) => ({ id: args.id, name: "Alice" }),',
      '    users: (_context) => new Authorized([{ id: "u1", name: "Alice" }]),',
      "  },",
      "  Mutation: {",
      '    deleteUser: (args, _context) => ({ id: args.id, name: "" }),',
      "  },",
      "});",
    ].join("\n"),
  );
});

test("permissions disabled: generated server file typechecks", () => {
  expect(
    typecheck("./generated-tests-files/permissionsDisabled.server.ts"),
  ).toHaveLength(0);
});

test("permissions enabled: generated server file typechecks", () => {
  expect(
    typecheck("./generated-tests-files/permissionsEnabled.server.ts"),
  ).toHaveLength(0);
});

test("permissions enabled: resolvers wrapped in Authorized/Denied typecheck", () => {
  expect(
    typecheck("./generated-tests-files/permissionsValidUsage.ts"),
  ).toHaveLength(0);
});

test("permissions enabled: resolvers returning raw values fail to typecheck", () => {
  expect(
    typecheck("./generated-tests-files/permissionsInvalidUsage.ts").length,
  ).toBeGreaterThan(0);
});

test("permissions enabled: Denied surfaces as a GraphQL error, Authorized passes through", async () => {
  const { schema: graphqlSchema } = await import(
    "../generated-tests-files/permissionsValidUsage.js"
  );

  const denied = await graphql({
    schema: graphqlSchema,
    source: 'mutation { deleteUser(id: "u1") { id } }',
    contextValue: { userContext: { isAdmin: false } },
  });

  expect(denied.errors?.[0]?.message).toBe("must be an admin");
  expect(denied.data).toBeNull();

  const allowed = await graphql({
    schema: graphqlSchema,
    source: 'mutation { deleteUser(id: "u1") { id } }',
    contextValue: { userContext: { isAdmin: true } },
  });

  expect(allowed.errors).toBeUndefined();
  expect(allowed.data).toEqual({ deleteUser: { id: "u1" } });

  const queried = await graphql({
    schema: graphqlSchema,
    source: '{ user(id: "u1") { id name posts { title } } }',
    contextValue: { userContext: { isAdmin: false } },
  });

  expect(queried.errors).toBeUndefined();
  expect(queried.data).toEqual({
    user: { id: "u1", name: "Alice", posts: [{ title: "hello" }] },
  });
});

test("GraphQL descriptions become JSDoc comments on the generated resolver types", async () => {
  const documentedSchema = gql`
    """
    A person who uses the app.
    """
    type User {
      id: ID!
      """
      The user's display name.
      """
      name: String!
      posts: [Post]!
    }

    type Post {
      id: ID!
      title: String!
      author: User!
    }

    type Query {
      """
      Fetch a single user by id.
      """
      user(id: ID!): User
      users: [User]!
    }

    type Mutation {
      """
      Delete a user by id.
      """
      deleteUser(id: ID!): User!
    }
  `;

  const server = schemaToServer(documentedSchema, {
    scalarTypes: {},
    scalarImports: "",
    permissions: false,
  });

  await fs.writeFile(
    "./generated-tests-files/descriptions.server.ts",
    server,
  );

  expect(server).toContain("/** A person who uses the app. */\ntype User = {");
  expect(server).toContain(
    "  /** The user's display name. */\n  name: string",
  );
  expect(server).toContain("/** Fetch a single user by id. */\n        user:");
  expect(server).toContain(
    "/** Delete a user by id. */\n        deleteUser:",
  );

  expect(
    typecheck("./generated-tests-files/descriptions.server.ts"),
  ).toHaveLength(0);
});
