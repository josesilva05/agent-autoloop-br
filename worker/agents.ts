// Um Agent é um processo: dê um prompt a ele e leia sua última mensagem no que ele imprime. Um adapter é o que difere
// de um para outro: sua linha de comando e como ler a saída dele. `plugins/<use>/agent.ts`, primeiro na pasta desta
// instalação e depois nos que já vêm com ela. Qualquer coisa com um modo de impressão não precisa de arquivo nenhum:
// `use: "command"` com uma linha de comando no rules.json.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { findOnPath } from "../host/command.ts";
import { loadPlugin } from "../host/plugins.ts";
import type { Usage } from "../protocol/validate.ts";

export type { Usage } from "../protocol/validate.ts";
export type Access = "read" | "edit" | "full";
/** Uma inicialização de um Agent. `resume` é a sessão na qual continuar, se houver; caso contrário `session` é um id novo que ele pode usar. */
export type Turn = {
  prompt: string;
  session: string;
  resume: string | null;
  cwd: string;
  model?: string;
  effort?: string;
  /** A faixa de serviço em que rodar, com a denominação do próprio programa do Agent; plugins cujo programa não tem faixa a ignoram. */
  tier?: string;
  access: Access;
  command?: string[];
  /** O programa que um plugin integrado inicia no lugar do que ele encontra: um wrapper que prepara tudo e o executa. */
  program?: string;
  contextFile: string;
  folder: string;
};
export type Reading = {
  text?: string;
  session?: string;
  /** O que esta inicialização usou. */
  usage?: Usage;
  /** O que a sessão usou até agora, para os valores que o programa só dá assim. */
  sessionUsage?: Usage;
  error?: string;
  /** O turno dele acabou, ainda que ele possa não ter saído. */
  finished?: boolean;
  /** Ele tem o prompt deste turno, numa conversa que existe. Daqui em diante o trabalho pode estar pela metade. */
  started?: boolean;
};
export type Adapter = {
  /** A linha de comando dele para este turno. */
  command(turn: Turn): string[];
  /** O que a saída dele diz até agora. `code` é null enquanto ele ainda roda, ou quando morreu sem dizer. */
  read(stdout: string, code: number | null, stderr: string): Reading;
  /** Onde uma pessoa pode abrir esta sessão. */
  link?(session: string): string;
  /** Se está instalado e com login feito, como `program` se suas regras nomeiam um: o que há de errado, em palavras com que uma pessoa possa agir, ou nada. */
  check?(program?: string): string | null;
};

const adapters = new Map<string, Adapter>();

export async function adapterFor(use: string): Promise<Adapter> {
  const known = adapters.get(use);
  if (known) return known;
  const adapter = (await loadPlugin(use, "agent")) as Adapter;
  adapters.set(use, adapter);
  return adapter;
}

// Só os acertos são guardados: uma atualização pode deixar um programa ausente por um instante (`npm install -g` remove
// primeiro o antigo), e um erro guardado faria toda rodada seguinte falhar até o worker reiniciar.
const found = new Map<string, string>();

/** Onde um programa está: no PATH do shell de login (launchd e systemd começam com um PATH cru), ou em um destes. */
export function findProgram(name: string, elsewhere: () => string[] = () => []) {
  let program = found.get(name);
  if (!program) {
    let onPath: string | null = null;
    if (process.platform === "win32") onPath = findOnPath(name, [".exe", ".com", ".cmd", ".ps1"]);
    else {
      try {
        const printed = execFileSync(process.env.SHELL ?? "/bin/sh", ["-lc", `command -v ${name}`], {
          encoding: "utf8",
          timeout: 15_000,
          stdio: ["ignore", "pipe", "ignore"],
        });
        onPath = printed.trim().split("\n").at(-1) || null;
      } catch {}
    }
    program = onPath ?? elsewhere().find(existsSync);
    if (!program) throw new Error(`Não encontrei ${name}: instale-o e faça login primeiro`);
    found.set(name, program);
  }
  return program;
}

/** O fim de alguma saída, para dizer por que algo falhou. */
export const tail = (text: string, length = 300) => text.trim().slice(-length);
