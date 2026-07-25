export type GqlScalarToTs = { gql: string; ts: string };

export type ImportBinding = {
  name: string;
  isDefault: boolean;
  specifier: string;
};

export type ScalarTypeInfo = {
  type: string;
  imports: Array<ImportBinding>;
};
