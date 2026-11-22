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
      const stderr = new PassThrough();
      if (cas === "sortie") stdout.write(new Uint8Array(10 * 1024 * 1024 + 1));
      let signal: string | undefined;
      const enfant = Object.assign(new EventEmitter(), {
        pid: 123,
        stdout,
        stderr,
        kill(s: string) {
          assertEquals(s, "SIGKILL");
          if (signal) return;
          signal = s;
          stdout.end();
          stderr.end();
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

/** Un faux pdftotext : ses flux, et ce que Node émet quand il se termine. */
function faux(pid: number | undefined) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const enfant = Object.assign(new EventEmitter(), { pid, stdout, stderr, kill: () => true });
  enfants.courant = enfant;
  return enfant;
}

test("un pdftotext introuvable devient une erreur d'extraction, sans rejet non géré", async () => {
  const enfant = faux(undefined);
  const rejets: unknown[] = [];
  const noter = (e: unknown) => rejets.push(e);
  process.on("unhandledRejection", noter);
  try {
    // Node émet « error », ferme les flux au tour suivant, puis émet « close ».
    setImmediate(() => {
      enfant.emit("error", new Error("spawn pdftotext ENOENT"));
      setImmediate(() => {
        enfant.stdout.end();
        enfant.stderr.end();
        setImmediate(() => enfant.emit("close", -2, null));
      });
    });
    await assertRejects(() => extrairePdf("document.pdf"), Error, "spawn pdftotext ENOENT");
    await new Promise((r) => setImmediate(r));
    assertEquals(rejets, []);
  } finally {
    process.off("unhandledRejection", noter);
  }
});

test("l'échec de pdftotext porte sa sortie d'erreur et son signal", async () => {
  for (const [code, signal, attendu] of [
    [1, null, "(code 1) : Command Line Error: Incorrect password"],
    [null, "SIGSEGV", "(signal SIGSEGV)"],
  ] as const) {
    const enfant = faux(123);
    setImmediate(() => {
      if (code) enfant.stderr.write("Command Line Error: Incorrect password\n");
      enfant.stderr.end();
      enfant.stdout.end();
      setImmediate(() => enfant.emit("close", code, signal));
    });
    await assertRejects(() => extrairePdf("document.pdf"), Error, attendu);
  }
});

test("un signal interrompu tue pdftotext sur-le-champ et évite de le lancer s'il l'est déjà", async () => {
  const deja = new AbortController();
  deja.abort(new Error("arrêt"));
  enfants.args = [];
  await assertRejects(() => extrairePdf("document.pdf", "general", deja.signal), Error, "arrêt");
  assertEquals(enfants.args.length, 0);

  const controle = new AbortController();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let tue = "";
  const enfant = Object.assign(new EventEmitter(), {
    pid: 123,
    stdout,
    stderr,
    kill(s: string) {
      if (tue) return;
      tue = s;
      stdout.end();
      stderr.end();
      setImmediate(() => enfant.emit("close", null, s));
    },
  });
  enfants.courant = enfant;
  const p = extrairePdf("document.pdf", "general", controle.signal);
  controle.abort();
  assertEquals(tue, "SIGKILL", "pdftotext doit être tué de façon synchrone avant process.exit");
  await assertRejects(() => p, Error, "interrompue");
});
