import { assert, assertEquals, assertRejects } from "@std/assert";
import { extrairePdf } from "../src/core/pdf.ts";

Deno.test("le convertisseur est arrêté et attendu en cas de délai, mémoire ou sortie excessive", async () => {
  const Command = Deno.Command;
  const timeout = globalThis.setTimeout;
  const interval = globalThis.setInterval;
  try {
    for (const cas of ["delai", "sortie", ...(Deno.build.os === "darwin" ? ["memoire"] : [])]) {
      const fin = Promise.withResolvers<Deno.CommandStatus>();
      let flux!: ReadableStreamDefaultController<Uint8Array>;
      let tue = false;
      const stdout = new ReadableStream<Uint8Array>({
        start(c) {
          flux = c;
          if (cas === "sortie") c.enqueue(new Uint8Array(10 * 1024 * 1024 + 1));
        },
      });
      const enfant = {
        pid: 123,
        stdout,
        status: fin.promise,
        kill(signal: string) {
          assertEquals(signal, "SIGKILL");
          if (tue) return;
          tue = true;
          flux.close();
          fin.resolve({ success: false, code: 137, signal: "SIGKILL" });
        },
      } as unknown as Deno.ChildProcess;
      Deno.Command = class extends Command {
        constructor(command: string | URL, options?: Deno.CommandOptions) {
          super(command, options);
          if (String(command) !== "/bin/ps") {
            assertEquals(options?.args?.slice(-2), ["document.pdf", "-"]);
            if (Deno.build.os === "linux") {
              assertEquals(command, "/usr/bin/prlimit");
              assert(options?.args?.includes("--as=536870912"));
            }
          }
        }
        override spawn() {
          return enfant;
        }
        override output() {
          return Promise.resolve({
            success: true,
            code: 0,
            signal: null,
            stdout: new TextEncoder().encode("600000"),
            stderr: new Uint8Array(),
          });
        }
      };
      globalThis.setTimeout = ((callback: () => void, delai?: number) =>
        timeout(callback, delai === 30_000 && cas === "delai" ? 10 : delai)) as typeof setTimeout;
      globalThis.setInterval = ((callback: () => void, delai?: number) =>
        interval(callback, cas === "memoire" ? 10 : delai)) as typeof setInterval;
      await assertRejects(
        () =>
          extrairePdf("document.pdf"),
        Error,
        cas === "delai" ? "30 secondes" : cas === "sortie" ? "10 Mo" : "512 Mo",
      );
      assert(tue);
      assertEquals((await fin.promise).signal, "SIGKILL");
    }
  } finally {
    Deno.Command = Command;
    globalThis.setTimeout = timeout;
    globalThis.setInterval = interval;
  }
});
