import ts from "typescript";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { ImportBinding, ScalarTypeInfo } from "../types.ts";

const importBindings = (source: ts.SourceFile): Map<string, ImportBinding> => {
  const bindings = new Map<string, ImportBinding>();
  source.forEachChild((node) => {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier)
    ) {
      return;
    }
    const specifier = node.moduleSpecifier.text;
    const clause = node.importClause;
    if (clause?.name) {
      bindings.set(clause.name.text, {
        name: clause.name.text,
        isDefault: true,
        specifier,
      });
    }
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        bindings.set(element.name.text, {
          name: element.name.text,
          isDefault: false,
          specifier,
        });
      }
    }
  });
  return bindings;
};

const scalarsObjectLiteral = (
  source: ts.SourceFile,
): ts.ObjectLiteralExpression | null => {
  let scalars: ts.ObjectLiteralExpression | null = null;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "defineConfig" &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      for (const property of node.arguments[0].properties) {
        if (
          ts.isPropertyAssignment(property) &&
          property.name.getText(source) === "scalars" &&
          ts.isObjectLiteralExpression(property.initializer)
        ) {
          scalars = property.initializer;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return scalars;
};

const referencedTypeNames = (typeNode: ts.TypeNode): Array<string> => {
  const names: Array<string> = [];
  const visit = (node: ts.Node) => {
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      names.push(node.typeName.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(typeNode);
  return names;
};

export const extractScalarTypes = (
  configPath: string,
): Record<string, ScalarTypeInfo> => {
  const source = ts.createSourceFile(
    configPath,
    readFileSync(configPath, "utf-8"),
    ts.ScriptTarget.Latest,
    true,
  );

  const scalars = scalarsObjectLiteral(source);
  if (!scalars) {
    return {};
  }

  const bindings = importBindings(source);
  const scalarTypes: Record<string, ScalarTypeInfo> = {};

  for (const property of scalars.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const name = property.name.getText(source).replace(/^["']|["']$/g, "");
    const call = property.initializer;
    if (!ts.isCallExpression(call) || !call.typeArguments?.[0]) {
      throw `Scalar ${name} must be declared with scalar<YourType>().`;
    }
    const typeNode = call.typeArguments[0];
    scalarTypes[name] = {
      type: typeNode.getText(source),
      imports: [
        ...new Map(
          referencedTypeNames(typeNode)
            .map((referenced) => bindings.get(referenced))
            .filter(
              (binding): binding is ImportBinding => binding !== undefined,
            )
            .map((binding) => [
              `${binding.specifier}#${binding.name}`,
              binding,
            ]),
        ).values(),
      ],
    };
  }

  return scalarTypes;
};

const rewriteSpecifier = (
  specifier: string,
  configPath: string,
  outputPath: string,
): string => {
  if (!specifier.startsWith(".")) {
    return specifier;
  }
  const rewritten = relative(
    dirname(outputPath),
    resolve(dirname(configPath), specifier),
  ).replaceAll("\\", "/");
  return rewritten.startsWith(".") ? rewritten : `./${rewritten}`;
};

export const renderScalarImports = (
  scalarTypes: Record<string, ScalarTypeInfo>,
  configPath: string,
  outputPath: string,
): string => {
  const bySpecifier = new Map<
    string,
    { named: Set<string>; defaults: Set<string> }
  >();

  for (const { imports } of Object.values(scalarTypes)) {
    for (const binding of imports) {
      const specifier = rewriteSpecifier(
        binding.specifier,
        configPath,
        outputPath,
      );
      const group = bySpecifier.get(specifier) || {
        named: new Set<string>(),
        defaults: new Set<string>(),
      };
      (binding.isDefault ? group.defaults : group.named).add(binding.name);
      bySpecifier.set(specifier, group);
    }
  }

  return [...bySpecifier.entries()]
    .flatMap(([specifier, { named, defaults }]) =>
      [
        ...[...defaults].map(
          (name) => `import type ${name} from "${specifier}";`,
        ),
        named.size > 0
          ? `import type { ${[...named].join(", ")} } from "${specifier}";`
          : null,
      ].filter((line): line is string => line !== null),
    )
    .join("\n");
};
