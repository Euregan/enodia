import { z } from "zod";
import { schemaConfigSchema } from "./schema.ts";

export type ScalarType<T> = { readonly __scalar?: T };

export const scalar = <T>(): ScalarType<T> => ({});

export const configSchema = z.object({
  schema: schemaConfigSchema,
  client: z
    .object({
      path: z.string(),
      react: z
        .object({
          url: z.string(),
        })
        .optional(),
    })
    .optional(),
  server: z
    .object({
      path: z.string(),
    })
    .optional(),
  cli: z
    .object({
      path: z.string(),
    })
    .optional(),
  scalars: z.record(z.custom<ScalarType<unknown>>()).optional(),
});

export type Config = z.infer<typeof configSchema>;

export const defineConfig = (config: Config): Config => config;
