import { readFile } from "fs/promises";
import { gql } from "graphql-tag";
import ts from "typescript";
import { schemaToTypes } from "./types.ts";
import { schemaToClient } from "./client.ts";

console.clear();

const schemaPath = "./src/schema.graphql";

const schema = gql(await readFile(schemaPath, "utf-8"));

const file = ts.createSourceFile(
  "client.ts",
  "",
  ts.ScriptTarget.ESNext,
  false,
  ts.ScriptKind.TS
);

const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

console.log("// TYPES");
console.log(printer.printList(0, schemaToTypes(schema), file));

console.log();
console.log("// CLIENT");
console.log(printer.printList(0, schemaToClient(schema), file));