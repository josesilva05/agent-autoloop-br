// Que código é este: a tag de release no seu commit, se houver, e o commit. A tag é o único lugar onde um número de
// versão é escrito: um número guardado num arquivo continua apontando o último release em todo commit posterior a ele
// e fica defasado onde quer que seja copiado.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");

/** O que foi implantado, ou o commit do checkout. É o git quem diz: depois de um gc, a ref de um branch deixa de ser um arquivo próprio. */
export function commitOf(root = ROOT) {
  if (process.env.AGENT_AUTOLOOP_COMMIT) return process.env.AGENT_AUTOLOOP_COMMIT;
  try {
    // Só um checkout tem sua própria entrada .git; cópias extraídas não devem herdar o commit de um repositório pai.
    if (!existsSync(path.join(root, ".git"))) return "dev";
    const args = ["-C", root, "rev-parse", "HEAD"];
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "dev";
  }
}

/** O release deste commit, se ele for um. Uma tag de teste deixada no mesmo commit cede lugar ao release em que ela se tornou. */
export function releaseOf(root = ROOT) {
  try {
    if (!existsSync(path.join(root, ".git"))) return null;
    const args = ["-C", root, "tag", "--points-at", "HEAD"];
    const tags = execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n");
    return tags.find((tag) => /^v\d+\.\d+\.\d+$/.test(tag)) ?? tags.find((tag) => /^v\d+\.\d+\.\d+-/.test(tag)) ?? null;
  } catch {
    return null;
  }
}

/** O que os outros programas recebem como identificação desta versão. */
export function versionName(root = ROOT) {
  return releaseOf(root) ?? commitOf(root).slice(0, 12);
}

export function versionLine(root = ROOT) {
  return `agent-autoloop ${releaseOf(root) ?? "não publicada"} (commit ${commitOf(root).slice(0, 12)})`;
}
