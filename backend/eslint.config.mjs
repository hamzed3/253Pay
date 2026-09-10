// Configuration ESLint (format « flat », ESLint 9).
// POURQUOI : le script `npm run lint` est documenté dans README.md et CLAUDE.md ;
// sans cette configuration ni les dépendances associées, il échouait.
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'eslint.config.mjs'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Les décorateurs NestJS reposent sur des types que le parser voit comme "any".
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  // Prettier a le dernier mot sur le formatage : on désactive les règles qui le contredisent.
  prettierConfig,
);
