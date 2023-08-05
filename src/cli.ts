import { readFile, writeFile } from "fs/promises";
import path from "path";
import { gql } from "graphql-tag";
import schemaToClient, { ScalarType } from "./client";

console.clear();

const [, , input, output] = process.argv;

// TODO: Handle missing config file
// TODO: Validate the config with zod
const config = (await import(path.resolve("./enodia.config.ts"))).default;

console.log("- Fetching schema");
const schema = gql(
  await (input.startsWith("http")
    ? // @ts-ignore The types for node don't include fetch :(
      fetch(input).then((response) => response.text())
    : readFile(input, "utf-8"))
);
console.log("✓ Fetched schema");

// TODO: Verify that the file actually exist, and that they do export the specified type
const resolvedImports = Object.fromEntries(
  Object.entries((config.scalarTypes || {}) as Record<string, ScalarType>).map(
    ([gqlType, imp]) =>
      "path" in imp
        ? [
            gqlType,
            {
              // We go back one level because output points to the file output
              path: path.relative(path.resolve(output, ".."), imp.path),
              name: imp.name,
            },
          ]
        : [gqlType, imp]
  )
);

console.log("- Writing client");
await writeFile(
  output,
  schemaToClient(schema, { scalarTypes: resolvedImports })
);
console.log("✓ Wrote client");
