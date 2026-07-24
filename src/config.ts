import { z } from "zod";
import { schemaConfigSchema } from "./schema.ts";

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
  scalars: z
    .record(
      z.union([
        z.object({
          path: z.string(),
          name: z.string().optional(),
        }),
        z.object({
          name: z.string(),
        }),
      ]),
    )
    .optional(),
});

export type Config = z.infer<typeof configSchema>;

export const defineConfig = (config: Config): Config => config;
