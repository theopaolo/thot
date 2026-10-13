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
  // Les tests de déploiement lancent des processus et dépassent le délai de 5 s par défaut.
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
    rules: {
      // parseBody type chaque champ string | File. Un fichier dans un champ texte devient
      // "[object File]", un texte que la validation traite comme les autres.
      "typescript/no-base-to-string": "off",
      // URLSearchParams et les valeurs facultatives s'écrivent dans les gabarits à dessein.
      "typescript/restrict-template-expressions": "off",
      // Les tests gardent une méthode pour la remettre après l'avoir remplacée.
      "typescript/unbound-method": "off",
    },
  },
});
