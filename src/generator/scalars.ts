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
        typeOnly: clause.isTypeOnly,
      });
    }
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        bindings.set(element.name.text, {
          name: element.name.text,
          isDefault: false,
          specifier,
          typeOnly: clause.isTypeOnly || element.isTypeOnly,
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

const isDeclarationOrPropertyName = (identifier: ts.Identifier): boolean => {
  const parent = identifier.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
    (ts.isPropertyAssignment(parent) && parent.name === identifier) ||
    (ts.isShorthandPropertyAssignment(parent) && parent.name === identifier) ||
    (ts.isPropertySignature(parent) && parent.name === identifier) ||
    (ts.isParameter(parent) && parent.name === identifier) ||
    (ts.isBindingElement(parent) && parent.name === identifier)
  );
};

// Names a node uses but does not define itself (so not its own parameters or
// local variables). For a scalar type or a codec function, these are the names
// that must come from an import, which tells us which config imports to copy
// into the generated files.
const namesUsedButNotDefined = (node: ts.Node): Array<string> => {
  const parameters = new Set<string>();
  const locals = new Set<string>();
  const used = new Set<string>();

  const collectParameters = (current: ts.Node) => {
    if (ts.isParameter(current) && ts.isIdentifier(current.name)) {
      parameters.add(current.name.text);
    }
    ts.forEachChild(current, collectParameters);
  };
  collectParameters(node);

  const collect = (current: ts.Node) => {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      locals.add(current.name.text);
    }
    if (ts.isTypeReferenceNode(current) && ts.isIdentifier(current.typeName)) {
      used.add(current.typeName.text);
    }
    if (ts.isIdentifier(current) && !isDeclarationOrPropertyName(current)) {
      used.add(current.text);
    }
    ts.forEachChild(current, collect);
  };
  collect(node);

  return [...used].filter((id) => !parameters.has(id) && !locals.has(id));
};

const codecFunction = (
  codec: ts.Expression | undefined,
  which: "encode" | "decode",
  source: ts.SourceFile,
): ts.Expression | null => {
  if (!codec || !ts.isObjectLiteralExpression(codec)) {
    return null;
  }
  for (const property of codec.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      property.name.getText(source) === which
    ) {
      return property.initializer;
    }
  }
  return null;
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
    const encode = codecFunction(call.arguments[0], "encode", source);
    const decode = codecFunction(call.arguments[0], "decode", source);

    const imports = new Map<string, ImportBinding>();
    for (const node of [typeNode, encode, decode]) {
      if (!node) {
        continue;
      }
      for (const referenced of namesUsedButNotDefined(node)) {
        const binding = bindings.get(referenced);
        if (binding) {
          imports.set(`${binding.specifier}#${binding.name}`, binding);
        }
      }
    }

    scalarTypes[name] = {
      type: typeNode.getText(source),
      ...(encode ? { encode: encode.getText(source) } : {}),
      ...(decode ? { decode: decode.getText(source) } : {}),
      imports: [...imports.values()],
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
  const groups = new Map<
    string,
    { named: Set<string>; defaults: Set<string> }
  >();

  for (const { imports } of Object.values(scalarTypes)) {
    for (const binding of imports) {
      const key = `${binding.typeOnly}\n${rewriteSpecifier(
        binding.specifier,
        configPath,
        outputPath,
      )}`;
      const group = groups.get(key) || {
        named: new Set<string>(),
        defaults: new Set<string>(),
      };
      (binding.isDefault ? group.defaults : group.named).add(binding.name);
      groups.set(key, group);
    }
  }

  return [...groups.entries()]
    .flatMap(([key, { named, defaults }]) => {
      const [typeOnly, specifier] = key.split("\n");
      const keyword = typeOnly === "true" ? "import type" : "import";
      return [
        ...[...defaults].map(
          (name) => `${keyword} ${name} from "${specifier}";`,
        ),
        named.size > 0
          ? `${keyword} { ${[...named].join(", ")} } from "${specifier}";`
          : null,
      ].filter((line): line is string => line !== null);
    })
    .join("\n");
};
