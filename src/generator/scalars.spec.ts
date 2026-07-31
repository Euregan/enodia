import { expect, test } from "vitest";
import fs from "fs/promises";
import { gql } from "graphql-tag";
import ts from "typescript";
import { extractScalarTypes, renderScalarImports } from "./scalars.ts";
import schemaToWeb from "../web.ts";

test("scalar types declared locally in the config (not imported) are copied into the generated client", async () => {
  await fs.mkdir("./generated-tests-files", { recursive: true });

  const configPath = "./generated-tests-files/localScalarConfig.ts";
  await fs.writeFile(
    configPath,
    `
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

export default defineConfig({
  schema: "",
  client: { path: "./client.ts" },
  scalars: {
    JSON: scalar<Json>(),
    JSONObject: scalar<JsonObject>(),
  },
});
`,
  );

  const scalarTypes = extractScalarTypes(configPath);
  const outputPath = "./generated-tests-files/localScalarTypes.ts";

  const client = schemaToWeb(
    gql`
      scalar JSON
      scalar JSONObject

      type Settings {
        id: ID!
        data: JSON
        metadata: JSONObject
        parent: Settings
      }

      type Query {
        settings: Settings
      }
    `,
    {
      scalarTypes,
      scalarImports: renderScalarImports(scalarTypes, configPath, outputPath),
      withReact: { url: "http://localhost:3000/graphql" },
    },
  );

  await fs.writeFile(outputPath, client);

  const program = ts.createProgram({
    options: {
      noEmit: true,
      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noFallthroughCasesInSwitch: true,
    },
    rootNames: [outputPath],
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
