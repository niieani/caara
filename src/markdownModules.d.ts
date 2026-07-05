/**
 * Type support for Bun text imports of markdown assets (`with { type: "text" }`).
 * Bun inlines the file contents as a string at bundle/compile time; vitest resolves the same
 * imports through the markdown-as-text plugin registered in vitest.config.ts.
 */
declare module "*.md" {
  /** UTF-8 contents of the imported markdown file. */
  const text: string;
  export default text;
}
