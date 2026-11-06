import * as yaml from 'js-yaml';

const rExpressionTag = yaml.defineScalarTag('!r', {
    resolve: (source: string) => ({ __rExpr: source }),
    identify: () => false,
});

const rMarkdownIntegerTag = {
    ...yaml.intCoreTag,
    // v4 also accepted binary integers and signed octal/hexadecimal integers
    // without an explicit !!int tag. v5 restricts those to explicit tags.
    resolve: (source: string, _isExplicit: boolean, tagName: string) =>
        yaml.intCoreTag.resolve(source, true, tagName),
};

// Keep the extra tags supported by js-yaml 4's DEFAULT_SCHEMA (including
// timestamps and merge keys), with YAML 1.2 boolean and number resolution.
const rMarkdownSchema = yaml.YAML11_SCHEMA.withTags(
    yaml.CORE_SCHEMA.tags,
    rMarkdownIntegerTag,
    rExpressionTag,
);

export function loadRMarkdownYaml(source: string): unknown {
    // loadAll retains v4's undefined result for empty/comment-only headers.
    const documents = yaml.loadAll(source, { schema: rMarkdownSchema });
    if (documents.length > 1) {
        throw new yaml.YAMLException('expected a single YAML frontmatter document');
    }
    return documents[0];
}
