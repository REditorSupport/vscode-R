# vscode-R documentation site

Source of the vscode-R documentation site, built with
[VitePress](https://vitepress.dev/). Pages live in [`docs`](docs), and the
navigation is defined in [`docs/.vitepress/config.mjs`](docs/.vitepress/config.mjs).

This directory is a standalone pnpm project: it has its own `package.json`,
`pnpm-lock.yaml`, and `pnpm-workspace.yaml`, and is not part of the extension
package at the repository root.

```sh
cd website
pnpm install --frozen-lockfile
pnpm run docs:dev     # local preview with hot reload
pnpm run docs:build   # production build; fails on dead internal links
```
