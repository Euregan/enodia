export type FetchPolicy =
  | "cache-first"
  | "network-only"
  | "no-cache"
  | "cache-only";

export type HookFetchPolicy = FetchPolicy | "cache-and-network";

export type GqlScalarToTs = {
  gql: string;
  ts: string;
  encode?: string;
  decode?: string;
};

export type ImportBinding = {
  name: string;
  isDefault: boolean;
  specifier: string;
  typeOnly: boolean;
};

export type LocalTypeDeclaration = {
  name: string;
  text: string;
};

export type ScalarTypeInfo = {
  type: string;
  encode?: string;
  decode?: string;
  imports: Array<ImportBinding>;
  localTypes?: Array<LocalTypeDeclaration>;
};
