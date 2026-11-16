// Qualquer coisa com um modo de impressão: a linha de comando no rules.json, a última mensagem no stdout. Um script
// também é um Agent, e um comando simples pode nem receber o prompt: ele acha o que precisa pelo ambiente
// (AGENT_AUTOLOOP_CONTEXT).
import { tail, type Adapter } from "../../worker/agents.ts";

const PLACEHOLDER = /\{(prompt|model|effort|cwd|context)\}/g;

export default {
  // Uma passada só, com uma função: o prompt é o que alguém pediu, então um {cwd} ou um $& dentro dessas palavras não é
  // um placeholder delas e precisa chegar exatamente como foi escrito.
  command: (turn) => {
    const values: Record<string, string> = {
      prompt: turn.prompt,
      model: turn.model ?? "",
      effort: turn.effort ?? "",
      cwd: turn.cwd,
      context: turn.contextFile,
    };
    return (turn.command ?? []).map((part) => part.replace(PLACEHOLDER, (_, name: string) => values[name]));
  },
  read(stdout, code, stderr) {
    if (code === null) return {};
    if (code !== 0) return { error: `código de saída ${code}: ${tail(stderr || stdout) || "não deixou motivo"}` };
    return { text: stdout };
  },
} satisfies Adapter;
