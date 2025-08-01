import {
  DocumentNode,
  EnumTypeDefinitionNode,
  FieldDefinitionNode,
  Kind,
  ObjectTypeDefinitionNode,
  TypeNode,
} from "graphql";
import { GqlScalarToTs, ScalarType } from "./types.ts";
import {
  baseScalars,
  customScalarsImports,
  getCustomScalars,
  getQueries,
  isEnum,
  queriesTypes,
  types,
} from "./generator/helpers.ts";
import {
  argsToGql,
  fieldsToQuery,
  resultsToArgs,
  returnsToVariables,
  variablesToArgs,
} from "./generator/client.ts";

type Options = {
  scalarTypes: Record<string, ScalarType>;
};

const imports = () =>
  [
    "import React, { useState, useEffect, useMemo, ReactNode } from 'react';",
    "import { render, Text, Box, useInput, useStdout } from 'ink';",
  ].join("\n");

const call = () =>
  [
    "const call = async ({",
    "    graphqlServerUrl,",
    "    query,",
    "    returns,",
    "    args,",
    "    argTypes,",
    "    queryType,",
    "    queryOrMutation,",
    "    options",
    "  }: {",
    "    graphqlServerUrl: string,",
    "    query: string,",
    "    returns: Fields,",
    "    args: Record<string, Arguments> | undefined,",
    "    argTypes: ArgumentTypes | undefined,",
    "    queryType: keyof typeof types.Query | null,",
    "    queryOrMutation: 'query' | 'mutation',",
    "    options: CallOptions",
    "}) => {",
    "    const response = await fetch(graphqlServerUrl, {",
    "      method: 'POST',",
    "      body: JSON.stringify({",
    "        operationName: query,",
    "        query: `${queryOrMutation} ${query}${",
    "          argTypes && args ? `(${argsToGql(argTypes, args, queryType, returns)})` : ''",
    "        } {\\n ${query}${",
    "          args ? `(${variablesToArgs(args)})` : ''",
    "        }\\n ${fieldsToQuery(returns)} }`,",
    "        variables: { ...args, ...returnsToVariables(returns) },",
    "      }),",
    "      headers: {",
    "        'Content-Type': 'application/json',",
    "        ...options.headers",
    "      },",
    "      credentials: 'include',",
    "    });",
    "",
    "    return response;",
    "}",
  ].join("\n");

const gqlTypeToText = (type: TypeNode): string => {
  switch (type.kind) {
    case Kind.NAMED_TYPE:
      return `"${type.name.value}"`;
    case Kind.LIST_TYPE:
    case Kind.NON_NULL_TYPE:
      return gqlTypeToText(type.type);
  }
};

const isNullable = (type: TypeNode): boolean => {
  switch (type.kind) {
    case Kind.NAMED_TYPE:
      return true;
    case Kind.LIST_TYPE:
      return isNullable(type.type);
    case Kind.NON_NULL_TYPE:
      return false;
  }
};

const isArray = (type: TypeNode): boolean => {
  switch (type.kind) {
    case Kind.NAMED_TYPE:
      return false;
    case Kind.LIST_TYPE:
      return true;
    case Kind.NON_NULL_TYPE:
      return isArray(type.type);
  }
};

const queriesAndMutationsParameters = (schema: DocumentNode) => {
  const queries = getQueries(schema);

  return [
    "const queries = {",
    ...(queries?.fields || []).map(
      (query) =>
        `  ${query.name.value}: {\n${[
          "    return: {",
          `      type: ${gqlTypeToText(query.type)},`,
          `      nullable: ${isNullable(query.type)},`,
          `      array: ${isArray(query.type)}`,
          "    },",
          "    args: null",
        ].join("\n")}\n  },`
    ),
    "}",
  ].join("\n");
};

