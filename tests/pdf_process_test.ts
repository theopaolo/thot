import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { test, vi } from "vite-plus/test";
import { assert, assertEquals, assertRejects } from "@std/assert";

const enfants = vi.hoisted(() => ({ courant: undefined as unknown, args: [] as string[][] }));
vi.mock("node:child_process", () => ({
  spawn: (commande: string, args: string[]) => {
    enfants.args.push([commande, ...args]);
    return enfants.courant;
  },
  execFile: Object.assign(() => {}, {
    [promisify.custom]: () => Promise.resolve({ stdout: "600000", stderr: "" }),
  }),
}));
const { extrairePdf } = await import("../src/core/pdf.ts");

test("le convertisseur est arrêté et attendu en cas de délai, mémoire ou sortie excessive", async () => {
  const timeout = globalThis.setTimeout;
  const interval = globalThis.setInterval;
  try {
    for (const cas of ["delai", "sortie", ...(process.platform === "darwin" ? ["memoire"] : [])]) {
      const stdout = new PassThrough();
      if (cas === "sortie") stdout.write(new Uint8Array(10 * 1024 * 1024 + 1));
      let signal: string | undefined;
      const enfant = Object.assign(new EventEmitter(), {
        pid: 123,
        stdout,
        kill(s: string) {
          assertEquals(s, "SIGKILL");
          if (signal) return;
          signal = s;
          stdout.end();
          setImmediate(() => enfant.emit("close", null, s));
        },
      });
      enfants.courant = enfant;
      enfants.args = [];
      globalThis.setTimeout = ((callback: () => void, delai?: number) =>
        timeout(callback, delai === 30_000 && cas === "delai" ? 10 : delai)) as typeof setTimeout;
      globalThis.setInterval = ((callback: () => void, delai?: number) =>
        interval(callback, cas === "memoire" ? 10 : delai)) as typeof setInterval;
      await assertRejects(
        () => extrairePdf("document.pdf"),
        Error,
        cas === "delai" ? "30 secondes" : cas === "sortie" ? "10 Mo" : "512 Mo",
      );
      assertEquals(signal, "SIGKILL");
      const [commande, ...args] = enfants.args[0];
      assertEquals(args.slice(-2), ["document.pdf", "-"]);
      if (process.platform === "linux") {
        assertEquals(commande, "/usr/bin/prlimit");
        assert(args.includes("--as=536870912"));
      }
    }
  } finally {
    globalThis.setTimeout = timeout;
    globalThis.setInterval = interval;
  }
});
