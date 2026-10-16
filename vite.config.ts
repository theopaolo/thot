import { defineConfig } from "vite-plus";

const ignores = ["static/vendor/**", "static/dist/**", ".claude/**"];

export default defineConfig({
  // Le JavaScript du navigateur: un module ES servi tel quel sous /static/dist/. Mermaid et KaTeX
  // y ajoutent des morceaux chargés à la demande, et KaTeX sa feuille de style et ses polices.
  base: "/static/dist/",
  plugins: [
    {
      // Les navigateurs pris en charge lisent le WOFF2 : les copies WOFF et TTF de KaTeX restent
      // hors du dossier servi.
      name: "katex-woff2",
      enforce: "pre",
      transform(code, id) {
        if (!/[\\/]katex[\\/].*\.css$/.test(id)) return;
        return code.replace(/,url\([^)]*\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g, "");
      },
    },
  ],
  build: {
    outDir: "static/dist",
    sourcemap: true,
    // Sans préchargement, app.js ne porte pas la liste des morceaux de Mermaid.
    modulePreload: false,
    // Les morceaux de mise en page de Mermaid (elk, cytoscape) dépassent 500 kB. Ils ne se
    // chargent que pour un schéma qui les demande.
    chunkSizeWarningLimit: 1500,
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