const typesFields = (
  schema: DocumentNode,
  enums: Array<EnumTypeDefinitionNode>
) =>
  [
    "const types = {",
    (
      schema.definitions.filter(
        (node) =>
          node.kind === Kind.OBJECT_TYPE_DEFINITION && !isEnum(node, enums)
      ) as Array<ObjectTypeDefinitionNode>
    )
      .map((node) =>
        [`  ${node.name.value}: {`]
          .concat(
            (node.fields || []).map(
              (field) =>
                `    ${field.name.value}: ${gqlTypeToText(field.type)},`
            )
          )
          .concat(["  },"])
          .join("\n")
      )
      .join("\n\n"),
    "}",
  ].join("\n");

const client = (
  schema: DocumentNode,
  scalars: Array<GqlScalarToTs>,
  enums: Array<EnumTypeDefinitionNode>
) => {
  return [
    "const useDimensions = (): [number, number] => {",
    "  const { stdout } = useStdout();",
    "  const [dimensions, setDimensions] = useState<[number, number]>([stdout.columns, stdout.rows]);",
    "",
    "  useEffect(() => {",
    "    const handler = () => setDimensions([stdout.columns, stdout.rows]);",
    "    stdout.on('resize', handler);",
    "    return () => {",
    "      stdout.off('resize', handler);",
    "    };",
    "  }, [stdout]);",
    "",
    "  return dimensions;",
    "}",
    "",
    "type SelectableListProps<Option> = {",
    "  height: number;",
    "  width: number;",
    "  options: Array<Option>;",
    "  onChange: (option: Option) => void;",
    "  option: {",
    "    id: (option: Option) => string",
    "    text: (option: Option) => string",
    "  }",
    "}",
    "",
    "const SelectableList = <Option,>({ height, width, options, onChange, option: { id, text } }: SelectableListProps<Option>) => {",
    "  const scrollMargin = Math.ceil(height / 10);",
    "",
    "  const [hoverIndex, setHoverIndex] = useState(0);",
    "",
    "  const scrollOffset = useMemo(",
    "    () =>",
    "      hoverIndex >",
    "      options.length - height",
    "        ? Math.max(options.length - height, 0)",
    "        : hoverIndex > scrollMargin",
    "        ? hoverIndex - scrollMargin",
    "        : 0,",
    "    [hoverIndex, scrollMargin, options]",
    "  );",
    "",
    "  const displayedOptions = options.slice(",
    "    scrollOffset,",
    "    scrollOffset + height",
    "  );",
    "",
    "  useInput((input, key) => {",
    "    if (key.upArrow) {",
    "      setHoverIndex(Math.max(hoverIndex - 1, 0))",
    "    } else if (key.downArrow) {",
    "      setHoverIndex(Math.min(hoverIndex + 1, options.length - 1))",
    "    } else if (input === ' ') {",
    "      onChange(options[hoverIndex])",
    "    }",
    "  });",
    "",
    "  return (",
    '    <Box flexDirection="column" height={height} width={width}>',
    "      {displayedOptions.map((option, index) => (",
    "        <Text",
    "          key={id(option)}",
    '          color={index === hoverIndex - scrollOffset ? "blue" : "white"}',
    '          wrap="truncate"',
    "        >",
    "          ○ {text(option)}",
    "        </Text>",
    "      ))}",
    "    </Box>",
    "  )",
    "}",
    "",
    "type NodeConstraint = {",
    "  key: string;",
    "  name: string;",
    "};",
    "",
    "type ExtendableTree<Node, Extender> = {",
    "  node: Node;",
    "  children: Array<ExtendableTree<Node, Extender>>;",
    "} & Extender;",
    "",
    "type Tree<Node> = ExtendableTree<Node, {}>;",
    "",
    "type SelectedTree<Node> = ExtendableTree<",
    "  Node,",
    "  {",
    "    highlighted: boolean;",
    "    selected: boolean;",
    "  }",
    ">;",
    "",
    "const selectLeaf = <Node,>(",
    "  tree: SelectedTree<Node>",
    "): SelectedTree<Node> => ({",
    "  ...tree,",
    "  selected: tree.highlighted ? !tree.selected : tree.selected,",
    "  children: tree.children.map(selectLeaf),",
    "});",
    "",
    "const getLastLeaf = <Node,>(tree: SelectedTree<Node>): SelectedTree<Node> =>",
    "  tree.selected && tree.children.length > 0",
    "    ? getLastLeaf(tree.children.at(-1)!)",
    "    : tree;",
    "",
    "type MapFn<Node> = (",
    "  leaf: SelectedTree<Node>,",
    "  previous: SelectedTree<Node> | null,",
    "  next: SelectedTree<Node> | null",
    ") => SelectedTree<Node>;",
    "",
    "const map = <Node,>(",
    "  fn: MapFn<Node>,",
    "  tree: SelectedTree<Node>",
    "): SelectedTree<Node> => {",
    "  const recursiveMap = (",
    "    tree: SelectedTree<Node>,",
    "    previousTree: SelectedTree<Node> | null,",
    "    nextTree: SelectedTree<Node> | null",
    "  ): SelectedTree<Node> => ({",
    "    ...fn(",
    "      tree,",
    "      previousTree,",
    "      tree.selected && tree.children.length > 0 ? tree.children[0]! : nextTree",
    "    ),",
    "    children: tree.children.map((child, index) => {",
    "      const previousSibling = tree.children[index - 1] ?? null;",
    "",
    "      return recursiveMap(",
    "        child,",
    "        previousSibling ? getLastLeaf(previousSibling) : tree,",
    "        index === tree.children.length - 1",
    "          ? nextTree",
    "          : tree.children[index + 1]!",
    "      );",
    "    }),",
    "  });",
    "",
    "  return recursiveMap(tree, null, null);",
    "};",
    "",
    "const highlightNextLeaf = <Node,>(",
    "  tree: SelectedTree<Node>",
    "): SelectedTree<Node> =>",
    "  map(",
    "    (leaf, previous, next) => ({",
    "      ...leaf,",
    "      highlighted: !next",
    "        ? previous",
    "          ? previous.highlighted || leaf.highlighted",
    "          : leaf.highlighted",
    "        : previous",
    "        ? previous.highlighted",
    "        : false,",
    "    }),",
    "    tree",
    "  );",
    "",
    "const highlightPreviousLeaf = <Node,>(",
    "  tree: SelectedTree<Node>",
    "): SelectedTree<Node> =>",
    "  map(",
    "    (leaf, previous, next) => ({",
    "      ...leaf,",
    "      highlighted: !previous",
    "        ? next",
    "          ? next.highlighted || leaf.highlighted",
    "          : leaf.highlighted",
    "        : next",
    "        ? next.highlighted",
    "        : false,",
    "    }),",
    "    tree",
    "  );",
    "",
    "const size = <Node,>(tree: SelectedTree<Node>): number =>",
    "  tree.selected",
    "    ? tree.children.reduce((total, child) => total + size(child), 1)",
    "    : 1;",
    "",
    "const getHighlightIndex = <Node,>(",
    "  tree: SelectedTree<Node>",
    "  // index: number = 0",
    "): number => {",
    "  const getRecursiveHighlightIndex = (",
    "    tree: SelectedTree<Node>,",
    "    previousIndex: number",
    "  ): [number, number] => {",
    "    if (tree.highlighted) {",
    "      return [previousIndex, previousIndex];",
    "    }",
    "",
    "    let updatedPreviousIndex = previousIndex + 1;",
    "    if (tree.selected) {",
    "      for (const child of tree.children) {",
    "        const [childIndex, childPreviousIndex] = getRecursiveHighlightIndex(",
    "          child,",
    "          updatedPreviousIndex",
    "        );",
    "",
    "        if (childIndex >= 0) {",
    "          return [childIndex, childPreviousIndex];",
    "        }",
    "",
    "        updatedPreviousIndex = childPreviousIndex;",
    "      }",
    "    }",
    "",
    "    return [-1, updatedPreviousIndex];",
    "  };",
    "",
    "  return getRecursiveHighlightIndex(tree, 0)[0];",
    "};",
    "",
    "type SelectableTreeNodeProps = {",
    "  checked: boolean;",
    "  highlighted: boolean;",
    "  children: string;",
    "};",
    "",
    "const SelectableTreeNode = ({",
    "  checked,",
    "  children,",
    "  highlighted,",
    "}: SelectableTreeNodeProps) => (",
    "  <Box>",
    '    <Text color={highlighted ? "blue" : "white"}>',
    '      {checked ? "◉ " : "○ "}',
    "    </Text>",
    '    <Text bold={checked} color={highlighted ? "blue" : "white"}>',
    "      {children}",
    "    </Text>",
    "  </Box>",
    ");",
    "",
    "type LeafProps<Node extends NodeConstraint> = {",
    "  leaf: SelectedTree<Node>;",
    "  indentation: number;",
    "};",
    "",
    "const Leaf = <Node extends NodeConstraint>({",
    "  leaf,",
    "  indentation,",
    "}: LeafProps<Node>) => {",
    "  const children: Array<ReactNode> = [];",
    "  if (leaf.selected) {",
    "    for (let index = 0; index < leaf.children.length; index++) {",
    "      const child = leaf.children[index]!;",
    "",
    "      children.push(",
    "        ...Leaf({",
    "          leaf: child,",
    "          indentation: indentation + 2,",
    "        })",
    "      );",
    "    }",
    "  }",
    "",
    "  return [",
    "    (",
    "      <Box key={Math.random()}>",
    '        <Text>{"".padStart(indentation)}</Text>',
    "        <SelectableTreeNode",
    "          checked={leaf.selected}",
    "          highlighted={leaf.highlighted}",
    "        >",
    "          {leaf.node.name}",
    "        </SelectableTreeNode>",
    "      </Box>",
    "    ) as ReactNode",
    "  ].concat(children);",
    "};",
    "",
    "type SelectableTreeProps<Node extends NodeConstraint> = {",
    "  tree: SelectedTree<Node>",
    "  height: number",
    "  width: number",
    "  onTreeChange: (newTree: SelectedTree<Node> | null) => void",
    "};",
    "",
    "const SelectableTree = <Node extends NodeConstraint>({",
    "  tree,",
    "  height,",
    "  onTreeChange,",
    "}: SelectableTreeProps<Node>) => {",
    "  const scrollMargin = Math.ceil(height / 10);",
    "  const hoverIndex = getHighlightIndex(tree);",
    "  const maxScrollOffset = Math.max(size(tree) - height, 0);",
    "",
    "  const scrollOffset = useMemo(",
    "    () => Math.max(0, Math.min(maxScrollOffset, hoverIndex - scrollMargin)),",
    "    [tree, height]",
    "  );",
    "",
    "  const children = Leaf({",
    "    leaf: tree,",
    "    indentation: 0,",
    "  });",
    "",
    "  useInput((input, key) => {",
    "    if (key.upArrow) {",
    "      onTreeChange(highlightPreviousLeaf(tree))",
    "    } else if (key.downArrow) {",
    "      onTreeChange(highlightNextLeaf(tree))",
    "    } else {",
    '      if (input === " ") {',
    "        const newSelectedTree = selectLeaf(tree)",
    "        onTreeChange(",
    "          newSelectedTree.selected ? newSelectedTree : null",
    "        )",
    "      }",
    "    }",
    "  })",
    "",
    "  return (",
    '    <Box flexDirection="column">',
    "      {children.slice(scrollOffset, scrollOffset + height)}",
    "    </Box>",
    "  );",
    "};",
    "",
    "type Field = {",
    "  key: string",
    "  name: string",
    "  type: keyof typeof types | null",
    "}",
    "",
    "const getTreeLeaves = (type: keyof typeof types, currentTree: Array<SelectedTree<Field>>): Array<SelectedTree<Field>> =>",
    "  Object.entries(types[type]).map(",
    "    ([field, type], index) => ({",
    "      node: {",
    "        key: field,",
    "        name: field,",
    "        type: type in types ? type as keyof typeof types : null,",
    "      },",
    "      highlighted: currentTree[index]?.highlighted ?? false,",
    "      selected: currentTree[index]?.selected ?? false,",
    "      children: type in types && currentTree[index]?.selected ? getTreeLeaves(type as keyof typeof types, currentTree[index].children) : [],",
    "    } satisfies SelectedTree<Field>),",
    "  )",
    "",
    "const expandSelectedLeaves = (tree: SelectedTree<Field>): SelectedTree<Field> => ({",
    "  ...tree,",
    "  children: tree.selected && tree.node.type ? getTreeLeaves(tree.node.type, tree.children) : []",
    "})",
    "",
    "const leavesToQuery = (leaves: Array<SelectedTree<Field>>) =>",
    "  leaves.filter(leaf => leaf.selected).map(leaf => leaf.node.type ? ({[leaf.node.key]: leavesToQuery(leaf.children)}) : leaf.node.key) as Fields",
    "",
    "type QueryBuilderProps = {",
    "  graphqlServerUrl: string",
    "  headers?: Record<string, string>",
    "}",
    "",
    "const QueryBuilder = ({ graphqlServerUrl, headers }) => {",
    "  const [width, height] = useDimensions()",
    "  const [tree, setTree] = useState<SelectedTree<Field> | null>(null)",
    "",
    "  useInput((input, key) => {",
    "    if (key.return && tree && tree.children.some((child) => child.selected)) {",
    "      call({",
    "        graphqlServerUrl,",
    "        query: tree.node.key,",
    "        returns: leavesToQuery(tree.children),",
    "        args: undefined,",
    "        argTypes: undefined,",
    "        queryType: null,",
    '        queryOrMutation: "query",',
    "        options: { headers },",
    "      }).then((response) => console.log(response.status) || response.text()).then(console.log).catch(console.error)",
    "    }",
    "  })",
    "",
    "  return !tree ? (",
    "    <SelectableList",
    "      height={height}",
    "      width={width}",
    "      options={Object.keys(queries).sort()}",
    "      option={{",
    "        id: (query) => query,",
    "        text: (query) => query,",
    "      }}",
    "      onChange={queryOrMutation => {",
    "        setTree({",
    "          node: { key: queryOrMutation, name: queryOrMutation, type: types.Query[queryOrMutation] in types ? types.Query[queryOrMutation] : null },",
    "          highlighted: true,",
    "          selected: true,",
    "          children: getTreeLeaves(types.Query[queryOrMutation], [])",
    "        })",
    "      }}",
    "    />",
    "  ) : (",
    '    <Box flexDirection="column">',
    "      <SelectableTree",
    "        height={height}",
    "        width={width}",
    "        tree={tree}",
    "        onTreeChange={(newTree) =>",
    "          newTree",
    "            // We cannot run the expandSelectedLeaves on queries/mutations",
    "            ? setTree({...newTree, children: newTree.children.map(expandSelectedLeaves)})",
    "            : setTree(null)",
    "        }",
    "      />",
    "    </Box>",
    "  )",
    "}",
    "",
    "render(<QueryBuilder />)",
  ].join("\n");
};

export const schemaToCli = (schema: DocumentNode, { scalarTypes }: Options) => {
  const customScalars = getCustomScalars(schema);

  const scalars: Array<GqlScalarToTs> = baseScalars.concat(
    customScalars.map((scalar) => {
      const type = scalarTypes[scalar.name.value];

      if (!type) {
        // TODO: Write a nicer, more detailed error, with steps to solve
        throw `No type for scalar ${scalar.name.value}.`;
      }

      return {
        gql: scalar.name.value,
        ts: type.name || scalar.name.value,
      };
    })
  );

  const enums = schema.definitions.filter(
    (node) => node.kind === Kind.ENUM_TYPE_DEFINITION
  ) as Array<EnumTypeDefinitionNode>;

  return [
    imports(),
    queriesTypes(schema, scalars, enums),
    types(schema, scalars, enums),
    customScalarsImports(scalarTypes, customScalars),
    queriesAndMutationsParameters(schema),
    typesFields(schema, enums),
    fieldsToQuery(),
    resultsToArgs(),
    argsToGql(),
    variablesToArgs(),
    returnsToVariables(),
    call(),
    client(schema, scalars, enums),
  ].join("\n\n");
};
