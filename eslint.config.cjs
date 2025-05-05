const {
    defineConfig,
} = require("eslint/config");
const globals = require("globals");

module.exports = defineConfig([{
    languageOptions: {
        globals: {
            ...globals.browser,
        },

        ecmaVersion: 10,
        sourceType: "module",
        parserOptions: {},
    },
    rules: {},
}]);
