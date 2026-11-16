// Um plugin na pasta desta instalação vence um plugin que já vem com ela.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HOME } from "./home.ts";

export async function loadPlugin(name: string, kind: "agent" | "channel" | "source") {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`Nome de plugin inválido: ${name}`);
  const entry = join(name, `${kind}.ts`);
  const file = [join(HOME, "plugins", entry), join(import.meta.dirname, "..", "plugins", entry)].find(existsSync);
  if (!file) throw new Error(`Não existe plugin para ${name} (plugins/${name}/${kind}.ts)`);
  return (await import(pathToFileURL(file).href)).default;
}
