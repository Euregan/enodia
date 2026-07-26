import { z } from "zod";
import { schemaConfigSchema } from "./schema.ts";

export type ScalarType<T> = { readonly __scalar?: T };

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

type Wire<W> = unknown extends W ? W : [W] extends [Json] ? W : never;

export type Codec<T, W> = {
  encode: (value: T) => Wire<W>;
  decode: (value: Wire<W>) => T;
};

export const scalar = <T, W = unknown>(
  ..._codec: T extends Json ? [codec?: Codec<T, W>] : [codec: Codec<T, W>]
): ScalarType<T> => ({});

export const configSchema = z.object({
  schema: schemaConfigSchema,
  client: z
    .object({
      path: z.string(),
      fetchPolicy: z
        .enum([
          "cache-first",
          "network-only",
          "no-cache",
          "cache-only",
          "cache-and-network",
        ])
        .optional(),
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
