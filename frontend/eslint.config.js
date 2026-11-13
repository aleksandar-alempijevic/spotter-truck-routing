import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// The map is the one place that imports maplibre-gl, and it is reached from outside only through
// the dynamic import in layout/. Types may cross; nothing else may import the map statically.
const MAP_IMPORT_MESSAGE =
  'Only src/map imports maplibre-gl, and the rest of the app loads src/map with a dynamic import() so it stays a separate chunk.';

export default tseslint.config(
  { ignores: ['dist', 'src/api/schema.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  { languageOptions: { globals: globals.browser } },
  { files: ['scripts/**'], languageOptions: { globals: globals.node } },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/map/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['maplibre-gl', 'maplibre-gl/*'],
              message: MAP_IMPORT_MESSAGE,
              allowTypeImports: true,
            },
            { group: ['**/map', '**/map/*'], message: MAP_IMPORT_MESSAGE, allowTypeImports: true },
          ],
        },
      ],
    },
  },
);
