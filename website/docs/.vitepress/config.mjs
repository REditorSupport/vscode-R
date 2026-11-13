import { defineConfig } from 'vitepress';

const repo = 'https://github.com/REditorSupport/vscode-R';

export default defineConfig({
    lang: 'en-US',
    title: 'vscode-R',
    titleTemplate: ':title | R Extension for Visual Studio Code',
    description:
        'Documentation for vscode-R, the R Extension for Visual Studio Code: installation, configuration, and features.',
    // Served from https://reditorsupport.github.io/vscode-R/
    base: '/vscode-R/',
    cleanUrls: true,
    // Requires full git history at build time (`fetch-depth: 0` in CI).
    lastUpdated: true,
    markdown: {
        // Shiki has no DCF grammar; DESCRIPTION-style `Key: value` reads fine as YAML.
        languageAlias: { dcf: 'yaml' },
    },
    head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/vscode-R/logo.svg' }]],
    themeConfig: {
        logo: '/logo.svg',
        nav: [
            { text: 'Getting Started', link: '/getting-started' },
            {
                text: 'Installation',
                items: [
                    { text: 'Windows', link: '/installation/windows' },
                    { text: 'macOS', link: '/installation/macos' },
                    { text: 'Linux', link: '/installation/linux' },
                ],
            },
            {
                text: 'Links',
                items: [
                    {
                        text: 'VS Code Marketplace',
                        link: 'https://marketplace.visualstudio.com/items?itemName=REditorSupport.r',
                    },
                    { text: 'Open VSX', link: 'https://open-vsx.org/extension/REditorSupport/r' },
                    { text: 'Changelog', link: `${repo}/blob/main/CHANGELOG.md` },
                ],
            },
        ],
        sidebar: [
            {
                text: 'Introduction',
                items: [{ text: 'Getting Started', link: '/getting-started' }],
            },
            {
                text: 'Installation',
                items: [
                    { text: 'Windows', link: '/installation/windows' },
                    { text: 'macOS', link: '/installation/macos' },
                    { text: 'Linux', link: '/installation/linux' },
                ],
            },
            {
                text: 'Configuration',
                items: [
                    { text: 'Extension settings', link: '/configuration/extension-settings' },
                    { text: 'Keyboard shortcuts', link: '/configuration/keyboard-shortcuts' },
                    { text: 'Code linting', link: '/configuration/code-linting' },
                    {
                        text: 'Recommended extensions and configuration',
                        link: '/configuration/recommended-extensions',
                    },
                    { text: 'Working with renv-enabled projects', link: '/configuration/renv' },
                ],
            },
            {
                text: 'Features',
                items: [
                    { text: 'R Language Service', link: '/features/language-service' },
                    { text: 'Interacting with R terminals', link: '/features/r-terminals' },
                    { text: 'R Interactive (experimental)', link: '/features/r-interactive' },
                    { text: 'Interactive viewers', link: '/features/interactive-viewers' },
                    { text: 'Sidebar user interface', link: '/features/sidebar' },
                    { text: 'Plot viewer', link: '/features/plot-viewer' },
                    { text: 'R Session watcher', link: '/features/session-watcher' },
                    { text: 'RStudio addin support', link: '/features/rstudio-addins' },
                ],
            },
            {
                text: 'Guides',
                items: [
                    { text: 'Package development', link: '/guide/package-development' },
                    { text: 'R Markdown', link: '/guide/r-markdown' },
                ],
            },
            {
                text: 'Project',
                items: [
                    { text: 'Contributing', link: '/contributing' },
                    { text: 'FAQ', link: '/faq' },
                ],
            },
            {
                text: 'Removed in 3.0.0',
                collapsed: true,
                items: [
                    { text: 'R options', link: '/configuration/r-options' },
                    { text: 'Live Share collaboration', link: '/features/live-share' },
                ],
            },
        ],
        socialLinks: [{ icon: 'github', link: repo }],
        search: { provider: 'local' },
        editLink: {
            pattern: `${repo}/edit/main/website/docs/:path`,
            text: 'Edit this page on GitHub',
        },
        outline: { level: [2, 3] },
        footer: {
            message: 'Released under the MIT License.',
            // Attribution required by the logo's CC BY-SA 4.0 license.
            copyright:
                'The <a href="https://www.r-project.org/logo/">R logo</a> is © 2016 The R Foundation, used under <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a>.',
        },
    },
});
