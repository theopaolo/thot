import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.ts";

// Images déposées avec une activité. Elles vivent hors de `content/`, qui range les sources.

export const dossierActivite = (id: string) => join(config.donnees, "activites", id);
const FICHIER = /^[0-9a-f-]{36}\.(png|jpg|webp|gif)$/;
const MIMES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};
export const MAX_IMAGE = 5 * 1024 * 1024;

/** L'extension que disent les premiers octets d'une image PNG, JPEG, WebP ou GIF. */
function format(o: Uint8Array) {
  const debut = (s: string, depuis = 0) => {
    for (let i = 0; i < s.length; i++) if (o[depuis + i] !== s.charCodeAt(i)) return false;
    return true;
  };
  if (o[0] === 0x89 && debut("PNG", 1)) return "png";
  if (o[0] === 0xff && o[1] === 0xd8 && o[2] === 0xff) return "jpg";
  if (debut("GIF8")) return "gif";
  if (debut("RIFF") && debut("WEBP", 8)) return "webp";
}

/**
 * Range une image déposée par l'enseignant avec l'activité. Le format vient de ses octets, pas du
 * nom ni du type annoncés par le navigateur. Rend le nom du fichier.
 */
export async function deposerImage(id: string, octets: Uint8Array) {
  const ext = format(octets);
  if (!ext) throw new Error("Image : PNG, JPEG, WebP ou GIF.");
  if (octets.length > MAX_IMAGE) throw new Error("Image : 5 Mo au plus.");
  const nom = `${crypto.randomUUID()}.${ext}`;
  await mkdir(dossierActivite(id), { recursive: true, mode: 0o700 });
  await writeFile(join(dossierActivite(id), nom), octets);
  return nom;
}

/** Une image déposée, si son nom est l'un des nôtres et qu'elle existe. */
export async function lireImage(id: string, fichier: string) {
  if (!FICHIER.test(fichier)) return undefined;
  try {
    const octets = await readFile(join(dossierActivite(id), fichier));
    return { octets, mime: MIMES[fichier.split(".").pop()!] };
  } catch {
    return undefined;
  }
}
