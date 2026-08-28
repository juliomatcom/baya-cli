/**
 * conventions.md #11: chalk is imported in exactly one file, src/ui/theme.ts.
 * Shared between eslint.config.js and its test so the two never drift.
 */
export const CHALK_RESTRICTED_IMPORTS = {
  paths: [
    {
      name: "chalk",
      message: "chalk may only be imported in src/ui/theme.ts (conventions.md #11).",
    },
  ],
};
