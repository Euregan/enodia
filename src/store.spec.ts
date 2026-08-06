import fs from "fs/promises";
import { gql } from "graphql-tag";
import { expect, test, vi } from "vitest";
import schemaToWeb from "./web.js";

type FetchPolicy = "cache-first" | "network-only" | "no-cache" | "cache-only";

// Stands in for `graphql-ws`'s real WebSocket transport: `subscribe()` calls
// `createClient(...).subscribe(payload, sink)`, so capturing every `sink` lets
// a test simulate a server event with `sink.next(...)` without a real socket.
const graphqlWsMock = vi.hoisted(() => {
  const subscriptions: Array<{
    payload: { query: string; variables?: Record<string, unknown> };
    sink: {
      next: (value: unknown) => void;
      error: (error: unknown) => void;
      complete: () => void;
    };
  }> = [];

  return {
    subscriptions,
    createClient: vi.fn(() => ({
      // Mirrors a real transport: the returned cleanup function detaches the
      // operation, so a message that arrives for it afterwards has nowhere to
      // be delivered - the same guarantee `graphql-ws` gives on unsubscribe.
      subscribe: (payload: unknown, sink: unknown) => {
        const entry = {
          payload: payload as { query: string },
          sink: sink as (typeof subscriptions)[number]["sink"],
        };
        subscriptions.push(entry);
        return () => {
          const index = subscriptions.indexOf(entry);
          if (index !== -1) subscriptions.splice(index, 1);
        };
      },
      dispose: async () => {},
    })),
  };
});

vi.mock("graphql-ws", () => ({ createClient: graphqlWsMock.createClient }));

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
      type Subscription {
        userUpdated(id: ID!): User!
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

  graphqlWsMock.subscriptions.length = 0;
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

  return { makeClient, state, enodia };
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

test("a subscription event writes into the shared cache, updating an already-cached query", async () => {
  const { makeClient, state } = await setup();
  const client = makeClient();

  await client.query.user(["name"], { id: "1" });
  expect(state.calls).toBe(1);

  const received: Array<unknown> = [];
  client.subscription.userUpdated(
    ["name", "email"],
    { id: "1" },
    { onData: (data: unknown) => received.push(data) },
  );

  expect(graphqlWsMock.subscriptions).toHaveLength(1);
  const { sink } = graphqlWsMock.subscriptions[0];
  sink.next({
    data: {
      userUpdated: {
        __typename: "User",
        id: "1",
        name: "Bob",
        email: "b1@x",
      },
    },
  });

  expect(received).toEqual([{ name: "Bob", email: "b1@x" }]);

  // The entity was updated via the subscription, not a new fetch, so a
  // cache-first read of the same query sees it without hitting the network.
  expect(await client.query.user(["name", "email"], { id: "1" })).toEqual({
    name: "Bob",
    email: "b1@x",
  });
  expect(state.calls).toBe(1);
});

test("a subscription's onError fires when the transport reports an error", async () => {
  const { makeClient } = await setup();
  const client = makeClient();

  const errors: Array<unknown> = [];
  client.subscription.userUpdated(["name"], { id: "1" }, {
    onData: () => {},
    onError: (error: unknown) => errors.push(error),
  });

  const { sink } = graphqlWsMock.subscriptions[0];
  const transportError = new Error("connection lost");
  sink.error(transportError);

  // Error$ is a real Error everywhere it's surfaced to a consumer - a
  // consumer can rely on instanceof/.message regardless of whether the
  // underlying transport handed onError an Error, a GraphQL error array, or
  // a CloseEvent. An Error that arrives as one is kept as-is (identity and
  // stack preserved), not rebuilt into a lookalike.
  expect(errors).toEqual([transportError]);
  expect(errors[0]).toBe(transportError);
});

test("a subscription's onError extracts the reason from a WebSocket CloseEvent", async () => {
  const { makeClient } = await setup();
  const client = makeClient();

  const errors: Array<unknown> = [];
  client.subscription.userUpdated(["name"], { id: "1" }, {
    onData: () => {},
    onError: (error: unknown) => errors.push(error),
  });

  const { sink } = graphqlWsMock.subscriptions[0];
  // graphql-ws intentionally types Sink.error()'s argument as `unknown` since
  // it can also be a bare CloseEvent (no `message`, only `code`/`reason`) -
  // it avoids bundling DOM typings for a client that also runs in Node.
  sink.error({ code: 4401, reason: "Unauthorized", wasClean: false });

  expect(errors).toEqual([new Error("Unauthorized")]);
});

test("a subscription's onError falls back to the close code when a CloseEvent has no reason", async () => {
  const { makeClient } = await setup();
  const client = makeClient();

  const errors: Array<unknown> = [];
  client.subscription.userUpdated(["name"], { id: "1" }, {
    onData: () => {},
    onError: (error: unknown) => errors.push(error),
  });

  const { sink } = graphqlWsMock.subscriptions[0];
  sink.error({ code: 1006, reason: "", wasClean: false });

  expect(errors).toEqual([new Error("Connection closed (code 1006)")]);
});

test("a query rejects with a real Error when the response carries GraphQL errors", async () => {
  const { enodia } = await setup();
  const client = enodia("http://localhost/graphql", {
    fetchPolicy: "network-only",
    // @ts-expect-error the generated fetch stub only needs .json()
    fetch: async () => ({
      json: async () => ({
        errors: [{ message: "relation \"graphile_worker.jobs\" does not exist" }],
        data: null,
      }),
    }),
  });

  await expect(client.query.user(["name"], { id: "1" })).rejects.toEqual(
    new Error('relation "graphile_worker.jobs" does not exist'),
  );
});

test("subscribe() sends a subscription operation for the field being subscribed to", async () => {
  const { makeClient } = await setup();
  const client = makeClient();

  client.subscription.userUpdated(["name"], { id: "1" }, { onData: () => {} });

  const { payload } = graphqlWsMock.subscriptions[0];
  expect(payload.query).toContain("subscription userUpdated");
  expect(payload.query).toContain("name");
});

test("unsubscribing detaches from the transport, so a later event has no callback to reach", async () => {
  const { makeClient } = await setup();
  const client = makeClient();

  const received: Array<unknown> = [];
  const unsubscribe = client.subscription.userUpdated(
    ["name"],
    { id: "1" },
    { onData: (data: unknown) => received.push(data) },
  );

  expect(graphqlWsMock.subscriptions).toHaveLength(1);

  unsubscribe();

  // Enodia's client hands back exactly what the transport's `subscribe()`
  // returned, uncalled, until now - calling it is what makes the transport
  // forget the operation. Whether a later server message actually reaches
  // `onData` is the transport's job from here (it won't call a sink for an
  // operation it no longer tracks), not something Enodia enforces itself -
  // this asserts Enodia correctly triggers that forgetting.
  expect(graphqlWsMock.subscriptions).toHaveLength(0);
  expect(received).toEqual([]);
});
