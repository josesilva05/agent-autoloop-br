// Controle de regras por HTTP e pela linha de comando. Casos de falha: alguém que não é o titular pausa, retoma ou
// executa uma regra; uma regra desconhecida recebe 200 ou 500 em vez de dizer que não existe; um campo com erro de
// grafia é ignorado; executar uma regra pausada é aceito; o estado não mostra quem pausou o quê, por quê e até quando;
// uma tarefa que roda em outro lugar, mesmo uma que pode perguntar e seguir no seu cwd, é pausada ou executada como se
// fosse uma regra; a linha de comando não alcança estas portas ou não diz nada útil. O que uma pausa ignorou não é
// contado enquanto ela dura, não é listado por completo ao ser suspensa, absorve o que uma pausa anterior ignorou, ou não
// pode ser reexecutado de uma vez depois de suspensa; a linha de comando não diz que uma pausa não segura nada para
// depois, ou deixa o titular procurar os eventos ignorados.
// O estado omite o model com que uma tarefa de outro lugar foi registrada, ou inventa um para uma tarefa que não nomeou nenhum.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setup, beforeCleanup } from "./helpers.ts";

const home = setup("pause-http");
const rulesFile = join(home, "rules.json");
const fixture = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_RULES!, "utf8"));
fixture.elsewhere.push({
  ...fixture.elsewhere[0],
  name: "limpeza que pergunta",
  cwd: "/tmp",
  prompt: "Continue a limpeza.",
  model: "some-model",
  effort: "high",
});
writeFileSync(rulesFile, JSON.stringify(fixture));
process.env.AGENT_AUTOLOOP_RULES = rulesFile;
const { serve } = await import("../host/http.ts");
const { addKey, db } = await import("../host/runtime.ts");
beforeCleanup.push(() => {
  if (db.isOpen) db.close();
});

const owner = addKey("owner", "owner");
const worker = addKey("worker", "w1");
const source = addKey("source", "app");
const server = serve(0, "127.0.0.1");
let base = "";
before(async () => {
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  writeFileSync(join(home, "config.json"), JSON.stringify({ url: base, owner }));
});
after(() => {
  server.closeAllConnections();
  server.close();
});

async function post(path: string, body?: unknown, key = owner) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}
const state = async () => (await fetch(`${base}/v1/state`, { headers: { authorization: `Bearer ${owner}` } })).json();
test("uma tarefa em outro lugar mostra o model e o effort com que foi registrada, e nenhum quando não nomeou nenhum", async () => {
  const { elsewhere } = await state();
  const named = elsewhere.find((task: any) => task.name === "limpeza que pergunta");
  assert.deepEqual([named.model, named.effort], ["some-model", "high"]);
  const plain = elsewhere.find((task: any) => task.name !== "limpeza que pergunta");
  assert.deepEqual(["model" in plain, "effort" in plain], [false, false]);
});

const lineOf = async (name: string) => (await state()).lines.find((line: { name: string }) => line.name === name);
const rule = (name: string, action: string) => `/v1/rules/${encodeURIComponent(name)}/${action}`;
const send = async (id: string, subject: string) =>
  (await post("/v1/events", { id, type: "feedback.new", subject, summary: `feedback de ${subject}` }, source)).json
    .event;

test("só o titular controla as regras", async () => {
  for (const path of [rule("inspeção", "pause"), rule("inspeção", "resume"), rule("inspeção", "run")]) {
    assert.equal((await post(path, {}, worker)).status, 401, path);
    assert.equal((await post(path, {}, "made-up")).status, 401, path);
  }
});

test("pausar, ver no estado, recusar uma execução, retomar, executar", async () => {
  const until = new Date(Date.now() + 3600_000).toISOString();
  const paused = await post(rule("inspeção", "pause"), { reason: "o upstream está em manutenção", until });
  assert.equal(paused.status, 200);
  assert.equal(paused.json.changed, true);
  const shown = await lineOf("inspeção");
  assert.deepEqual(
    [shown.paused.by, shown.paused.reason, shown.paused.until],
    ["owner", "o upstream está em manutenção", until],
  );
  assert.ok(shown.paused.since);
  assert.deepEqual(
    (await state()).pauses.map((p: any) => [p.name, p.reason]),
    [["inspeção", "o upstream está em manutenção"]],
  );
  assert.equal(
    (await post(rule("inspeção", "pause"), { reason: "o upstream está em manutenção", until })).json.changed,
    false,
  );
  const refused = await post(rule("inspeção", "run"));
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /está pausada/);
  assert.equal((await post(rule("inspeção", "resume"))).json.changed, true);
  assert.equal((await lineOf("inspeção")).paused, null);
  const ran = await post(rule("inspeção", "run"), { reason: "dar uma olhada" });
  assert.equal(ran.status, 200);
  const run = (await state()).runs.find((r: any) => r.id === ran.json.run);
  assert.deepEqual([run.rule, run.state, run.manual, run.events[0].type], ["inspeção", "queued", true, "run.manual"]);
});

