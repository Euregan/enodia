import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    watchExclude: [
      ...configDefaults.watchExclude,
      "**/generated-tests-files/**",
    ],
    // Without this, `graphql-ws`'s server adapter (used inside dynamically
    // imported generated fixtures) and its client entry (imported statically
    // by the test file) can each resolve their own bundled copy of `graphql`,
    // so a `GraphQLSchema` built in one fails `instanceof` checks in the
    // other ("Cannot use GraphQLSchema from another module or realm").
    // Inlining keeps every import of these on the same module instance.
    server: {
      deps: {
        inline: ["graphql", "graphql-ws", "ws"],
      },
    },
  },
});
