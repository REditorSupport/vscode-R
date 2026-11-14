# vscode-R documentation site

Source of the vscode-R documentation site, built with
[VitePress](https://vitepress.dev/). Pages live in [`docs`](docs), and the
navigation is defined in [`docs/.vitepress/config.mjs`](docs/.vitepress/config.mjs).

This directory is a standalone pnpm project: it has its own `package.json`,
`pnpm-lock.yaml`, and `pnpm-workspace.yaml`, and is not part of the extension
package at the repository root.

[`docs/public/logo.svg`](docs/public/logo.svg) is an unchanged copy of the
[R logo](https://www.r-project.org/logo/), © 2016 The R Foundation, licensed
under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). See
[`ThirdPartyNotices.txt`](../ThirdPartyNotices.txt).

```sh
cd website
pnpm install --frozen-lockfile
pnpm run docs:dev     # local preview with hot reload
pnpm run docs:build   # production build; fails on dead internal links
```
