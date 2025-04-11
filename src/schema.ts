import { z } from "zod";
import fetcher from "./fetcher.ts";
import { readFile } from "node:fs/promises";
import { DocumentNode, parse } from "graphql";
import { resolve } from "node:path";

export const schemaConfigSchema = z.union([
  z.string(),
  z.object({
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
    saveToFile: z.string(),
    useLocalFile: z.boolean(),
  }),
  z.object({
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
  }),
]);

type SchemaConfig = z.infer<typeof schemaConfigSchema>;

export const getSchema = async (
  schema: SchemaConfig
): Promise<DocumentNode> => {
  if (typeof schema === "string") {
    return schema.startsWith("http")
      ? fetcher(schema)
      : parse(await readFile(schema, "utf-8"));
  }

  if ("useLocalFile" in schema && schema.useLocalFile) {
    console.log(
      "  Using local cache available from",
      resolve(schema.saveToFile)
    );
    // TODO: Handle missing file
    return parse(await readFile(schema.saveToFile, "utf-8"));
  }

  return fetcher(schema.url, schema.headers);
};
