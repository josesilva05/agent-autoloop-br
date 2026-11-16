// DSH (DeepSeek Harness), 0.2.2 ou mais novo: `dsh headless` responde a uma tarefa e sai. Com --json ele imprime um
// evento por linha: o `session` de abertura tem o id em que uma rodada seguinte continua, cada `step_end` tem os tokens
// daquele passo, e a última linha, `final`, tem a resposta e o motivo de a última rodada ter terminado. Uma rodada pode
// terminar com a execução ainda em andamento, esperando trabalho em segundo plano que talvez inicie outra, então só o
// `final` diz que acabou. Uma sessão continuada mantém as permissões com que foi salva, a menos que digam o contrário,
// então elas são dadas toda vez; não há ninguém ali para aprovar nada, então uma chamada que precise de aprovação é
// recusada em vez de ficar esperando. Ele não tem sessão de desktop para abrir.
import { execFileSync } from "node:child_process";
import { commandLine } from "../../host/command.ts";
import { findProgram, tail, type Adapter, type Reading, type Usage } from "../../worker/agents.ts";
import { addUsage } from "../../protocol/validate.ts";

const PRESET = { read: "read-only", edit: "workspace-write", full: "danger-full-access" };
const NOT_FINISHED = "o DSH não terminou esta rodada";
const NO_RESULT = "o DSH não concluiu nem deixou um resultado";
const WHY_NOT: Record<string, string> = {
  aborted: "esta rodada foi abortada",
  blocked: "esta rodada travou e não concluiu",
  "max-tokens": "esta rodada esgotou o limite de saída",
};

/** O dsh reporta os tokens de cada passo como inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens. O
 * inputTokens dele deixa de fora as leituras e gravações do cache; `input` conta tudo, como faz o do Codex. */
function stepUsage(reported: any): Usage | undefined {
  if (!reported || typeof reported !== "object") return undefined;
  const step: Usage = {};
  const count = (value: unknown) => (typeof value === "number" ? value : 0);
  if (typeof reported.inputTokens === "number")
    step.input = reported.inputTokens + count(reported.cacheReadTokens) + count(reported.cacheWriteTokens);
  if (typeof reported.outputTokens === "number") step.output = reported.outputTokens;
  if (typeof reported.cacheReadTokens === "number") step.cached = reported.cacheReadTokens;
  return Object.keys(step).length ? step : undefined;
}

export default {
  command: (turn) => [
    turn.program ?? findProgram("dsh"),
    "headless",
    "--json",
    "--permission-mode",
    PRESET[turn.access],
    "--approval-policy",
    "never",
    ...(turn.resume ? ["--session-id", turn.resume] : []),
    turn.prompt,
  ],
  read(stdout, code, stderr) {
    let session: string | undefined;
    let final: { text?: unknown; reason?: { kind?: string; error?: { message?: string } } | null } | undefined;
    let failed: string | undefined;
    let usage: Usage | undefined;
    for (const line of stdout.split("\n")) {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      // O profile de um shell de login também imprime aqui, e `null` é JSON válido.
      if (!event || typeof event !== "object") continue;
      if (event.type === "session" && typeof event.sessionId === "string") session = event.sessionId;
      else if (event.type === "status" && event.phase === "step_end") usage = addUsage(usage, stepUsage(event.usage));
      else if (event.type === "final") final = event;
      // Com --json, um erro na forma como ele foi iniciado vai parar aqui e em nenhum outro lugar.
      else if (event.type === "error" && typeof event.message === "string") failed = event.message;
    }
    const reading: Reading = { ...(session && { session }), ...(usage && { usage }) };
    // Ele tem o prompt desta rodada numa Session que existe. Daqui em diante o trabalho pode estar pela metade, então
    // uma rodada seguinte continua na mesma Session em vez de começar de novo.
    if (session) reading.started = true;
    if (final) {
      reading.finished = true;
      const kind = final.reason?.kind;
      if (kind === "completed") {
        if (typeof final.text === "string" && final.text.trim()) reading.text = final.text;
        else reading.error = NO_RESULT;
      } else if (kind === "error") reading.error = final.reason?.error?.message || NOT_FINISHED;
      else reading.error = WHY_NOT[kind ?? ""] ?? NOT_FINISHED;
    } else if (code !== null) {
      const why = failed || tail(stderr);
      if (code !== 0) reading.error = `código de saída ${code}: ${why || "não deixou motivo"}`;
      else reading.error = why || NO_RESULT;
    }
    return reading;
  },
  check(program) {
    try {
      const help = execFileSync(...commandLine([program ?? findProgram("dsh"), "headless", "--help"]), {
        encoding: "utf8",
        timeout: 20_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      // As opções de que isto precisa chegaram na 0.2.2, e o `latest` do npm ainda está atrás disso.
      if (!help.includes("--approval-policy"))
        return "A versão do DSH é antiga demais; é preciso 0.2.2 ou mais nova: npm install -g @deepseek-ai/dsh@next --allow-scripts=koffi,node-pty,@deepseek-ai/dsh-subprocess-local";
      return null;
    } catch (error) {
      return `DSH não está utilizável: rode dsh headless "hi" para ver (${(error as Error).message.split("\n")[0]})`;
    }
  },
} satisfies Adapter;
