module.exports = {
    env: {
      browser: true,
      es6: true
    },
    globals: {
      Atomics: 'readonly',
      SharedArrayBuffer: 'readonly'
    },
    parser: '@typescript-eslint/parser',
    parserOptions: {
      ecmaVersion: 2018,
      sourceType: 'module'
    },
    plugins: [
      '@typescript-eslint',
      'jsdoc'
    ],
    rules: {
    }
  }
  