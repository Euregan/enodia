import fs from "fs/promises";
import { gql } from "graphql-tag";
import { expect, test, vi } from "vitest";
import schemaToWeb from "./web.js";

type FetchPolicy = "cache-first" | "network-only" | "no-cache" | "cache-only";

// Canned server responses. Every entity carries id + __typename, as a real
// server would once Enodia injects them into the request.
const respond = (operation: string, variables: Record<string, string>) => {
  switch (operation) {
    case "user":
      return variables.id === "missing"
        ? { user: null }
        : {
            user: {
              __typename: "User",
              id: variables.id,
              name: "Alice" + variables.id,
              email: "a" + variables.id + "@x",
            },
          };
    case "users":
      return {
        users: [
          { __typename: "User", id: "1", name: "Alice1", email: "a1@x" },
          { __typename: "User", id: "2", name: "Alice2", email: "a2@x" },
        ],
      };
    case "userCount":
      return { userCount: 42 };
    case "feed":
      return {
        feed: [
          { __typename: "Post", id: "p1", content: "hello" },
          { __typename: "Comment", id: "c1", content: "world" },
        ],
      };
    case "createUser":
      return {
        createUser: {
          __typename: "User",
          id: "1",
          name: "UPDATED",
          email: "a1@x",
        },
      };
    case "event":
      return {
        event: {
          __typename: "TrainingEventGQL",
          id: "e1",
          title: "Onboarding",
          trainer: "Bob",
        },
      };
    default:
      throw new Error("unexpected operation " + operation);
  }
};

