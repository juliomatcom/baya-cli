/**
 * Repo hard rule (conventions.md #1): no `shell: true`, no `exec`/`execSync`.
 * All spawns take argv: string[] via `child_process.spawn`.
 */

const CHILD_PROCESS_MODULE = /^(node:)?child_process$/;
const BANNED_EXEC_NAMES = new Set(["exec", "execSync"]);

/** @type {import('eslint').Rule.RuleModule} */
const noShellExec = {
  meta: {
    type: "problem",
    docs: {
      description:
        "disallow `shell: true` and the exec/execSync family; use spawn with argv: string[]",
    },
    schema: [],
    messages: {
      shellTrue:
        "`shell: true` is banned repo-wide. Spawns take argv: string[] (conventions.md #1).",
      bannedExec:
        "`{{name}}` is banned repo-wide. Use `spawn` with argv: string[] instead (conventions.md #1).",
    },
  },
  create(context) {
    return {
      Property(node) {
        const keyName =
          node.key.type === "Identifier"
            ? node.key.name
            : node.key.type === "Literal"
              ? String(node.key.value)
              : null;
        if (
          keyName === "shell" &&
          node.value.type === "Literal" &&
          node.value.value === true
        ) {
          context.report({ node, messageId: "shellTrue" });
        }
      },
      ImportDeclaration(node) {
        if (!CHILD_PROCESS_MODULE.test(String(node.source.value))) return;
        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportSpecifier" &&
            specifier.imported.type === "Identifier" &&
            BANNED_EXEC_NAMES.has(specifier.imported.name)
          ) {
            context.report({
              node: specifier,
              messageId: "bannedExec",
              data: { name: specifier.imported.name },
            });
          }
        }
      },
      CallExpression(node) {
        const callee = node.callee;

        if (callee.type === "Identifier" && BANNED_EXEC_NAMES.has(callee.name)) {
          context.report({ node, messageId: "bannedExec", data: { name: callee.name } });
          return;
        }

        if (
          callee.type === "MemberExpression" &&
          callee.property.type === "Identifier" &&
          BANNED_EXEC_NAMES.has(callee.property.name)
        ) {
          context.report({
            node,
            messageId: "bannedExec",
            data: { name: callee.property.name },
          });
        }
      },
    };
  },
};

export default noShellExec;