test("o que uma pausa ignora é contado enquanto ela dura, listado ao ser suspensa e reexecutado uma vez", async () => {
  await post(rule("opiniões", "pause"), { reason: "a anterior" });
  const earlier = await send("h0", "#0");
  await post(rule("opiniões", "resume"));
  const paused = await post(rule("opiniões", "pause"), { reason: "o downstream está em manutenção" });
  assert.deepEqual(paused.json.paused.skipped, { count: 0, events: [] });
  const first = await send("h1", "#1");
  const second = await send("h2", "#2");
  const shown = (await lineOf("opiniões")).paused.skipped;
  assert.deepEqual([shown.count, shown.events.map((e: any) => e.id)], [2, [second, first]]);
  const since = paused.json.paused.since;
  assert.equal((await post(rule("opiniões", "replay"), { since })).status, 409, "não enquanto ainda estiver pausada");
  const resumed = await post(rule("opiniões", "resume"));
  assert.equal(resumed.json.paused.since, since);
  assert.deepEqual(
    resumed.json.paused.skipped.events.map((e: any) => [e.id, e.source, e.type, e.subject, e.summary]),
    [
      [second, "app", "feedback.new", "#2", "feedback de #2"],
      [first, "app", "feedback.new", "#1", "feedback de #1"],
    ],
  );
  assert.equal(resumed.json.paused.skipped.count, 2, "só os desta pausa");
  assert.equal((await post(rule("opiniões", "replay"), {})).status, 400);
  assert.equal((await post(rule("opiniões", "replay"), { since }, worker)).status, 401);
  const replayed = await post(rule("opiniões", "replay"), { since });
  assert.deepEqual(replayed.json.events, [first, second]);
  assert.equal(replayed.json.runs.length, 2);
  assert.deepEqual((await post(rule("opiniões", "replay"), { since })).json, { events: [], runs: [] });
  assert.ok(
    (await state()).skipped.some((e: any) => e.id === earlier),
    "o que a pausa anterior ignorou continua como estava",
  );
  const schedule = await post(rule("inspeção", "pause"), {});
  assert.equal(schedule.json.paused.skipped, null, "um agendamento ignora momentos, não eventos");
  await post(rule("inspeção", "resume"));
});

test("um nome ou corpo errado diz o que está errado", async () => {
  const unknown = await post(rule("inexistente", "pause"), {});
  assert.equal(unknown.status, 404);
  assert.match(unknown.json.error, /Não existe esta regra: inexistente/);
  assert.equal((await post(rule("inexistente", "run"))).status, 404);
  for (const task of ["limpeza semanal", "limpeza que pergunta"]) {
    for (const action of ["pause", "run"]) {
      const elsewhere = await post(rule(task, action), {});
      assert.equal(elsewhere.status, 400, `${task} ${action}`);
      assert.match(elsewhere.json.error, /tarefa agendada executada em outro lugar/);
    }
  }
  const misspelt = await post(rule("inspeção", "pause"), { reson: "x" });
  assert.equal(misspelt.status, 400);
  assert.match(misspelt.json.error, /reson/);
  assert.equal((await post(rule("inspeção", "pause"), { until: "amanhã" })).status, 400);
  assert.equal((await post(rule("inspeção", "pause"), [])).status, 400);
});

// Não spawnSync: a central que responde roda neste processo.
const cli = (...args: string[]) =>
  new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    const program = ["--disable-warning=ExperimentalWarning", "bin/agent-autoloop.ts", ...args];
    execFile(process.execPath, program, { cwd: join(import.meta.dirname, "..") }, (error, stdout, stderr) =>
      resolve({ status: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
    );
  });

test("a linha de comando pausa, retoma e executa", async () => {
  let done = await cli("pause", "briefing matinal", "--reason", "de folga");
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /"briefing matinal" pausada/);
  done = await cli("status");
  assert.match(done.stdout, /Pausadas[\s\S]*briefing matinal: de folga/);
  done = await cli("run", "briefing matinal");
  assert.equal(done.status, 1);
  assert.match(done.stderr, /está pausada/);
  done = await cli("resume", "briefing matinal");
  assert.match(done.stdout, /"briefing matinal" retomada/);
  done = await cli("run", "briefing matinal");
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /Na fila: rodada \d+/);
  done = await cli("pause", "inexistente");
  assert.equal(done.status, 1);
  assert.match(done.stderr, /Não existe esta regra/);
});

test("a linha de comando diz que uma pausa não segura nada, lista o que ela ignorou ao retomar e o reexecuta", async () => {
  let done = await cli("pause", "opiniões", "--reason", "o downstream está em manutenção");
  assert.equal(done.status, 0, done.stderr);
  assert.match(
    done.stdout,
    /"opiniões" pausada\.\n.*não recebe eventos nem os enfileira.*ao retomar eles serão listados/,
  );
  await send("c1", "#5");
  done = await cli("status");
  assert.match(done.stdout, /opiniões: o downstream está em manutenção\n.*1 eventos ignorados\n.*#5: feedback de #5/);
  done = await cli("resume", "opiniões");
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /"opiniões" retomada\..*1 eventos foram ignorados, sem reexecução:\n.*#5: feedback de #5/);
  const [, since] = /Reexecutar estes 1: agent-autoloop replay opiniões --since (\S+)/.exec(done.stdout) ?? [];
  assert.ok(since, done.stdout);
  done = await cli("replay", "opiniões", "--since", since);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /1 eventos reexecutados; rodadas \d+ colocadas na fila/);
  done = await cli("replay", "opiniões", "--since", since);
  assert.match(done.stdout, /Nenhum evento para reexecutar/);
  done = await cli("replay", "opiniões");
  assert.equal(done.status, 1);
  assert.match(done.stderr, /--since/);
});
