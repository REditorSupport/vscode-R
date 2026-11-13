# Contributing

Contributions are always welcome!

## Developing the extension

The development setup, debugging, formatting, linting, and testing instructions
live with the source in
[CONTRIBUTING.md](https://github.com/REditorSupport/vscode-R/blob/main/CONTRIBUTING.md).
In short:

```sh
git clone https://github.com/REditorSupport/vscode-R.git
cd vscode-R
pnpm install --frozen-lockfile # install required packages for vscode-R
code . # run VS Code
```

Then test your changes:

- In VS Code: 'File' -> 'Open Folder...' and select 'vscode-R' (the directory
  with your edits)
- Select **Launch Extension** in Run and Debug, then press `F5`
- A new VS Code window should open, with '[Extension Development Host]' in the
  title bar. This is running your modified version of vscode-R

## Editing this documentation

This site is built with [VitePress](https://vitepress.dev/) from the Markdown
files in the
[`website/docs`](https://github.com/REditorSupport/vscode-R/tree/main/website/docs)
directory. Every page has an **Edit this page on GitHub** link at the bottom.

To preview the site locally:

```sh
cd website
pnpm install --frozen-lockfile
pnpm run docs:dev
```

`website` is a standalone pnpm project with its own lockfile, so it does not
affect the dependencies of the extension itself.

## Pull Request

- Fork it (via GitHub) in your account
- Add your project URL

```sh
git remote add mine https://github.com/yourname/vscode-R.git
```

- Create your feature branch

```sh
git checkout -b my-new-feature
```

- Commit your changes

```sh
git commit -am 'Add some feature'
```

- Push to the branch

```sh
git push mine my-new-feature
```

- Create new Pull Request (via GitHub)
