import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import type { Modeles } from "../core/modeles.ts";
import type { Db } from "../app/db.ts";

/** Une commande de `thot` : ses lignes d'aide, et ce qu'elle fait de ses arguments. */
export type Commande = {
  aide: string;
  lancer: (db: Db, modeles: Modeles, argv: string[]) => unknown;
};

/** Les arguments d'une commande. Une option qu'elle ne déclare pas est refusée. */
export const lire = <O extends ParseArgsOptionsConfig>(argv: string[], options: O) =>
  parseArgs({ args: argv, options, allowPositionals: true, strict: true });

export const oui = { type: "boolean" } as const;
export const texte = { type: "string" } as const;
