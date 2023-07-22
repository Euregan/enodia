import { readFile, writeFile } from "fs/promises";
import { gql } from "graphql-tag";
import ts from "typescript";
import { schemaToClient } from "./client.ts";

console.clear();

const [, , input, output] = process.argv;

console.log("- Fetching schema");
const schema = gql(
  await (input.startsWith("http")
    ? fetch(input).then((response) => response.text())
    : readFile(input, "utf-8"))
);
console.log("✓ Fetched schema");

const file = ts.createSourceFile(
  "client.ts",
  "",
  ts.ScriptTarget.ESNext,
  false,
  ts.ScriptKind.TS
);

const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

console.log("- Writing client");
await writeFile(
  output,
  printer.printList(ts.ListFormat.MultiLine, schemaToClient(schema), file)
);
console.log("✓ Wrote client");
