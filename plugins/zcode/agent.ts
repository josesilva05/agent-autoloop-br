// ZCode: o bundle de CLI que vem com o aplicativo desktop, rodando headless. O `-p` responde a um prompt e imprime um
// objeto JSON no fim: sessionId, response e os tokens que o provedor usou. Uma rodada continuada passa --resume sess_…,
// e os modos do próprio ZCode são a configuração de acesso: plan lê, edit deixa trabalhar, yolo não pergunta nada.
//
// O objeto é escrito uma vez só, no fim, então uma execução que morre não deixa session id. Ele conta como iniciado
// assim que o processo roda; a única falha que pode abrir uma sessão nova é um id de resume que o ZCode não conhece.
import { execFileSync } from "node:child_process";
import { commandLine } from "../../host/command.ts";
import { findProgram, tail, type Adapter, type Reading, type Usage } from "../../worker/agents.ts";

const MODE = { read: "plan", edit: "edit", full: "yolo" } as const;

/** O pacote do Windows é um bundle .cjs: quem inicia é o node, não a plataforma. Um launcher nativo é usado como está. */
function launch(program: string) {
  return /\.(?:cjs|mjs|js)$/i.test(program) ? [process.execPath, program] : [program];
}

/** O último objeto JSON completo no que ele imprimiu; a resposta pode vir depois de uma linha de aviso. */
function lastJsonObject(text: string): any {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {}
  const end = text.lastIndexOf("}");
  if (end < 0) return null;
  // lastIndexOf com -1 ainda acha uma chave na posição 0, então pare depois de tentar o começo do texto.
  for (let start = text.lastIndexOf("{", end); start >= 0; start = start ? text.lastIndexOf("{", start - 1) : -1) {
    try {
      const value = JSON.parse(text.slice(start, end + 1));
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {}
  }
  return null;
}

/** Os tokens por rodada do provedor. O `inputTokens` já inclui o que veio do cache dele, como faz o do Codex. */
function usageOf(value: any): Usage | undefined {
  const raw = value?.usage;
  if (!raw || typeof raw !== "object") return undefined;
  const usage: Usage = {};
  for (const [from, to] of [
    ["inputTokens", "input"],
    ["outputTokens", "output"],
    ["cacheReadTokens", "cached"],
  ] as const) {
    if (typeof raw[from] === "number") usage[to] = raw[from];
  }
  return Object.keys(usage).length ? usage : undefined;
}

export default {
  command: (turn) => [
    ...launch(turn.program ?? findProgram("zcode")),
    "--mode",
    MODE[turn.access],
    "--surface",
    "terminal",
    "--no-color",
    "--json",
    ...(turn.resume ? ["--resume", turn.resume] : []),
    "-p",
    turn.prompt,
  ],
  read(stdout, code, stderr): Reading {
    const value = lastJsonObject(stdout);
    if (value) {
      const session = typeof value.sessionId === "string" && value.sessionId ? value.sessionId : undefined;
      const usage = usageOf(value);
      const text = typeof value.response === "string" ? value.response : "";
      if (code !== null && code !== 0) {
        return { session, usage, started: true, error: tail(stderr) || `código de saída ${code}: ZCode não terminou` };
      }
      if (!text.trim()) return { session, usage, started: true, error: "o ZCode não concluiu nem deixou um resultado" };
      return { text, session, usage, started: true, finished: true };
    }
    if (code === null) return { started: true };
    const said = tail(stderr);
    // Um id de sessão que o CLI não conhece é o único caso em que uma nova é o certo. Qualquer outra coisa que chegou
    // até aqui pode ter feito trabalho, então continua na sessão em que lhe disseram para seguir.
    const lost = /session not found/i.test(said);
    if (!said && code === 0) return { started: true, error: "o ZCode não concluiu nem deixou um resultado" };
    return { started: !lost, error: said || `código de saída ${code}: não deixou motivo` };
  },
  check(program) {
    try {
      execFileSync(...commandLine([...launch(program ?? findProgram("zcode")), "version"]), {
        encoding: "utf8",
        timeout: 20_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return null;
    } catch (error) {
      return `ZCode não está utilizável: rode zcode -p "hi" para ver (${(error as Error).message.split("\n")[0]})`;
    }
  },
} satisfies Adapter;
