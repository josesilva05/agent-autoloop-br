// O que o titular interrompeu fica interrompido, e o que volta para um assunto volta para aquele assunto. Casos de falha:
// uma rodada com ordem de parada entrega uma falha e volta para a fila, então recomeça minutos depois; o cartão dizendo que
// vai tentar de novo continua aberto depois da parada e precisa ser limpo à mão; depois que uma regra para de rodar em
// paralelo, uma resposta ou uma reverificação vencida inicia uma rodada em outro assunto, cujo contexto não tem nem a
// resposta nem a reverificação, então a pergunta nunca é realmente respondida.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { empty, evolve, rows, type Fact } from "../kernel/evolve.ts";
import { parseRules } from "../protocol/rules.ts";
import { invariants } from "../sim/invariants.ts";

const env = { secret: "stops", publicUrl: "https://hub.test" };
const rules = parseRules(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"), 0, "UTC");
const MINUTE = 60_000;

function hub() {
  let view = empty();
  let now = Date.UTC(2026, 10, 5, 0, 0, 0);
  const log: Fact[] = [];
  const act = (type: string, ...args: any[]) => {
    const decided = decide(view, { type, args }, now++, env);
    log.push(...decided.facts);
    view = evolve(view, decided.facts);
    return decided.value;
  };
  act("rules", rules);
  return {
    act,
    run: (id: number) => view.get("runs", id)!,
    cards: () => rows(view, "cards"),
    pass: (minutes: number) => void (now += minutes * MINUTE),
    check: () => invariants(view, log),
  };
}

const feedback = { id: "e1", type: "feedback.new", subject: "#1" };
const notParallel = () => {
  const next = structuredClone(rules);
  for (const rule of next.rules) delete rule.parallel;
  return next;
};

/** Faz uma rodada falhar três vezes, para que ela diga ao titular que vai tentar de novo, e a deixa na fila para a quarta. */
function failedThreeTimes(it: ReturnType<typeof hub>) {
  it.act("ingest", "app", feedback);
  let id = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    it.pass(61);
    const job = it.act("claimNext", "w1", `claim-${attempt}`);
    id = job.run;
    it.act("finish", job.run, job.token, { outcome: "failed", error: "boom" });
  }
  return id;
}
const failing = (it: ReturnType<typeof hub>, id: number) => it.cards().find((card) => card.key === `run:${id}:failing`);

test("uma rodada com ordem de parada que entrega uma falha fica interrompida e não recomeça", () => {
  const it = hub();
  it.act("ingest", "app", feedback);
  const job = it.act("claimNext", "w1", "c1");
  it.act("cancel", job.run);
  it.act("finish", job.run, job.token, { outcome: "failed", error: "boom" });
  assert.equal(it.run(job.run).state, "cancelled");
  assert.equal(it.run(job.run).finished_at !== null, true);
  it.pass(120);
  assert.equal(it.act("claimNext", "w1", "c2"), null);
  it.check();
});

test("uma falha entregue sem nenhuma parada pedida ainda tenta de novo", () => {
  const it = hub();
  it.act("ingest", "app", feedback);
  const job = it.act("claimNext", "w1", "c1");
  it.act("finish", job.run, job.token, { outcome: "failed", error: "boom" });
  assert.equal(it.run(job.run).state, "queued");
  it.check();
});

test("interromper uma rodada que esperava para tentar de novo fecha o cartão que dizia isso", () => {
  const it = hub();
  const id = failedThreeTimes(it);
  assert.equal(failing(it, id)?.state, "open");
  it.act("cancel", id);
  assert.equal(it.run(id).state, "cancelled");
  assert.equal(failing(it, id)?.state, "closed");
  it.check();
});

test("uma rodada com esse cartão, interrompida enquanto está em curso, fecha o cartão quando parar", () => {
  const it = hub();
  const id = failedThreeTimes(it);
  it.pass(61);
  const job = it.act("claimNext", "w1", "last");
  assert.equal(job.run, id);
  it.act("cancel", id);
  assert.equal(failing(it, id)?.state, "open", "ainda não interrompida");
  it.act("finish", job.run, job.token, { outcome: "cancelled", summary: "Interrompida" });
  assert.equal(failing(it, id)?.state, "closed");
  it.check();
});

test("uma rodada com ordem de parada cujo worker parou de mencioná-la fecha o cartão que diz que ela talvez siga em curso", () => {
  const it = hub();
  it.act("ingest", "app", feedback);
  const job = it.act("claimNext", "w1", "c1");
  it.act("cancel", job.run);
  it.pass(6);
  it.act("heartbeat", "w1", []);
  it.act("tick");
  assert.equal(it.run(job.run).state, "unknown");
  const unknown = () => it.cards().find((card) => card.key === `run:${job.run}:unknown`);
  assert.equal(unknown()?.state, "open");
  it.act("finish", job.run, job.token, { outcome: "failed", error: "boom" });
  assert.equal(it.run(job.run).state, "cancelled");
  assert.equal(unknown()?.state, "closed");
  it.check();
});

test("uma resposta volta ao assunto que perguntou, depois que a regra parou de rodar em paralelo", () => {
  const it = hub();
  it.act("ingest", "app", feedback);
  const job = it.act("claimNext", "w1", "c1");
  const question = { title: "qual escolher", text: "escolha uma", options: ["alfa", "beta"], about: "continuar" };
  it.act("finish", job.run, job.token, { outcome: "done", summary: "perguntei", session: "S", ask: [question] });
  const [card] = it.cards().filter((card) => card.kind === "ask");
  assert.equal(card.lane, "#1", "a regra do fixture roda em paralelo");
  it.act("rules", notParallel());
  it.act("answer", card.id, { choice: 1 });
  const next = it.act("claimNext", "w1", "c2");
  assert.equal(it.run(next.run).lane, "#1");
  assert.equal(next.session, "S");
  assert.deepEqual(
    next.context.answers.map((answer: any) => answer.choice),
    [1],
  );
  it.act("finish", next.run, next.token, { outcome: "done", summary: "Concluído" });
  it.check();
});

test("uma reverificação vencida volta ao seu assunto, depois que a regra parou de rodar em paralelo", () => {
  const it = hub();
  it.act("ingest", "app", feedback);
  const job = it.act("claimNext", "w1", "c1");
  const later = { key: "olhar", at: "2026-11-05T01:00:00Z", about: "verificar na hora" };
  it.act("finish", job.run, job.token, { outcome: "done", summary: "combinado", session: "S", later: [later] });
  it.act("rules", notParallel());
  it.pass(61);
  it.act("tick");
  const next = it.act("claimNext", "w1", "c2");
  assert.equal(it.run(next.run).lane, "#1");
  assert.deepEqual(
    next.context.timers.map((timer: any) => timer.key),
    ["olhar"],
  );
  it.act("finish", next.run, next.token, { outcome: "done", summary: "verificado" });
  it.check();
});
