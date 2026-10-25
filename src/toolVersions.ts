// Minimum versions of the CRAN packages vscode-R can install into its managed tool library.
// Shared by consent eligibility and R package preparation.
export const TOOL_MINIMUM_VERSIONS = {
    jgd: '0.1.0',
    // The first release that exports the document position and range helpers used by sess.
    rstudioapi: '0.4.0',
} as const;

export type ToolPackageName = keyof typeof TOOL_MINIMUM_VERSIONS;

export function isToolPackageName(name: string): name is ToolPackageName {
    return Object.prototype.hasOwnProperty.call(TOOL_MINIMUM_VERSIONS, name);
}
