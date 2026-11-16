// `agent-autoloop uninstall`: retira o que a instalação colocou neste computador e nada mais. Um link só é nosso se realmente
// levar a este programa: o agent-autoloop de outra pessoa, ou uma pasta dela com esse nome, fica onde está.
import { existsSync, lstatSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HOME } from "../host/home.ts";
import { removeService, stopUp } from "../host/service.ts";
import { powershell, psQuote } from "../host/command.ts";

const ROOT = path.join(import.meta.dirname, "..");

function removeLink(link: string, target: string) {
  if (!lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) return;
  try {
    if (realpathSync(link) !== realpathSync(target)) return;
  } catch {
    return; // Não leva a lugar nenhum, então não veio daqui.
  }
  // Não é rmSync: o Node 25.1 o recusa para um link que leva a uma pasta.
  unlinkSync(link);
  console.log(`Removido: ${link}`);
}

function removeLinks() {
  const program = path.join(ROOT, "bin", "agent-autoloop.ts");
  const onPath = (process.env.PATH ?? "").split(path.delimiter).filter((place) => path.isAbsolute(place));
  const places = [path.join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", ...onPath];
  for (const place of new Set(places)) removeLink(path.join(place, "agent-autoloop"), program);
  const skill = path.join(ROOT, "skills", "agent-autoloop");
  for (const agent of [".claude", ".codex"]) removeLink(path.join(homedir(), agent, "skills", "agent-autoloop"), skill);
}

/** A confirmação é sobre remover o programa; os dados nunca fazem parte deste comando. */
export async function uninstall(yes: boolean, ask: ((question: string) => Promise<string>) | null) {
  if (!yes) {
    if (!ask)
      throw new Error(
        "Execute agent-autoloop uninstall --yes para desinstalar o programa; regras, chaves e registros serão preservados.",
      );
    if (!/^y(es)?$/i.test((await ask("Desinstalar o programa e preservar os dados? [y/N] ")).trim())) {
      console.log("Nada foi desinstalado.");
      return;
    }
  }
  removeService();
  stopUp();
  removeLinks();
  const installedApp = path.join(HOME, "app");
  if (existsSync(installedApp) && realpathSync(installedApp) === realpathSync(ROOT)) {
    if (process.platform === "win32") {
      powershell(`$old = [Environment]::GetEnvironmentVariable('Path', 'User');
        $next = ($old -split ';' | Where-Object { $_ -ne ${psQuote(path.join(ROOT, "bin"))} }) -join ';';
        if ($next -ne $old) { [Environment]::SetEnvironmentVariable('Path', $next, 'User') }`);
    }
    rmSync(installedApp, { recursive: true });
  }
  console.log(
    existsSync(HOME)
      ? `Desinstalação concluída. Regras, chaves e registros continuam em ${HOME}.`
      : "Desinstalação concluída.",
  );
}
