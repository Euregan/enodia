import ts, {
  ConciseBody,
  Expression,
  Node,
  ObjectLiteralExpression,
  ParameterDeclaration,
  SyntaxKind,
  TypeLiteralNode,
  TypeNode,
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
        ts.factory.createStringLiteral(key),
        typeof value === "object"
          ? isTsNode(value) && isExpression(value)
            ? value
            : createObjectLiteralExpression(value)
          : createScalarLiteralExpression(value)
      )
    ),
    true
  );

export const createParameterDeclaration = (
  name: string,
  type?: string | TypeLiteralNode,
  optional: boolean = false
) =>
  ts.factory.createParameterDeclaration(
    undefined,
    undefined,
    name,
    optional ? ts.factory.createToken(SyntaxKind.QuestionToken) : undefined,
    typeof type === "string" ? ts.factory.createTypeReferenceNode(type) : type
  );

export const createArrowFunction = (
  parameters: Array<ParameterDeclaration>,
  body: ConciseBody,
  returnType?: TypeNode
) =>
  ts.factory.createArrowFunction(
    undefined,
    undefined,
    parameters,
    returnType,
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
  name: string | Expression,
  parameters: Array<Expression | string>
) =>
  ts.factory.createCallExpression(
    typeof name === "string" ? ts.factory.createIdentifier(name) : name,
    undefined,
    parameters.map((parameter) =>
      typeof parameter === "string"
        ? ts.factory.createIdentifier(parameter)
        : parameter
    )
  );
