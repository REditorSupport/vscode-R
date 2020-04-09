module.exports = {
  env: {
    browser: true,
    es6: true,
    node: true
  },
  extends: [
    "plugin:@typescript-eslint/eslint-recommended"
  ],
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
    "jsdoc"
  ],
  rules: {
		"semi": "error",
		"no-extra-semi": "warn",
		"curly": "warn",
		"quotes": ["error", "single", { "allowTemplateLiterals": true } ],
		"eqeqeq": "error"
	}
}