// Generate a fresh client with an isolated normalized store, backed by a
// counting stub fetch. `vi.resetModules()` re-evaluates the generated module so
// its module-level `entities`/`roots` start empty for every test.
const setup = async () => {
  const source = schemaToWeb(
    gql`
      scalar Date
      type User {
        id: ID!
        name: String!
        email: String!
        posts: [Post]!
      }
      type Post {
        id: ID!
        content: String!
        author: User!
      }
      type Comment {
        id: ID!
        content: String!
        postedAt: Date!
      }
      union Feed = Post | Comment
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
      type Query {
        user(id: ID!): User
        users: [User]!
        userCount: Int!
        feed: [Feed!]!
        event(id: ID!): EventGQL
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
    },
  );

  await fs.mkdir("./generated-tests-files", { recursive: true });
  await fs.writeFile("./generated-tests-files/storeClient.ts", source);

  vi.resetModules();
  const enodia = (await import("../generated-tests-files/storeClient.js"))
    .default;

  const state = { calls: 0, lastBody: null as null | { query: string } };
  const makeClient = (fetchPolicy: FetchPolicy = "cache-first") =>
    enodia("http://localhost/graphql", {
      fetchPolicy,
      // @ts-expect-error the generated fetch stub only needs .json()
      fetch: async (_url: string, init: { body: string }) => {
        state.calls++;
        const body = JSON.parse(init.body);
        state.lastBody = body;
        return {
          json: async () => ({
            data: respond(body.operationName, body.variables || {}),
          }),
        };
      },
    });

  return { makeClient, state };
};

test("caches a query and merges entity fields across selections", async () => {
  const { makeClient, state } = await setup();
  const client = makeClient();

  expect(await client.query.user(["name"], { id: "1" })).toEqual({
    name: "Alice1",
  });
  expect(state.calls).toBe(1);

  // Same selection: served from cache.
  await client.query.user(["name"], { id: "1" });
  expect(state.calls).toBe(1);

  // New field: fetched and merged onto the same User:1 entity.
  expect(await client.query.user(["email"], { id: "1" })).toEqual({
    email: "a1@x",
  });
  expect(state.calls).toBe(2);

  // Both fields are now cached on the entity, so this is a hit.
  expect(await client.query.user(["name", "email"], { id: "1" })).toEqual({
    name: "Alice1",
    email: "a1@x",
  });
  expect(state.calls).toBe(2);
});

test("injects the key field into the request but strips it from the result", async () => {
  const { makeClient, state } = await setup();
  const client = makeClient();

  const result = await client.query.user(["name"], { id: "1" });

  expect(state.lastBody?.query).toContain("id");
  expect(result).not.toHaveProperty("id");
});

test("normalizes list queries", async () => {
  const { makeClient, state } = await setup();
  const client = makeClient();

  expect(await client.query.users(["name"])).toEqual([
    { name: "Alice1" },
    { name: "Alice2" },
  ]);
  expect(state.calls).toBe(1);

  await client.query.users(["name"]);
  expect(state.calls).toBe(1);
});

test("resolves an entity by id from another query via cache redirect", async () => {
  const { makeClient, state } = await setup();
  const client = makeClient();

  await client.query.users(["name"]); // loads User:1 and User:2 with `name`
  expect(state.calls).toBe(1);

  // `user(id: "2")` was never run, but User:2 is in the store -> redirect hit.
  expect(await client.query.user(["name"], { id: "2" })).toEqual({
    name: "Alice2",
  });
  expect(state.calls).toBe(1);

  // A field the cached entity lacks -> redirect misses -> fetch.
  expect(await client.query.user(["email"], { id: "2" })).toEqual({
    email: "a2@x",
  });
  expect(state.calls).toBe(2);
});

// A hook's `cache-and-network` is a `cache-only` seed (instant paint) plus a
// `network-only` refetch. This exercises those two primitives on a list.
test("cache-and-network on a list: the seed hits and reflects latest entities", async () => {
  const { makeClient, state } = await setup();

  // The network half of a first mount populates the list root and entities.
  const network = makeClient("network-only");
  expect(await network.query.users(["name"])).toEqual([
    { name: "Alice1" },
    { name: "Alice2" },
  ]);
  expect(state.calls).toBe(1);

  // On a later mount, the seed (a cache-only read) returns the cached list with
  // no fetch — this is what paints instantly before the refetch resolves.
  const seed = makeClient("cache-only");
  expect(await seed.query.users(["name"])).toEqual([
    { name: "Alice1" },
    { name: "Alice2" },
  ]);
  expect(state.calls).toBe(1);

  // The seeded list reflects entity updates from elsewhere, so it is never
  // stale per-entity: a mutation to User:1 shows up in the cached list.
  await network.mutation.createUser(["name"], { name: "x", email: "y" });
  expect(state.calls).toBe(2);
  expect(await seed.query.users(["name"])).toEqual([
    { name: "UPDATED" },
    { name: "Alice2" },
  ]);
  expect(state.calls).toBe(2);
});

test("caches scalar roots", async () => {
  const { makeClient, state } = await setup();
  const client = makeClient();

  expect(await client.query.userCount()).toBe(42);
  expect(await client.query.userCount()).toBe(42);
  expect(state.calls).toBe(1);
});

test("caches null results", async () => {
  const { makeClient, state } = await setup();
  const client = makeClient();

  expect(await client.query.user(["name"], { id: "missing" })).toBeNull();
  expect(await client.query.user(["name"], { id: "missing" })).toBeNull();
  expect(state.calls).toBe(1);
});

test("interface fields merge shared fields with the matched $on fragment", async () => {
  const { makeClient, state } = await setup();
  const client = makeClient();

  const selection = [
    "title",
    {
      $on: {
        TrainingEventGQL: ["trainer"],
        RegularEventGQL: ["location"],
      },
    },
  ] as const;

  // The shared `title` field must survive alongside the type-specific
  // `trainer` field matched by `$on` via `__typename`, not just one or the
  // other.
  expect(await client.query.event(selection, { id: "e1" })).toEqual({
    title: "Onboarding",
    trainer: "Bob",
  });
  expect(state.calls).toBe(1);

  // Both were merged onto the same TrainingEventGQL:e1 entity, so this is a hit.
  await client.query.event(selection, { id: "e1" });
  expect(state.calls).toBe(1);
});

test("normalizes and caches unions, keeping the discriminant", async () => {
  const { makeClient, state } = await setup();
  const client = makeClient();

  const feed = await client.query.feed([
    "__typename",
    { $on: { Post: ["content"], Comment: ["content"] } },
  ]);
  expect(feed).toEqual([
    { __typename: "Post", content: "hello" },
    { __typename: "Comment", content: "world" },
  ]);
  expect(state.calls).toBe(1);

  // Same selection again: served from the normalized cache.
  await client.query.feed([
    "__typename",
    { $on: { Post: ["content"], Comment: ["content"] } },
  ]);
  expect(state.calls).toBe(1);
});

test("propagates mutation results to already-cached queries", async () => {
  const { makeClient, state } = await setup();
  const client = makeClient();

  await client.query.users(["name", "email"]);
  const afterList = state.calls;

  // Mutation returns User:1 with an updated name; it must hit the network.
  await client.mutation.createUser(["name"], { name: "x", email: "y" });
  expect(state.calls).toBe(afterList + 1);

  // The cached `users` query now reflects the updated entity, no refetch.
  const relisted = await client.query.users(["name", "email"]);
  expect(state.calls).toBe(afterList + 1);
  expect(relisted[0]).toEqual({ name: "UPDATED", email: "a1@x" });
  expect(relisted[1]).toEqual({ name: "Alice2", email: "a2@x" });
});

test("network-only writes to the cache without reading it", async () => {
  const { makeClient, state } = await setup();
  const networkOnly = makeClient("network-only");

  await networkOnly.query.user(["name"], { id: "1" });
  await networkOnly.query.user(["name"], { id: "1" });
  expect(state.calls).toBe(2); // always fetches

  // A cache-first client sees what network-only wrote.
  const cacheFirst = makeClient("cache-first");
  expect(await cacheFirst.query.user(["name"], { id: "1" })).toEqual({
    name: "Alice1",
  });
  expect(state.calls).toBe(2);
});

test("no-cache never reads or writes", async () => {
  const { makeClient, state } = await setup();
  const noCache = makeClient("no-cache");

  await noCache.query.user(["name"], { id: "1" });
  await noCache.query.user(["name"], { id: "1" });
  expect(state.calls).toBe(2);

  // Nothing was written, so a cache-first client still has to fetch.
  const cacheFirst = makeClient("cache-first");
  await cacheFirst.query.user(["name"], { id: "1" });
  expect(state.calls).toBe(3);
});

test("cache-only throws when nothing is cached", async () => {
  const { makeClient } = await setup();
  const cacheOnly = makeClient("cache-only");

  await expect(cacheOnly.query.user(["name"], { id: "1" })).rejects.toThrow(
    /cache-only/,
  );
});
