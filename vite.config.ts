import { defineConfig } from "vite-plus";

const ignores = ["static/vendor/**", "static/dist/**", ".claude/**"];

export default defineConfig({
  // Le JavaScript du navigateur: un module ES servi tel quel sous /static/dist/.
  build: {
    outDir: "static/dist",
    sourcemap: true,
    rolldownOptions: {
      input: "src/app/client/index.ts",
      output: { entryFileNames: "app.js" },
    },
  },
  // Deno n'imposait pas de délai par test. Les tests de déploiement lancent des processus.
  test: { include: ["tests/**/*_test.ts"], testTimeout: 60_000 },
  fmt: {
    printWidth: 100,
    // Les gabarits html`` produisent la page: les reformater change le HTML servi.
    embeddedLanguageFormatting: "off",
    ignorePatterns: [
      ...ignores,
      "tasks/**",
      "**/*.md",
      "docs/**",
      "evaluation/**",
      ".impeccable/**",
    ],
  },
  lint: {
    ignorePatterns: ignores,
    options: { typeAware: true, typeCheck: true },
  },
});
