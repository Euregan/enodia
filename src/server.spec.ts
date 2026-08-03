import { beforeAll, expect, test } from "vitest";
import fs from "fs/promises";
import { createServer } from "node:http";
import { gql } from "graphql-tag";
import { graphql, subscribe as graphqlSubscribe, parse } from "graphql";
import { createClient } from "graphql-ws";
import { WebSocketServer } from "ws";
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

const subscriptionSchema = gql`
  type Message {
    id: ID!
    text: String!
  }

  type Query {
    message(id: ID!): Message
  }

  type Mutation {
    sendMessage(id: ID!, text: String!): Message!
  }

  type Subscription {
    messageAdded(roomId: ID!): Message!
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

  await fs.writeFile(
    "./generated-tests-files/subscriptionsDisabled.server.ts",
    schemaToServer(subscriptionSchema, {
      scalarTypes: {},
      scalarImports: "",
      permissions: false,
    }),
  );

  await fs.writeFile(
    "./generated-tests-files/subscriptionsEnabled.server.ts",
    schemaToServer(subscriptionSchema, {
      scalarTypes: {},
      scalarImports: "",
      permissions: true,
    }),
  );

  const messagesById: Record<string, { id: string; text: string }> = {
    m1: { id: "m1", text: "hello" },
  };

  await fs.writeFile(
    "./generated-tests-files/subscriptionsDisabledUsage.ts",
    [
      'import { buildSchema, server } from "./subscriptionsDisabled.server.ts";',
      "",
      "const fieldsConfiguration = { Message: {} };",
      "",
      "const queriesAndMutations = {",
      "  Query: {",
      `    message: (args: { id: string }) => (${JSON.stringify(messagesById)} as Record<string, { id: string; text: string }>)[args.id] ?? undefined,`,
      "  },",
      "  Mutation: {",
      "    sendMessage: (args: { id: string; text: string }) => ({ id: args.id, text: args.text }),",
      "  },",
      "  Subscription: {",
      "    messageAdded: async function* (_args: { roomId: string }) {",
      '      yield { id: "m1", text: "first" };',
      '      yield { id: "m1", text: "second" };',
      "    },",
      "  },",
      "};",
      "",
      "export const schema = buildSchema()(fieldsConfiguration)(queriesAndMutations);",
      "export const { listener, subscriptionServer } = server()(fieldsConfiguration)(queriesAndMutations);",
    ].join("\n"),
  );

  await fs.writeFile(
    "./generated-tests-files/subscriptionsEnabledUsage.ts",
    [
      'import { buildSchema, server, Authorized, Denied } from "./subscriptionsEnabled.server.ts";',
      "",
      "type Context = { canSubscribe: boolean };",
      "",
      "const fieldsConfiguration = { Message: {} };",
      "",
      "const queriesAndMutations = {",
      "  Query: {",
      `    message: (args: { id: string }) => new Authorized((${JSON.stringify(messagesById)} as Record<string, { id: string; text: string }>)[args.id] ?? undefined),`,
      "  },",
      "  Mutation: {",
      "    sendMessage: (args: { id: string; text: string }) => new Authorized({ id: args.id, text: args.text }),",
      "  },",
      "  Subscription: {",
      "    messageAdded: async (_args: { roomId: string }, context: Context) =>",
      "      context.canSubscribe",
      "        ? new Authorized(",
      "            (async function* () {",
      '              yield { id: "m1", text: "first" };',
      '              yield { id: "m1", text: "second" };',
      "            })(),",
      "          )",
      '        : new Denied("must be able to subscribe"),',
      "  },",
      "};",
      "",
      "export const schema = buildSchema<Context>()(fieldsConfiguration)(queriesAndMutations);",
      "export const { listener, subscriptionServer } = server<",
      "  import('http').IncomingMessage,",
      "  import('http').ServerResponse<import('http').IncomingMessage>,",
      "  Context",
      ">({",
      "  instantiateContext: (): Context => ({ canSubscribe: true }),",
      "  instantiateSubscriptionContext: (): Context => ({ canSubscribe: true }),",
      "})(fieldsConfiguration)(queriesAndMutations);",
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

test("subscriptions disabled: generated server file typechecks", () => {
  expect(
    typecheck("./generated-tests-files/subscriptionsDisabled.server.ts"),
  ).toHaveLength(0);
});

test("subscriptions enabled: generated server file typechecks", () => {
  expect(
    typecheck("./generated-tests-files/subscriptionsEnabled.server.ts"),
  ).toHaveLength(0);
});

test("permissions disabled: resolvers returning an async iterable typecheck", () => {
  expect(
    typecheck("./generated-tests-files/subscriptionsDisabledUsage.ts"),
  ).toHaveLength(0);
});

test("permissions enabled: subscribe resolvers wrapped in Authorized/Denied typecheck", () => {
  expect(
    typecheck("./generated-tests-files/subscriptionsEnabledUsage.ts"),
  ).toHaveLength(0);
});

test("subscription resolvers wire into an async generator graphql-js can drive directly", async () => {
  const { schema } = await import(
    "../generated-tests-files/subscriptionsDisabledUsage.js"
  );

  const result = await graphqlSubscribe({
    schema,
    document: parse('subscription { messageAdded(roomId: "r1") { id text } }'),
    contextValue: { userContext: undefined },
  });

  if (!("next" in result)) {
    throw new Error("expected an async iterable, got a single ExecutionResult");
  }

  const received: Array<unknown> = [];
  for await (const event of result) {
    received.push(event.data);
    if (received.length === 2) break;
  }

  expect(received).toEqual([
    { messageAdded: { id: "m1", text: "first" } },
    { messageAdded: { id: "m1", text: "second" } },
  ]);
});

test("permissions enabled: a denied subscription throws instead of streaming events, an authorized one still streams", async () => {
  const { schema } = await import(
    "../generated-tests-files/subscriptionsEnabledUsage.js"
  );

  const denied = await graphqlSubscribe({
    schema,
    document: parse('subscription { messageAdded(roomId: "r1") { id text } }'),
    contextValue: { userContext: { canSubscribe: false } },
  });

  expect("errors" in denied && denied.errors?.[0]?.message).toBe(
    "must be able to subscribe",
  );

  const allowed = await graphqlSubscribe({
    schema,
    document: parse('subscription { messageAdded(roomId: "r1") { id text } }'),
    contextValue: { userContext: { canSubscribe: true } },
  });

  if (!("next" in allowed)) {
    throw new Error("expected an async iterable, got a single ExecutionResult");
  }

  const received: Array<unknown> = [];
  for await (const event of allowed) {
    received.push(event.data);
    break;
  }

  expect(received).toEqual([{ messageAdded: { id: "m1", text: "first" } }]);
});

test("subscriptionServer speaks the graphql-ws protocol end to end over a real WebSocket", async () => {
  const { listener, subscriptionServer } = await import(
    "../generated-tests-files/subscriptionsEnabledUsage.js"
  );

  const httpServer = createServer(listener);
  const webSocketServer = new WebSocketServer({ server: httpServer, path: "/graphql" });
  const dispose = subscriptionServer(webSocketServer);

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const client = createClient({ url: `ws://localhost:${port}/graphql` });

  const received: Array<unknown> = [];
  await new Promise<void>((resolve, reject) => {
    client.subscribe(
      { query: 'subscription { messageAdded(roomId: "r1") { id text } }' },
      {
        next: (value) => received.push(value),
        error: reject,
        complete: () => resolve(),
      },
    );
  });

  await client.dispose();
  await dispose.dispose();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));

  expect(received).toEqual([
    { data: { messageAdded: { id: "m1", text: "first" } } },
    { data: { messageAdded: { id: "m1", text: "second" } } },
  ]);
});

test("plain HTTP query/mutation handling still works once a Subscription root is present", async () => {
  const { listener } = await import(
    "../generated-tests-files/subscriptionsDisabledUsage.js"
  );

  const httpServer = createServer(listener);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const response = await fetch(`http://localhost:${port}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: '{ message(id: "m1") { id text } }' }),
  }).then((res) => res.json());

  await new Promise<void>((resolve) => httpServer.close(() => resolve()));

  expect(response).toEqual({ data: { message: { id: "m1", text: "hello" } } });
});
