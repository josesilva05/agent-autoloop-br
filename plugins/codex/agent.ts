// Codex: o do próprio usuário, instalado e autenticado por ele. Uma execução é um `codex exec` em segundo plano; a thread
// dele fica em disco, então uma nova tentativa ou uma resposta pode continuar nela, e o link a abre no aplicativo.
import { execFileSync } from "node:child_process";
import { commandLine, powershell, psQuote } from "../../host/command.ts";
import { findProgram, tail, type Adapter } from "../../worker/agents.ts";

const SANDBOX = { read: "read-only", edit: "workspace-write", full: "danger-full-access" };
export const IN_THE_APP = [
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
];

export default {
  command: (turn) => {
    // O sandbox elevado do Windows roda como CodexSandboxUsers. Compartilhe só os dados fornecidos, nunca o token nem a chave da execução.
    if (process.platform === "win32" && turn.contextFile)
      powershell(`
      try { $sid = ([Security.Principal.NTAccount]::new($env:COMPUTERNAME, 'CodexSandboxUsers')).Translate([Security.Principal.SecurityIdentifier]) }
      catch [Security.Principal.IdentityNotMappedException] { return }
      $file = ${psQuote(turn.contextFile)}
      $acl = [IO.File]::GetAccessControl($file)
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'Read', 'Allow'))
      [IO.File]::SetAccessControl($file, $acl)
    `);
    return [
      turn.program ?? findProgram("codex", () => IN_THE_APP),
      "exec",
      ...(turn.resume ? ["resume"] : []),
      "--json",
      "--skip-git-repo-check",
      ...(turn.model ? ["-m", turn.model] : []),
      ...(turn.effort ? ["-c", `model_reasoning_effort="${turn.effort}"`] : []),
      // Sem isso definido, uma execução usa o tier do ~/.codex/config.toml, um arquivo que o aplicativo Codex compartilha: "priority" é o Fast dele.
      ...(turn.tier ? ["-c", `service_tier="${turn.tier}"`] : []),
      // Como configuração, porque o `codex exec resume` não aceita -s.
      "-c",
      `sandbox_mode="${SANDBOX[turn.access]}"`,
      "-c",
      'approval_policy="never"',
      ...(turn.resume ? [turn.resume] : []),
      "Esta rodada roda por um codex exec em segundo plano; não presuma que o aplicativo desktop já trouxe a conexão de navegador dele para ela. " +
        "Para operações na web, use as ferramentas de navegador realmente disponíveis nesta rodada, ou a entrada de navegador já configurada explicitamente na regra ou no Skill. " +
        "Reaproveite a sessão dessa entrada e entregue apenas os passos na web; o tratamento do negócio e o recibo para a central continuam por conta desta rodada. " +
        "Quando não houver entrada disponível, ou for preciso que o titular restabeleça a conexão, devolva seguindo a convenção do marcador AGUARDANDO VOCÊ.\n\n" +
        turn.prompt,
    ];
  },
  read(stdout, code, stderr) {
    const seen: {
      text?: string;
      session?: string;
      sessionUsage?: object;
      error?: string;
      finished?: boolean;
      started?: boolean;
      completed?: boolean;
    } = {};
    for (const line of stdout.split("\n")) {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      // O profile de um shell de login também imprime aqui, e `null` é JSON válido.
      if (!event) continue;
      if (event.type === "thread.started") seen.session = event.thread_id;
      else if (event.type === "turn.started") seen.started = true;
      else if (event.type === "item.completed" && event.item?.type === "agent_message") seen.text = event.item.text;
      else if (event.type === "turn.completed") {
        seen.completed = seen.finished = true;
        // Uma reconexão é anunciada como um evento de erro e então superada — ele caiu para outro transporte e seguiu
        // adiante —, então não é assim que a rodada terminou. Uma execução concluída foi refeita doze vezes por uma dessas.
        delete seen.error;
        const { input_tokens = 0, output_tokens = 0, cached_input_tokens = 0 } = event.usage ?? {};
        seen.sessionUsage = { input: input_tokens, output: output_tokens, cached: cached_input_tokens };
      } else if (event.type === "turn.failed") {
        seen.finished = true;
        seen.error = event.error?.message || "o Codex não terminou esta rodada";
      } else if (event.type === "error") seen.error = event.message;
    }
    const { completed, ...reading } = seen;
    // Só a última mensagem de uma rodada concluída é a resposta dela; antes disso é apenas até onde ele tinha chegado.
    if (!completed) delete reading.text;
    if (code !== null && !completed && !reading.error)
      reading.error = tail(stderr) || "o Codex não concluiu nem deixou um resultado";
    if (completed && !reading.text?.trim()) reading.error = "o Codex não concluiu nem deixou um resultado";
    return reading;
  },
  link: (session) => `codex://threads/${session}`,
  check(program) {
    try {
      execFileSync(...commandLine([program ?? findProgram("codex", () => IN_THE_APP), "login", "status"]), {
        encoding: "utf8",
        timeout: 20_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return null;
    } catch (error) {
      return `Codex sem login ou não está utilizável: rode codex login (${(error as Error).message.split("\n")[0]})`;
    }
  },
} satisfies Adapter;
