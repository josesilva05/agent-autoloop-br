// Cada arquivo de teste roda no seu próprio processo, com seu próprio home e as regras do fixture; os módulos são
// importados depois que isto define o ambiente que eles leem.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { after } from "node:test";

export const beforeCleanup: (() => void)[] = [];

export function setup(name: string, rules = "rules.fixture.json") {
  const directory = mkdtempSync(join(tmpdir(), `agent-autoloop-${name}-`));
  process.env.AGENT_AUTOLOOP_HOME = directory;
  process.env.AGENT_AUTOLOOP_RULES = isAbsolute(rules) ? rules : join(import.meta.dirname, rules);
  process.env.AGENT_AUTOLOOP_PUBLIC_URL = "https://hub.test";
  after(() => {
    for (const close of beforeCleanup) close();
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/** Um instante no tempo do próprio teste, em minutos após um início fixo: 10:00 em Asia/Shanghai. */
export const at = (minutes: number) => Date.parse("2026-10-18T02:00:00.000Z") + minutes * 60_000;

/**
 * Um Agent ACP substituto num arquivo só dele, para rodar de verdade. Ele responde como um Agent deve responder, a menos
 * que `script` diga o contrário substituindo `on[method]`, com `send`, `update`, `say` e `ask` à disposição. Um
 * teimoso também tem que terminar por conta própria: um teste que falha não pode deixar nada rodando.
 */
export function acpAgent(dir: string, name: string, script = "") {
  const file = join(dir, `${name}.mjs`);
  writeFileSync(
    file,
    `
import { appendFileSync, closeSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
const send = (x) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...x }) + '\\n');
const update = (update) => send({ method: 'session/update', params: { sessionId: 'agent-session', update } });
const say = (text, messageId) => update({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } });
const options = [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }];
const waiting = new Map();
const ask = (toolCall) => new Promise((resolve) => {
  const id = 1000 + waiting.size;
  waiting.set(id, resolve);
  send({ id, method: 'session/request_permission', params: { sessionId: 'agent-session', toolCall, options } });
});
const on = {
  initialize: (m) => send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }),
  'session/new': (m) => send({ id: m.id, result: { sessionId: 'agent-session' } }),
  'session/load': (m) => send({ id: m.id, result: {} }),
  'session/prompt': (m) => { say('Concluído'); send({ id: m.id, result: { stopReason: 'end_turn' } }); },
};
${script}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method) on[m.method]?.(m);
  else waiting.get(m.id)?.(m.result);
});
`,
  );
  return file;
}
