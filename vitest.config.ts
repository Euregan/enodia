import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    watchExclude: [
      ...configDefaults.watchExclude,
      "**/generated-tests-files/**",
    ],
  },
});
