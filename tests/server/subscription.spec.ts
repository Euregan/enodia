import { beforeAll, expect, test, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import schemaToServer from "../../src/server";
import { parse } from "graphql";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createServer } from "node:http";
import * as ws from "ws";

vi.mock("ws");

type TestSocket = {
  send: (payload: any) => Promise<void>;
};

beforeAll(async () => {
  await writeFile(
    "./tests/server/subscription.server.ts",
    schemaToServer(
      parse(await readFile("./tests/server/subscription.graphql", "utf-8")),
      { scalarTypes: {} }
    )
  );
});

test("Regular queries work properly", async () => {
  const { server } = await import("./subscription.server.ts");

  const users: Array<{ id: string; name: string }> = [];

  const { http } = server({})({
    User: {},
  })({
    Query: {
      users: () => users,
    },
    Mutation: {
      createUser: async ({ user }) => {
        const createdUser = { id: randomUUID(), name: user.name };
        users.push(createdUser);

        return createdUser;
      },
    },
    Subscription: {
      users: () => users,
    },
  });

  const response = await request(
    createServer(async (request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      await http(request, response);
    })
  )
    .post("/")
    .send({
      query: "query Users { users { id, name } }",
    });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ data: { users: [] } });
});

test("properly sends updates", async () => {
  let connect: () => TestSocket = () => ({ send: () => Promise.resolve() });

  const onQuery = vi.fn();

  vi.spyOn(ws, "WebSocketServer").mockImplementation(
    // @ts-expect-error We don't mock the whole WebSocketServer interface
    () => {
      const serverListeners: Record<string, (socket: any) => void> = {};

      connect = () => {
        if (serverListeners.connection) {
          const listeners: Record<string, (payload: string) => void> = {};
          const messagesListeners = new Map<string, (payload: any) => void>([
            ["query", onQuery],
          ]);

          const socket = {
            on: (event: string, callback: (payload: string) => void) => {
              listeners[event] = callback;
            },
            send: (data: string) => {
              const message = JSON.parse(data);
              messagesListeners.get(message.type)?.(message);
            },
          };

          serverListeners.connection(socket);

          return {
            send: async (payload: any) =>
              new Promise((resolve) => {
                switch (payload.type) {
                  case "init":
                    messagesListeners.set("initialized", () => {
                      resolve();
                      messagesListeners.delete("initialized");
                    });
                    break;
                  case "subscribe":
                    messagesListeners.set("subscribed", () => {
                      resolve();
                      messagesListeners.delete("subscribed");
                    });
                    break;
                  case "unsubscribe":
                    messagesListeners.set("unsubscribed", () => {
                      resolve();
                      messagesListeners.delete("unsubscribed");
                    });
                    break;
                }

                if (listeners.message) {
                  listeners.message(JSON.stringify(payload));
                }
              }),
          };
        }

        return { send: () => Promise.resolve() };
      };

      return {
        on: (event: string, callback: (socket: TestSocket) => void) => {
          serverListeners[event] = callback;
        },
      };
    }
  );

  const { server } = await import("./subscription.server.ts");

  const users: Array<{ id: string; name: string }> = [];

  const { websocket, http } = server({})({
    User: {},
  })({
    Query: {
      users: () => users,
    },
    Mutation: {
      createUser: async ({ user }) => {
        const createdUser = { id: randomUUID(), name: user.name };
        users.push(createdUser);

        await broadcast([{ entity: "User" }]);

        return createdUser;
      },
    },
    Subscription: {
      users: () => users,
    },
  });

  const broadcast = websocket(3000);

  const queryId = randomUUID();

  const socket = connect();
  await socket.send({ type: "init" });
  await socket.send({
    type: "subscribe",
    id: queryId,
    query: "subscription Users { users { id, name } }",
  });

  // Dirty hack to make sure the query message is sent before we assert that it has been sent
  await new Promise((resolve) => setTimeout(resolve));

  expect(onQuery).toBeCalledTimes(1);
  expect(onQuery).toHaveBeenNthCalledWith(1, {
    id: queryId,
    result: { data: { users: [] } },
    type: "query",
  });

  const response = await request(
    createServer(async (request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      await http(request, response);
    })
  )
    .post("/")
    .send({
      query:
        'mutation CreateUser { createUser(user:{name: "Test user"}) { id, name } }',
    });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    data: { createUser: { id: expect.any(String), name: "Test user" } },
  });

  expect(onQuery).toBeCalledTimes(2);
  expect(onQuery).toHaveBeenNthCalledWith(2, {
    id: queryId,
    result: {
      data: { users: [{ id: expect.any(String), name: "Test user" }] },
    },
    type: "query",
  });
});

test("rejects malformed queries");

test("rejects non subscription queries");
