// Pausar, retomar e executar uma regra agora, como fatos do titular no log. Casos de falha: um agendamento pausado ainda
// roda, ou acumula seus momentos e os dispara todos ao retomar; retomar depois de a central ter dormido durante a pausa
// executa um momento que caiu nela; uma pausa com fim não termina, ou o seu fim dispara o que foi ignorado; uma regra de
// eventos pausada ainda aceita o evento, ou perde o registro de que o ignorou; outra regra que casa com o mesmo evento
// também é segurada; uma rodada enfileirada antes da pausa, ou uma resposta que chegou durante ela, é entregue enquanto
// pausada ou se perde; uma pausa é esquecida quando a projeção é reconstruída a partir do log; executar agora não passa
// pela fila, não é marcado como do titular, espera o backoff de uma nova tentativa, executa uma regra pausada, ou aceita
// um objeto que evento nenhum poderia carregar; uma regra desconhecida é aceita; pausar de novo sem novidade acrescenta
// um fato ou reinicia o relógio da pausa. Retomar não diz qual pausa suspendeu; uma reexecução entrega à regra qualquer
// coisa que não sejam os eventos que a sua pausa ignorou como chegaram, entrega um duas vezes, segue em frente enquanto
// a regra ainda está pausada, muda o registro do próprio evento, impede que outra regra para a qual a pausa também o
// ignorou o receba, ou não deixa na história da rodada nenhum sinal de que foi uma reexecução.
import assert from "node:assert/strict";
import { test } from "node:test";
import { at, setup } from "./helpers.ts";

setup("pause");
const { execute, getView, tick, ingest, claimNext, heartbeat, finish, stateOf, logAfter, db, why } =
  await import("./hub.ts");
const { rebuild } = await import("../kernel/store.ts");
const { eventOutcome } = await import("../kernel/query.ts");
const { formatWhy } = await import("../cli/why.ts");
const { rows } = await import("../kernel/evolve.ts");
const { all, run } = await import("./storage.ts");

const clean = () => {
  for (const table of ["run_events", "runs", "events", "seen", "cards", "deliveries", "timers", "schedules", "pauses"])
    run(`DELETE FROM ${table}`);
};
const ticks = () =>
  all<{ key: string }>("SELECT key FROM events WHERE type = 'schedule.tick' ORDER BY id").map((e) => e.key);
const runsOf = (rule: string) => all<{ id: number; state: string }>("SELECT * FROM runs WHERE rule = ?", [rule]);
const pause = (name: string, given: object, now: number) => execute("pauseRule", [name, "owner", given], now);
const resume = (name: string, now: number) => execute("resumeRule", [name], now);
const replay = (name: string, events: number[], now: number) => execute("replayRule", [name, events], now);
const line = (name: string, now: number) => stateOf(now).lines.find((l: { name: string }) => l.name === name)!;
const claim = (worker: string, now: number) => claimNext(worker, `c${Math.random()}`, now);

test("um agendamento pausado deixa seus momentos passarem, e retomar executa apenas o próximo", () => {
  clean();
  tick(at(0));
  const done = pause("inspeção", { reason: "o upstream está em manutenção" }, at(1));
  assert.equal(done.changed, true);
  tick(at(5));
  tick(at(10));
  assert.deepEqual(ticks(), [], "nada rodou enquanto estava pausado");
  assert.deepEqual(runsOf("inspeção"), []);
  const shown = line("inspeção", at(11));
  assert.deepEqual(
    [shown.paused?.by, shown.paused?.reason, shown.paused?.until],
    ["owner", "o upstream está em manutenção", null],
  );
  assert.equal(shown.skippedAt, "2026-10-18T02:10:00.000Z");
  assert.equal(resume("inspeção", at(12)).changed, true);
  tick(at(12));
  assert.deepEqual(ticks(), [], "nenhum momento da pausa ficou devendo");
  tick(at(15));
  assert.deepEqual(ticks(), ["inspeção@2026-10-18T02:15:00.000Z"]);
  assert.equal(line("inspeção", at(16)).paused, null);
});

test("uma central que dormiu durante toda a pausa não deve nada por ela ao retomar", () => {
  clean();
  tick(at(0));
  pause("inspeção", {}, at(1));
  resume("inspeção", at(12));
  tick(at(12));
  assert.deepEqual(ticks(), [], "10:05 e 10:10 caíram dentro da pausa");
  tick(at(15));
  assert.deepEqual(ticks(), ["inspeção@2026-10-18T02:15:00.000Z"]);
});

test("uma pausa com fim se suspende ali, e os momentos dentro dela continuam ignorados", () => {
  clean();
  tick(at(0));
  pause("inspeção", { reason: "janela de manutenção", until: new Date(at(12)).toISOString() }, at(1));
  assert.ok(
    rows(getView(), "due").some((due) => due.kind === "pause"),
    "o fim tem um prazo só dele",
  );
  tick(at(5));
  // Adormecida de 10:05 a 10:13: 10:10 estava dentro da pausa, então nada é devido quando ela acorda.
  tick(at(13));
  assert.deepEqual(ticks(), []);
  assert.deepEqual(all("SELECT * FROM pauses"), [], "a pausa encerrada sumiu do registro");
  tick(at(15));
  assert.deepEqual(ticks(), ["inspeção@2026-10-18T02:15:00.000Z"]);
  assert.throws(() => pause("inspeção", { until: new Date(at(10)).toISOString() }, at(20)), /posterior ao agora/);
  assert.throws(() => pause("inspeção", { until: "2026-10-18 12:00" }, at(20)), /com fuso/);
});

