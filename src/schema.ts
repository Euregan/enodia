import { z } from "zod";
import fetcher from "./fetcher.ts";
import { readFile } from "node:fs/promises";
import { DocumentNode, parse } from "graphql";

export const schemaConfigSchema = z.union([
  z.string(),
  z.object({
    url: z.string().url(),
    headers: z.record(z.string()),
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

  return fetcher(schema.url, schema.headers);
};
