import { useState, useEffect } from "react";
import client from "./client";

function App() {
  const [result, setResult] = useState<null | unknown>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!loading) {
      // https://github.com/tcgdex/cards-database/blob/master/meta/definitions/graphql.gql
      const graphql = client("https://api.tcgdex.net/v2/graphql");
      setLoading(true);

      graphql.query
        .cards(["category", "description", "name", { set: ["name"] }])
        .then((data: unknown) => setResult(data))
        .finally(() => setLoading(false));
    }
  }, []);

  return loading ? (
    "Loading"
  ) : (
    <code>
      <pre>{JSON.stringify(result, null, 2)}</pre>
    </code>
  );
}

export default App;