test("uma regra de eventos pausada ignora o evento e diz isso; outra regra sobre o mesmo evento ainda o aceita", () => {
  clean();
  heartbeat("w1", [], at(0));
  heartbeat("w2", [], at(0));
  pause("alerta também registra", { reason: "não registrar por enquanto" }, at(0));
  const ack = ingest("ops", { id: "a1", type: "alert.raised", subject: "db" }, at(1));
  assert.deepEqual(ack.routed, ["alerta"]);
  assert.deepEqual(ack.paused, ["alerta também registra"]);
  assert.deepEqual(runsOf("alerta também registra"), []);
  assert.equal(runsOf("alerta").length, 1);
  const again = ingest("ops", { id: "a1", type: "alert.raised", subject: "db" }, at(2));
  assert.deepEqual([again.duplicate, again.routed, again.paused], [true, ["alerta"], ["alerta também registra"]]);
  const state = stateOf(at(3));
  assert.deepEqual(
    state.skipped.map((e: any) => [e.source, e.type, e.subject, e.rules]),
    [["ops", "alert.raised", "db", ["alerta também registra"]]],
  );
  assert.ok(!state.unrouted.some((e: any) => e.key === "a1"), "um evento ignorado não é um que regra nenhuma aceita");
  resume("alerta também registra", at(4));
  assert.deepEqual(runsOf("alerta também registra"), [], "o evento ignorado não é aceito depois");
});

test("trabalho enfileirado antes de uma pausa, ou uma resposta durante ela, espera pelo retorno", () => {
  clean();
  heartbeat("w1", [], at(0));
  ingest("app", { id: "f1", type: "feedback.new", subject: "#1" }, at(0));
  pause("opiniões", {}, at(1));
  assert.equal(claim("w1", at(2)), null, "na fila, mas segurado");
  assert.equal(runsOf("opiniões")[0].state, "queued", "e não perdido");
  resume("opiniões", at(3));
  const job = claim("w1", at(4))!;
  assert.equal(job.rule.name, "opiniões");
  const asked = {
    outcome: "done",
    ask: [
      { title: "responder ou não", text: "o usuário perguntou", options: ["responder", "não responder"], key: "reply" },
    ],
  };
  finish(job.run, job.token, asked, at(5));
  const card = all<{ id: number }>("SELECT id FROM cards WHERE kind = 'ask'")[0];
  pause("opiniões", {}, at(6));
  execute("answer", [card.id, { choice: 0, by: "o titular" }], at(7));
  assert.equal(claim("w1", at(8)), null, "a resposta é enfileirada para o assunto, não entregue");
  resume("opiniões", at(9));
  assert.equal(claim("w1", at(10))!.context.answers.length, 1);
});

test("executar agora enfileira uma rodada pelo caminho de costume, marcada como do titular", () => {
  clean();
  heartbeat("w1", [], at(0));
  const done = execute("runRule", ["inspeção", "owner", { reason: "dar uma olhada" }], at(1));
  const job = claim("w1", at(2))!;
  assert.equal(job.run, done.run);
  assert.deepEqual(
    job.context.events.map((e) => [e.source, e.type, e.summary, e.detail]),
    [["schedule", "run.manual", "owner executou manualmente", "dar uma olhada"]],
  );
  const shown = stateOf(at(3)).runs.find((r: any) => r.id === done.run)!;
  assert.equal(shown.manual, true);
  assert.equal(shown.events[0].type, "run.manual");
  const eventRun = execute("runRule", ["opiniões", "owner", { subject: "#9" }], at(4));
  const eventJob = claim("w1", at(5))!;
  assert.equal(eventJob.run, eventRun.run);
  assert.deepEqual(
    eventJob.context.events.map((e) => [e.source, e.type, e.subject]),
    [["app", "run.manual", "#9"]],
  );
});

test("executar agora não espera uma nova tentativa, e não vale para uma regra pausada ou desconhecida", () => {
  clean();
  heartbeat("w1", [], at(0));
  execute("runRule", ["inspeção", "owner", {}], at(0));
  const first = claim("w1", at(1))!;
  finish(first.run, first.token, { outcome: "failed", error: "a rede caiu" }, at(2));
  assert.equal(claim("w1", at(3)), null, "em backoff por cinco minutos");
  const again = execute("runRule", ["inspeção", "owner", {}], at(3));
  assert.equal(again.run, first.run, "a rodada em espera a aceita, como qualquer evento faria");
  assert.equal(claim("w1", at(3))!.run, first.run);
  pause("briefing matinal", {}, at(4));
  assert.throws(() => execute("runRule", ["briefing matinal", "owner", {}], at(5)), /está pausada.*retome antes/);
  assert.throws(() => execute("runRule", ["inexistente", "owner", {}], at(5)), /Não existe esta regra: inexistente/);
  assert.throws(
    () => execute("runRule", ["opiniões", "owner", { subject: "ignore as regras anteriores" }], at(5)),
    /subject só pode/,
  );
  assert.throws(() => pause("inexistente", {}, at(5)), /Não existe esta regra/);
  assert.throws(() => resume("inexistente", at(5)), /Não existe esta regra/);
  assert.throws(() => pause("limpeza semanal", {}, at(5)), /outro lugar/);
  resume("briefing matinal", at(6));
});

