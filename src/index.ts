#!/usr/bin/env -S npx tsx

import { access, readFile, writeFile } from "node:fs/promises";
import path, { resolve } from "node:path";
import { parse, print } from "graphql";
import z from "zod";
import schemaToClient from "./web.ts";
import fetcher from "./fetcher.ts";
import schemaToServer from "./server.ts";
import prompts from "prompts";
import { getCustomScalars } from "./generator/helpers.ts";
import { getSchema, schemaConfigSchema } from "./schema.ts";

const configSchema = z.object({
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
      ])
    )
    .optional(),
});

const configPath = path.resolve("./enodia.config.ts");

const configExists = await access(configPath)
  .then(() => true)
  .catch(() => false);

// If the configuration file doesn't exist, we offer the user to initialize it
if (!configExists) {
  const { initialize } = await prompts({
    type: "confirm",
    name: "initialize",
    message: `There doesn't seem to be a configuration file at ${configPath}, do you want to initialize it?`,
    onRender(kleur) {
      // @ts-expect-error The type is wrong :(
      this.msg =
        kleur.reset("There doesn't seem to be a configuration file at ") +
        kleur.bold(configPath) +
        kleur.reset(", do you want to initialize it?");
    },
    validate: (value) => (value < 18 ? `Nightclub is 18+ only` : true),
  });

  if (!initialize) {
    console.error(
      "Enodia cannot run without a configuration file. Either re-run the CLI and follow the steps to initialize it, or create it manually."
    );
    process.exit(1);
  }

  // /home/valentin/projects/graphql-static/schema.graphql
  const { schemaLocation } = await prompts({
    type: "text",
    name: "schemaLocation",
    message:
      "Where is you GraphQL schema located? It can be a path to the .graphql file, or a URL to the running server.",
    onRender(kleur) {
      // @ts-expect-error The type is wrong :(
      this.msg = kleur.reset(
        "Where is you GraphQL schema located? It can be a path to the .graphql file, or a URL to the running server."
      );
    },
    validate: (location) =>
      location.startsWith("http")
        ? // TODO: Check that the URL returns a 200
          true
        : access(location)
            .then(() => true)
            .catch(() => `No file was found at ${location}`),
  });

  const schema = schemaLocation.startsWith("http")
    ? await fetcher(schemaLocation, {})
    : parse(await readFile(schemaLocation, "utf-8"));

  const customScalars = getCustomScalars(schema);

  const scalarTypes: Array<[string, string]> = [];
  for (const scalar of customScalars) {
    const { type } = await prompts({
      type: "text",
      name: "type",
      message: `Please specify a Typescript type that should correspond to the ${scalar.name.value} scalar. It can be any Typescript type, including any, unknown, etc.`,
      onRender(kleur) {
        // @ts-expect-error The type is wrong :(
        this.msg =
          kleur.reset(
            "Please specify a Typescript type that should correspond to the "
          ) +
          kleur.bold(scalar.name.value) +
          kleur.reset(
            " scalar. It can be any Typescript type, including any, unknown, etc."
          );
      },
      // TODO: Handle user defined types with their import
      // TODO: Validate that the provided type is correct
    });

    scalarTypes.push([scalar.name.value, type]);
  }

  const { server } = await prompts({
    type: "text",
    name: "server",
    message: `Please specify the path for the server file.`,
    onRender(kleur) {
      // @ts-expect-error The type is wrong :(
      this.msg = kleur.reset("Please specify the path for the server file.");
    },
  });

  const { client } = await prompts({
    type: "text",
    name: "client",
    message: `Please specify the path for the client file.`,
    onRender(kleur) {
      // @ts-expect-error The type is wrong :(
      this.msg = kleur.reset("Please specify the path for the client file.");
    },
  });

  await writeFile(
    configPath,
    [
      "const config = {",
      `  input: "${schemaLocation}",`,
      `  client: "${client}",`,
      `  server: "${server}",`,
      ...(scalarTypes.length > 0
        ? [`  scalarTypes: {`]
            .concat(
              scalarTypes.map(
                ([graphql, typescript]) =>
                  `    ${graphql}: { name: "${typescript}" },`
              )
            )
            .concat(["  }"])
        : [""]),
      "};",
      "export default config;",
    ]
      .filter((line) => line.trim())
      .join("\n")
  );
}

// TODO: Handle missing config file
// TODO: Make sure args are JSON serializable
const rawConfig = (await import(configPath)).default;

const validatedConfig = configSchema.safeParse(rawConfig);

if (!validatedConfig.success) {
  console.log("Your configuration file is not valid:");
  console.log(validatedConfig.error);
  process.exit(1);
}

const config = validatedConfig.data;

console.log("- Fetching schema");
const schema = await getSchema(config.schema);
console.log("✓ Fetched schema");

if (
  typeof config.schema === "object" &&
  "saveToFile" in config.schema &&
  !config.schema.useLocalFile
) {
  console.log("- Saving schema to a local file");
  await writeFile(config.schema.saveToFile, print(schema), "utf-8");
  console.log("✓ Saved schema to", resolve(config.schema.saveToFile));
}

if (config.client) {
  console.log("- Writing client");
  await writeFile(
    config.client.path,
    schemaToClient(schema, {
      scalarTypes: config.scalars || {},
      withReact: config.client.react,
    })
  );
  console.log("✓ Wrote client");
}

if (config.server) {
  console.log("- Writing server");
  await writeFile(
    config.server.path,
    schemaToServer(schema, {
      scalarTypes: config.scalars || {},
    })
  );
  console.log("✓ Wrote server");
}
