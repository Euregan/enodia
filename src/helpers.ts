import ts, {
  ConciseBody,
  Expression,
  Node,
  ObjectLiteralExpression,
  ParameterDeclaration,
  StringLiteral,
  TemplateExpression,
  TemplateMiddle,
  TemplateSpan,
  TemplateTail,
  isExpression,
} from "typescript";

type Scalar = string;

export const createScalarLiteralExpression = (value: Scalar) =>
  ts.factory.createStringLiteral(value);

type Object = {
  [K in string]: Scalar | Object | Expression;
};

// TODO: Clean up this dirty hack
const isTsNode = (object: unknown): object is Node => true;

export const createObjectLiteralExpression = (
  object: Object
): ObjectLiteralExpression =>
  ts.factory.createObjectLiteralExpression(
    Object.entries(object).map(([key, value]) =>
      ts.factory.createPropertyAssignment(
        key,
        typeof value === "object"
          ? isTsNode(value) && isExpression(value)
            ? value
            : createObjectLiteralExpression(value)
          : createScalarLiteralExpression(value)
      )
    ),
    true
  );

export const createParameterDeclaration = (name: string, type: string) =>
  ts.factory.createParameterDeclaration(
    undefined,
    undefined,
    name,
    undefined,
    ts.factory.createTypeReferenceNode(type)
  );

export const createArrowFunction = (
  parameters: Array<ParameterDeclaration>,
  body: ConciseBody
) =>
  ts.factory.createArrowFunction(
    undefined,
    undefined,
    parameters,
    undefined,
    undefined,
    body
  );

export const createVariableDeclaration = (
  name: string,
  expression: Expression
) =>
  ts.factory.createVariableDeclarationList(
    [
      ts.factory.createVariableDeclaration(
        name,
        undefined,
        undefined,
        expression
      ),
    ],
    ts.NodeFlags.Const
  );

export const createCallExpression = (
  name: string,
  parameters: Array<Expression | string>
) =>
  ts.factory.createCallExpression(
    ts.factory.createIdentifier(name),
    undefined,
    parameters.map((parameter) =>
      typeof parameter === "string"
        ? ts.factory.createIdentifier(parameter)
        : parameter
    )
  );