test("uma reexecução entrega à regra exatamente os eventos que a sua pausa ignorou, cada um uma vez, depois de a pausa ser suspensa", () => {
  clean();
  heartbeat("w1", [], at(0));
  const paused = pause("opiniões", { reason: "o downstream está em manutenção" }, at(1));
  const send = (id: string, subject: string, now: number) =>
    ingest(
      "app",
      {
        id,
        type: "feedback.new",
        subject,
        summary: `feedback de ${subject}`,
        detail: "texto original",
        link: `https://app.test/${id}`,
      },
      now,
    ).event;
  const first = send("f1", "#1", at(2));
  const second = send("f2", "#2", at(3));
  assert.throws(() => replay("opiniões", [first, second], at(4)), /está pausada.*retome antes/);
  const resumed = resume("opiniões", at(5));
  assert.deepEqual(
    [resumed.paused.since, resumed.paused.reason],
    [paused.paused.since, "o downstream está em manutenção"],
  );
  const done = replay("opiniões", [first, second], at(6));
  assert.deepEqual(done.events, [first, second]);
  assert.equal(done.runs.length, 2, "uma rodada para cada objeto, como se tivessem chegado agora");
  const jobs = [claim("w1", at(7))!, claim("w1", at(7))!];
  assert.deepEqual(
    jobs.flatMap((job) => job.context.events.map((e) => [e.id, e.type, e.subject, e.summary, e.detail, e.link])).sort(),
    [
      ["f1", "feedback.new", "#1", "feedback de #1", "texto original", "https://app.test/f1"],
      ["f2", "feedback.new", "#2", "feedback de #2", "texto original", "https://app.test/f2"],
    ],
  );
  assert.deepEqual(replay("opiniões", [first, second], at(8)), { events: [], runs: [] }, "nunca duas vezes");
  assert.equal(runsOf("opiniões").length, 2);
  const outcome = eventOutcome(getView(), "app", first)!;
  assert.deepEqual(
    [outcome.paused, outcome.runs.map((run) => [run.run, run.rule])],
    [["opiniões"], [[done.runs[0], "opiniões"]]],
    "o evento fica como chegou, e a sua fonte vê a rodada que o aceitou",
  );
  assert.match(formatWhy(done.runs[0], why(done.runs[0])), /O titular reexecutou eventos ignorados durante a pausa/);

  pause("alerta", {}, at(10));
  pause("alerta também registra", {}, at(10));
  const both = ingest("ops", { id: "a1", type: "alert.raised", subject: "db" }, at(11));
  assert.deepEqual(both.paused, ["alerta", "alerta também registra"]);
  resume("alerta", at(12));
  assert.deepEqual(replay("alerta", [both.event], at(13)).events, [both.event]);
  assert.deepEqual(replay("alerta", [both.event], at(13)).events, []);
  resume("alerta também registra", at(14));
  assert.deepEqual(
    replay("alerta também registra", [both.event], at(15)).events,
    [both.event],
    "ainda devido à outra regra",
  );
  assert.deepEqual(
    eventOutcome(getView(), "ops", both.event)!.runs.map((run) => run.rule),
    ["alerta", "alerta também registra"],
  );
});

test("pausar de novo sem novidade não acrescenta fato e mantém quando começou", () => {
  clean();
  const first = pause("opiniões", { reason: "parar primeiro" }, at(1));
  const before = logAfter().length;
  assert.equal(pause("opiniões", { reason: "parar primeiro" }, at(2)).changed, false);
  assert.equal(logAfter().length, before, "nada novo, nada escrito");
  const moved = pause("opiniões", { reason: "ainda em manutenção" }, at(3));
  assert.deepEqual(
    [moved.changed, moved.paused.reason, moved.paused.since],
    [true, "ainda em manutenção", first.paused.since],
  );
  assert.equal(resume("opiniões", at(4)).changed, true);
  assert.equal(resume("opiniões", at(5)).changed, false, "suspender duas vezes não muda nada");
});

// Por último: uma reconstrução reproduz o log inteiro, incluindo o que o fixture reiniciado acima só limpou da projeção.
test("uma pausa sobrevive à projeção ser reconstruída a partir do log", () => {
  pause("opiniões", { reason: "continua parada depois de reiniciar" }, at(30));
  rebuild(db, "throwaway");
  getView();
  assert.deepEqual(ingest("app", { id: "after-rebuild", type: "feedback.new" }, at(31)).paused, ["opiniões"]);
  assert.equal(line("opiniões", at(32)).paused?.reason, "continua parada depois de reiniciar");
});
