// Modos de falha: uma CLI real nunca termina; um recibo fica ilegível; a resposta perde a sessão; a limpeza deixa um processo
// filho ou um banco de testes para trás. O Codex usa o modelo configurado; o Claude fica fixo no Haiku. Todas as partidas têm um teto de três turnos.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const use = process.argv[2];
assert.ok(["codex", "claude"].includes(use), "Uso: node scripts/real-agents.ts codex|claude");
const home = mkdtempSync(join(tmpdir(), `agent-autoloop-real-${use}-`));
process.env.AGENT_AUTOLOOP_HOME = home;
process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
mkdirSync(join(home, "work"));
writeFileSync(
  process.env.AGENT_AUTOLOOP_RULES,
  JSON.stringify({
    sources: { app: { name: "execução de teste" } },
    agents: {
      real: {
        name: use,
        worker: "test",
        use,
        access: "read",
        timeout: 3,
        ...(use === "claude" ? { model: "claude-haiku-5-5" } : { effort: "low" }),
      },
    },
    channels: {},
    rules: [
      {
        name: "execução de teste",
        when: { source: "app", types: ["test"] },
        to: "real",
        cwd: join(home, "work"),
        prompt:
          'Este é um teste de acesso limitado: leia apenas o arquivo de contexto fornecido e não execute nenhuma outra ação. Quando answers estiver vazio, escreva na primeira linha apenas "Fiz uma pergunta" e anexe o bloco de código agent-autoloop {"ask":[{"title":"Escolha uma cor","text":"execução de teste","options":["Azul","Verde"],"key":"color"}]}. Quando answers não estiver vazio, escreva na última mensagem apenas "Você escolheu verde, execução de teste aprovada" e não faça mais perguntas.',
      },
    ],
  }),
);
const { adapterFor } = await import("../worker/agents.ts");
const adapter = await adapterFor(use);
const launch = adapter.command;
let launches = 0;
adapter.command = (turn) => {
  assert.ok(++launches <= 3, "O teto de três turnos já foi consumido");
  return launch(turn);
};
const hub = await import("../host/runtime.ts");
const { serve } = await import("../host/http.ts");
const { hubClient } = await import("../protocol/client.ts");
const { createWorker } = await import("../worker/worker.ts");
const server = serve(0);
await new Promise((resolve) => server.once("listening", resolve));
const url = `http://127.0.0.1:${(server.address() as any).port}`;
const owner = hubClient(url, hub.addKey("owner", "me"));
const source = hubClient(url, hub.addKey("source", "app"));
const worker = createWorker({ hub: hubClient(url, hub.addKey("worker", "test")), name: "test", wait: 0, capacity: 1 });
const started = Date.now();
async function until(predicate: (s: any) => boolean) {
  while (Date.now() - started < 240000) {
    await worker.tick();
    const state = await owner.state();
    const failed = state.runs.find((r: any) => r.state === "failed" || r.error);
    if (failed) throw new Error(failed.error ?? JSON.stringify(failed));
    if (predicate(state)) return state;
    await delay(200);
  }
  throw new Error("A execução de teste em máquina real passou de quatro minutos");
}
try {
  const problem = adapter.check?.();
  if (problem) throw new Error(problem);
  await source.event({ id: "real", type: "test" });
  const waiting = await until((s) => s.cards.some((c: any) => c.kind === "ask"));
  await owner.answer(waiting.cards[0].id, { choice: 1 });
  const finished = await until((s) =>
    s.runs.some((r: any) => r.state === "done" && r.summary === "Você escolheu verde, execução de teste aprovada"),
  );
  const runs = finished.runs;
  assert.equal(runs.length, 2);
  assert.equal(runs[0].session, runs[1].session);
  assert.ok(runs[0].session);
  console.log(
    JSON.stringify(
      {
        machine: cpus()[0].model,
        node: process.version,
        agent: use,
        model: use === "claude" ? "claude-haiku-5-5" : "Padrão configurado do Codex",
        launches,
        runs: runs.length,
        resumed: true,
        ms: Date.now() - started,
        usage: runs.map((r: any) => r.usage),
      },
      null,
      2,
    ),
  );
} finally {
  for (const entry of worker.entries())
    if (entry.pid) {
      try {
        process.kill(process.platform === "win32" ? entry.pid : -entry.pid, "SIGKILL");
      } catch {}
    }
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  hub.db.close();
  rmSync(home, { recursive: true, force: true });
}
