import {
  DocumentNode,
  getIntrospectionQuery,
  buildClientSchema,
  printSchema,
  parse,
} from "graphql";

const fetcher = async (
  url: string,
  headers: Record<string, string> = {}
): Promise<DocumentNode> => {
  // @ts-expect-error The types for node don't include fetch https://github.com/DefinitelyTyped/DefinitelyTyped/issues/60924
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ query: getIntrospectionQuery() }),
  });

  const result = await response.json();

  if (!response.ok) {
    // TODO: Handle errors at the CLI level to avoid having to stringify
    throw JSON.stringify(result, null, 2);
  }

  const schema = buildClientSchema(result.data);

  return parse(printSchema(schema));
};

export default fetcher;
