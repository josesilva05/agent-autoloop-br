// Uma rodada executada pelo Agent Client Protocol: um processo só dela, que conversa com o Agent ACP por stdio e
// imprime aquilo que o adapter do worker lê, um objeto JSON por linha.
import { spawn } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { commandLine } from "../../host/command.ts";
import { eachLine } from "../../host/lines.ts";
import { versionName } from "../../host/version.ts";
import type { Turn } from "../../worker/agents.ts";

/** O Agent disse não — em vez de sumir, de não dizer nada ou de estar com o que foi pedido em uso. */
class Refused extends Error {}

const isLink = (file: string) => {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * Onde um caminho realmente está, ainda que possa não existir por enquanto; null se passa por um link sem nada na ponta.
 * Escrever através de um cria aquilo para o qual ele aponta, então não pode contar como arquivo novo onde o link está.
 */
function resolved(file: string): string | null {
  if (existsSync(file)) return realpathSync(file);
  const folder = resolved(dirname(file));
  if (folder === null) return null;
  const path = resolve(folder, basename(file));
  return isLink(path) ? null : path;
}

export function permission(turn: Pick<Turn, "access" | "cwd">, params: any) {
  const tool = params.toolCall ?? {};
  const inside = (location: any) => {
    if (typeof location.path !== "string" || !isAbsolute(location.path)) return false;
    const target = resolved(location.path);
    if (target === null) return false;
    const path = relative(realpathSync(turn.cwd), target);
    return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  };
  const editsInside =
    turn.access === "edit" && tool.kind === "edit" && tool.locations?.length > 0 && tool.locations.every(inside);
  const allowed = turn.access === "full" || tool.kind === "read" || tool.kind === "search" || editsInside;
  const option = params.options?.find((option: any) => option.kind === (allowed ? "allow_once" : "reject_once"));
  return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
}

export async function bridge(turn: Turn) {
  if (!turn.command?.length) throw new Error("O ACP precisa do comando de inicialização em command");
  // A tentativa anterior pode ter feito o trabalho nesta sessão, então o que quer que quebre agora não diz nada sobre
  // se uma sessão nova o refaria. Só o não do próprio Agent desfaz isto; veja goOn.
  if (turn.resume) console.log(JSON.stringify({ session: turn.resume, started: true }));
  const [program, args] = commandLine(turn.command);
  const child = spawn(program, args, { cwd: turn.cwd, stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let next = 0;
  let session = "";
  let collecting = false;
  let text = "";
  let message: string | undefined;
  let boundary = false;
  const send = (body: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...body }) + "\n");
  const fail = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", (code) => fail(new Error(`O ACP saiu antes de devolver o resultado: ${code}`)));
  child.stdin.on("error", fail);

  const toolCalls = new Map<string, object>();
  /** Tudo o que já foi dito da chamada de ferramenta. Uma mensagem pode dar só o id; campo omitido ou null não muda. */
  const toolCall = (said: any) => {
    const fields = Object.entries(said ?? {}).filter(([, value]) => value !== null && value !== undefined);
    const known = { ...toolCalls.get(said?.toolCallId), ...Object.fromEntries(fields) };
    if (said?.toolCallId) toolCalls.set(said.toolCallId, known);
    return known;
  };

  const onUpdate = (update: any) => {
    if (["tool_call", "tool_call_update"].includes(update.sessionUpdate)) toolCall(update);
    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
      // Um id diz que mensagem é esta. Só na falta dele é que o que veio no meio tem que dizer.
      if (update.messageId ? update.messageId !== message : boundary) text = "";
      message = update.messageId;
      boundary = false;
      text += update.content.text;
    } else if (
      ["tool_call", "agent_thought_chunk", "user_message_chunk"].includes(update.sessionUpdate) ||
      (update.sessionUpdate === "tool_call_update" && ["completed", "failed"].includes(update.status))
    ) {
      boundary = true;
    }
  };
  const onLine = (line: string) => {
    const incoming = JSON.parse(line);
    if (incoming.method === "session/update" && collecting && incoming.params?.sessionId === session) {
      onUpdate(incoming.params.update);
    } else if (incoming.method && incoming.id !== undefined) {
      const { id, method, params } = incoming;
      if (method === "session/request_permission" && params?.sessionId === session) {
        send({ id, result: { outcome: permission(turn, { ...params, toolCall: toolCall(params.toolCall) }) } });
      } else send({ id, error: { code: -32601, message: "este método não é suportado" } });
    } else if (pending.has(incoming.id)) {
      const request = pending.get(incoming.id)!;
      pending.delete(incoming.id);
      if (incoming.error) {
        // Uma sessão aberta em outro lugar agora não é uma recusa: uma nova refaria o trabalho. Vale o motivo, e não o
        // código, que é genérico: o não de outro Agent sob ele tem que seguir sendo não, ou nunca teria sessão nova.
        const inUse = incoming.error.data?.reason === "thread_active_writer";
        request.reject(new (inUse ? Error : Refused)(incoming.error.message));
      } else request.resolve(incoming.result);
    }
  };
  let over = false;
  eachLine(
    child.stdout,
    (line) => {
      if (over) return;
      try {
        onLine(line);
      } catch (error) {
        fail(error as Error);
      }
    },
    // Um Agent que morre encerra a saída primeiro, e a saída dele diz mais. Um que segue vivo depois disto desligou.
    () => setTimeout(() => fail(new Error("O ACP fechou a saída antes de devolver o resultado")), 1000).unref(),
  );

  const rpc = (method: string, params: object) =>
    new Promise<any>((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  const goOn = async (can: any) => {
    const method = can?.loadSession ? "session/load" : can?.sessionCapabilities?.resume ? "session/resume" : null;
    try {
      if (!method) throw new Refused("este Agent ACP não permite retomar a sessão");
      await rpc(method, { sessionId: session, cwd: turn.cwd, mcpServers: [] });
    } catch (error) {
      if (error instanceof Refused) console.log(JSON.stringify({ started: false }));
      throw error;
    }
  };
  const stop = () => child.kill("SIGTERM");
  process.on("SIGTERM", stop);
  try {
    const clientInfo = { name: "agent-autoloop", version: versionName() };
    const init = await rpc("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo });
    if (init.protocolVersion !== 1) throw new Error(`não há suporte para a versão ${init.protocolVersion} do ACP`);
    if (turn.resume) {
      session = turn.resume;
      await goOn(init.agentCapabilities);
    } else {
      const { sessionId } = await rpc("session/new", { cwd: turn.cwd, mcpServers: [] });
      if (typeof sessionId !== "string" || !sessionId) throw new Error("o ACP não devolveu um identificador de sessão");
      session = sessionId;
    }
    // Antes de enviar o prompt: o Agent pode começar na hora, e isto precisa estar aqui se o bridge for morto então.
    console.log(JSON.stringify({ session, started: true }));
    collecting = true;
    const prompt = [{ type: "text", text: turn.prompt }];
    const result = await rpc("session/prompt", { sessionId: session, prompt });
    if (result.stopReason !== "end_turn") throw new Error(`O ACP não concluiu esta rodada: ${result.stopReason}`);
    // end_turn sem nada dito não é uma rodada interrompida antes da hora: um Agent cujo modelo recusou responde assim, e
    // o motivo de antes citava "end_turn" de volta como se tivesse falhado, sem deixar causa alguma para procurar.
    if (!text.trim()) throw new Error("O ACP disse que a rodada terminou, mas não devolveu texto");
    console.log(JSON.stringify({ session, text, finished: true }));
  } catch (error) {
    // Agora, e não na saída: o Agent, ou o que ele deixou segurando a saída dele, pode prender este processo aqui para
    // sempre, e é isto que deixa o worker encerrá-lo.
    console.log(JSON.stringify({ session: session || undefined, finished: true, error: (error as Error).message }));
    throw error;
  } finally {
    over = true;
    process.removeListener("SIGTERM", stop);
    child.stdin.end();
    child.kill("SIGTERM");
  }
}

if (import.meta.main) {
  bridge(JSON.parse(process.argv[2])).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
