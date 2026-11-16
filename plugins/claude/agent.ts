// Claude Code: o do próprio usuário, instalado e autenticado por ele. Aqui só roda o programa oficial.
import { execFileSync } from "node:child_process";
import { commandLine } from "../../host/command.ts";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { findProgram, tail, type Adapter } from "../../worker/agents.ts";
import { readMessage, receiptBlock } from "../../worker/contract.ts";

const PERMISSIONS = { read: "plan", edit: "acceptEdits", full: "bypassPermissions" };

/** O Claude Code mais novo que o aplicativo desktop distribui, para quem não tem uma instalação separada. */
export function inTheApp() {
  const root = path.join(homedir(), "Library/Application Support/Claude/claude-code");
  if (!existsSync(root)) return [];
  // O aplicativo guarda arquivos próprios, como auto-update-state.json, ao lado das pastas de versão.
  const folders = (at: string) =>
    readdirSync(at, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  const oldestFirst = folders(root).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return oldestFirst.reverse().flatMap((version) => {
    const builds = folders(path.join(root, version));
    return builds.map((build) => path.join(root, version, build, "claude.app/Contents/MacOS/claude"));
  });
}

export default {
  command: (turn) => [
    turn.program ?? findProgram("claude", inTheApp),
    "-p",
    turn.prompt,
    ...(turn.resume ? ["--resume", turn.resume] : ["--session-id", turn.session]),
    // Conforme avança: com "json" nada sai antes do fim, e uma rodada interrompida não deixa sinal de que começou.
    "--output-format",
    "stream-json",
    "--verbose",
    ...(turn.model ? ["--model", turn.model] : []),
    ...(turn.effort ? ["--effort", turn.effort] : []),
    "--permission-mode",
    PERMISSIONS[turn.access],
    "--add-dir",
    turn.folder,
    // Entrar num worktree move a transcrição inteira para a pasta de projeto do worktree (ainda é assim na 2.1.317): o
    // --resume a encontra, mas o aplicativo desktop, abrindo o link da sessão da pasta da execução, mostrava só a primeira.
    "--disallowedTools=EnterWorktree,ExitWorktree",
  ],
  read(stdout, code, stderr) {
    const messages = stdout.split("\n").flatMap((line) => {
      try {
        // Com "json" e verbose ligado nas configurações dele, cada mensagem vem como um array só, numa linha só.
        return [JSON.parse(line)].flat();
      } catch {
        return [];
      }
    });
    const result = messages.findLast((message) => message?.type === "result");
    const session = messages.findLast((message) => message?.session_id)?.session_id;
    const started =
      result?.num_turns > 0 || messages.some((message) => message?.type === "assistant" || message?.subtype === "init");
    const known = { ...(session && { session }), ...(started && { started }) };
    // Cada rodada termina num result, e uma tarefa em segundo plano o traz de volta para outra quando termina. Só é
    // resposta aquela para a qual não sobrou nada que o faça voltar, a menos que ele tenha saído por conta própria: aí
    // foi sua última palavra.
    const later = messages.slice(messages.lastIndexOf(result) + 1);
    const another = later.some(
      (message) => ["assistant", "user"].includes(message?.type) || message?.subtype === "init",
    );
    const tasks = messages.findLast((message) => message?.subtype === "background_tasks_changed")?.tasks ?? [];
    if (!result || another || (tasks.length && code !== 0)) {
      // As mensagens dele são o que ele estava fazendo, não o que deu errado.
      return code === null
        ? known
        : { ...known, error: tail(stderr || (messages.length ? "" : stdout)) || "não deixou resultado" };
    }
    // O input_tokens dele deixa de fora o que foi lido do cache ou gravado nele; `input` conta tudo, como faz o do Codex.
    const usage = result.usage
      ? {
          input:
            (result.usage.input_tokens ?? 0) +
            (result.usage.cache_read_input_tokens ?? 0) +
            (result.usage.cache_creation_input_tokens ?? 0),
          output: result.usage.output_tokens ?? 0,
          cached: result.usage.cache_read_input_tokens ?? 0,
        }
      : undefined;
    // Com a sessão continuada, ele segue somando o preço da sessão até ali, embora os tokens comecem de novo.
    const sessionUsage = result.total_cost_usd === undefined ? undefined : { cost: result.total_cost_usd };
    const said = String(result.result ?? "");
    // Uma tarefa em segundo plano que termina depois da resposta chama a execução de volta para outra rodada, e a palavra
    // dessa rodada substitui a que carregava o recibo. O que ele pediu à central continua sendo o que ele quer, então as
    // palavras ficam sendo as da última rodada e o recibo vem junto: se for descartado, o cartão que ele pediu nunca
    // existe e o trabalho parece intocado. Um que ele escreveu errado é dele e é escrito de novo; só uma rodada sem
    // recibo algum mantém o anterior.
    const own = readMessage(said);
    const carried =
      own.receipt === undefined && own.problem === undefined
        ? messages
            .slice(0, messages.lastIndexOf(result))
            .filter((message) => message?.type === "result")
            .map((message) => receiptBlock(String(message.result ?? "")))
            .findLast((block) => block !== undefined)
        : undefined;
    const text = carried === undefined ? said : `${said}\n\n${carried}`;
    if (result.is_error || result.subtype !== "success") {
      const error = said.split("\n")[0] || result.errors?.[0] || result.subtype || "não deixou resultado";
      return { ...known, usage, sessionUsage, finished: true, error };
    }
    return { text, ...known, usage, sessionUsage, finished: true };
  },
  link: (session) => `claude://resume?session=${session}`,
  check(given) {
    try {
      const program = given ?? findProgram("claude", inTheApp);
      const status = JSON.parse(
        execFileSync(...commandLine([program, "auth", "status"]), { encoding: "utf8", timeout: 20_000 }),
      );
      return status.loggedIn ? null : "Claude Code não tem login feito: rode claude auth login";
    } catch (error) {
      return `Claude Code não está utilizável: ${(error as Error).message.split("\n")[0]}`;
    }
  },
} satisfies Adapter;
