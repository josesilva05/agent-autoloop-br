// Uma regra com resume pega o próximo evento de um assunto na sessão em que a última rodada dele terminou. Casos de falha:
// a rodada seguinte abre uma sessão nova mesmo assim, ou abre de novo quando a primeira resposta se perdeu; uma rodada
// enfileirada enquanto outra roda perde a sessão em que aquela terminou; uma rodada segue na sessão de outro objeto; uma
// regra sem a opção muda de comportamento; uma sessão passa para o Agent para o qual a regra foi movida; uma resposta ou uma
// nova tentativa perde a sessão que carrega para uma mais nova; uma rodada que está ou talvez ainda esteja em execução tem a
// sessão aberta por um segundo processo, por um evento novo, uma resposta ou uma reverificação vencida; uma rodada assim
// interrompe para sempre a retomada do assunto; uma sessão que não para de falhar é retomada a cada evento novo, dez
// tentativas cada, embora o cartão dissesse que começaria do zero; uma reverificação vencida entrega a sessão do Agent
// anterior a um Agent novo.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { empty, evolve, rows, type Fact } from "../kernel/evolve.ts";
import { parseRules } from "../protocol/rules.ts";
import { invariants } from "../sim/invariants.ts";

const env = { secret: "resume", publicUrl: "https://hub.test" };
const given = JSON.parse(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"));
const rules = parseRules(
  JSON.stringify({
    ...given,
    rules: given.rules
      .filter((rule: { when: { source?: string } }) => rule.when.source)
      .map((rule: { name: string }) => (rule.name === "opiniões" ? { ...rule, resume: true } : rule)),
  }),
  0,
  "UTC",
);
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
  let events = 0;
  const message = (subject = "#1") => act("ingest", "app", { id: `e${++events}`, type: "feedback.new", subject });
  let claims = 0;
  const claim = () => act("claimNext", "w1", `c${++claims}`);
  /** Uma rodada do seu evento até o fim, até onde o que a rodada seguinte vê. */
  const round = (session: string | null, subject = "#1", outcome = "done") => {
    message(subject);
    const job = claim();
    act("finish", job.run, job.token, { outcome, ...(session && { session }) });
    return job;
  };
  /** O worker continua vindo mas para de mencionar o que tem em mãos, até a central não saber dizer se ainda está rodando. */
  const loseTrack = () => {
    for (let minute = 0; minute < 7; minute++) {
      now += MINUTE;
      act("heartbeat", "w1", []);
      act("tick");
    }
  };
  return {
    act,
    message,
    claim,
    round,
    loseTrack,
    pass: (minutes: number) => void (now += minutes * MINUTE),
    run: (id: number) => view.get("runs", id)!,
    cards: () => rows(view, "cards"),
    check: () => invariants(view, log),
  };
}

test("o próximo evento de um assunto segue na sessão em que a última rodada dele terminou, mesmo se a resposta do claim se perdeu", () => {
  const it = hub();
  assert.equal(it.round("S").session, null);
  it.message();
  const claim = "lost";
  assert.equal(it.act("claimNext", "w1", claim).session, "S");
  assert.equal(it.act("claimNext", "w1", claim).session, "S");
  it.check();
});

test("uma rodada que não encontrou nada a fazer também tem uma sessão em que continuar", () => {
  const it = hub();
  it.round("S", "#1", "nothing");
  assert.equal(it.round("T").session, "S");
  assert.equal(it.round(null).session, "T");
});

test("o que chega enquanto uma rodada roda espera e segue na sessão em que aquela rodada termina", () => {
  const it = hub();
  it.message();
  const first = it.claim();
  it.message();
  it.message();
  assert.equal(it.claim(), null);
  it.act("finish", first.run, first.token, { outcome: "done", session: "S" });
  const next = it.claim();
  assert.equal(next.session, "S");
  assert.equal(next.context.events.length, 2);
  it.check();
});

test("outro objeto na mesma regra tem uma sessão só dele", () => {
  const it = hub();
  it.round("S", "#1");
  it.round("T", "#2");
  assert.equal(it.round("U", "#3").session, null);
  assert.equal(it.round("T2", "#2").session, "T");
  assert.equal(it.round("S2", "#1").session, "S");
});

test("uma regra sem a opção abre uma sessão nova a cada vez", () => {
  const it = hub();
  const alert = (id: string) => it.act("ingest", "ops", { id, type: "alert.raised", subject: "x" });
  for (const id of ["1", "2"]) {
    alert(id);
    for (const worker of ["w2", "w1"]) {
      const job = it.act("claimNext", worker, `${worker}-${id}`);
      assert.equal(job.session, null);
      it.act("finish", job.run, job.token, { outcome: "done", session: `S-${worker}` });
    }
  }
});

test("uma sessão não passa para o Agent para o qual a regra foi movida, nem volta ao primeiro depois disso", () => {
  const it = hub();
  it.round("S");
  const moved = structuredClone(rules);
  moved.rules.find((rule) => rule.name === "opiniões")!.to = "a3";
  it.act("rules", moved);
  assert.equal(it.round(null).session, null);
  it.act("rules", rules);
  assert.equal(it.round("T").session, null);
});

test("uma reverificação vencida mantém o contexto, mas não a sessão de outro Agent depois da reatribuição", () => {
  const it = hub();
  it.message();
  const first = it.claim();
  it.act("finish", first.run, first.token, {
    outcome: "done",
    session: "claude-session",
    later: [{ key: "reverificação", at: "2026-11-05T01:00:00Z", about: "verificar se foi para produção" }],
  });
  const moved = structuredClone(rules);
  moved.rules.find((rule) => rule.name === "opiniões")!.to = "a2";
  it.act("rules", moved);
  it.pass(61);
  it.act("tick");
  const next = it.act("claimNext", "w2", "new-agent");
  assert.equal(next.agent.id, "a2");
  assert.equal(next.session, null);
  assert.equal(next.context.timers[0].about, "verificar se foi para produção");
  it.check();
});

test("uma resposta volta à sessão em que foi perguntada, não a uma mais nova do assunto", () => {
  const it = hub();
  it.message();
  const asking = it.claim();
  const ask = [{ title: "qual escolher", text: "x", options: ["alfa", "beta"] }];
  it.act("finish", asking.run, asking.token, { outcome: "done", session: "S", ask });
  it.round("T");
  it.act("answer", it.cards().find((card) => card.kind === "ask")!.id, { choice: 0 });
  const answered = it.claim();
  assert.equal(answered.session, "S");
  assert.equal(answered.context.answers.length, 1);
  it.check();
});

test("uma rodada que dá errado tenta de novo na sessão em que seguia, tenha ou não reportado uma", () => {
  const it = hub();
  it.round("S");
  it.message();
  const first = it.claim();
  assert.equal(first.session, "S");
  it.act("finish", first.run, first.token, { outcome: "failed", error: "não terminou" });
  it.pass(6);
  const second = it.claim();
  assert.equal(second.run, first.run);
  assert.equal(second.session, "S");
});

test("uma sessão em que uma rodada talvez ainda esteja rodando não é aberta de novo; o assunto segue na próxima rodada que terminar", () => {
  const it = hub();
  it.round("S");
  it.message();
  const lost = it.claim();
  it.act("started", lost.run, lost.token, { session: "S" });
  it.loseTrack();
  assert.equal(it.run(lost.run).state, "unknown");
  it.message();
  const next = it.claim();
  assert.equal(next.session, null);
  it.act("finish", next.run, next.token, { outcome: "done", session: "T" });
  assert.equal(it.round("T2").session, "T");
  it.check();
});

test("uma rodada perdida de vista que passou para uma sessão própria deixa a antiga livre", () => {
  const it = hub();
  it.round("S");
  it.message();
  const lost = it.claim();
  it.act("started", lost.run, lost.token, { session: "T" });
  it.loseTrack();
  assert.equal(it.round("U").session, "S");
});

test("um resultado atrasado de uma rodada perdida de vista conta como o jeito em que ela terminou", () => {
  const it = hub();
  it.round("S");
  it.message();
  const lost = it.claim();
  it.loseTrack();
  it.act("finish", lost.run, lost.token, { outcome: "done", session: "S2" });
  assert.equal(it.round("T").session, "S2");
});

test("uma rodada mais nova terminando na sessão não esconde uma que talvez ainda esteja rodando nela", () => {
  const it = hub();
  it.round("S");
  it.message();
  const lost = it.claim();
  it.act("started", lost.run, lost.token, { session: "S" });
  it.loseTrack();
  const reportsTheSame = it.round("S");
  assert.equal(reportsTheSame.session, null);
  assert.equal(it.round("T").session, null);
});

test("uma resposta não abre uma sessão em que uma rodada talvez ainda esteja rodando, e ainda chega aonde ia", () => {
  const it = hub();
  it.message();
  const asking = it.claim();
  const ask = [{ title: "qual escolher", text: "x", options: ["alfa", "beta"] }];
  it.act("finish", asking.run, asking.token, { outcome: "done", session: "S", ask });
  it.message();
  const lost = it.claim();
  it.act("started", lost.run, lost.token, { session: "S" });
  it.loseTrack();
  it.act("answer", it.cards().find((card) => card.kind === "ask")!.id, { choice: 0 });
  const answered = it.claim();
  assert.equal(answered.session, null);
  assert.equal(answered.context.answers.length, 1);
  it.check();
});

test("uma reverificação vencida não abre uma sessão em que uma rodada talvez ainda esteja rodando, e ainda vence", () => {
  const it = hub();
  it.message();
  const asking = it.claim();
  const later = [{ key: "reverificação", at: "2026-11-05T03:00:00.000Z", about: "ver se já terminou" }];
  it.act("finish", asking.run, asking.token, { outcome: "done", session: "S", later });
  it.message();
  const lost = it.claim();
  it.act("started", lost.run, lost.token, { session: "S" });
  it.loseTrack();
  it.pass(180);
  it.act("tick");
  const due = it.claim();
  assert.equal(due.session, null);
  assert.equal(due.context.events[0].type, "timer.due");
  it.check();
});

test("sem a opção, uma resposta também não abre uma sessão em que uma rodada talvez ainda esteja rodando", () => {
  const it = hub();
  const without = structuredClone(rules);
  delete without.rules.find((rule) => rule.name === "opiniões")!.resume;
  it.act("rules", without);
  it.message();
  const asking = it.claim();
  const ask = ["um", "dois"].map((title) => ({ title, text: "x", options: ["alfa", "beta"] }));
  it.act("finish", asking.run, asking.token, { outcome: "done", session: "S", ask });
  const [first, second] = it.cards().filter((card) => card.kind === "ask");
  it.act("answer", first.id, { choice: 0 });
  const lost = it.claim();
  assert.equal(lost.session, "S");
  it.act("started", lost.run, lost.token, { session: "S" });
  it.loseTrack();
  it.act("answer", second.id, { choice: 0 });
  assert.equal(it.claim().session, null);
});

test("uma rodada ainda em curso mantém a sessão para si quando o grupo da regra muda sob ela", () => {
  const it = hub();
  it.round("S");
  it.message();
  const going = it.claim();
  assert.equal(going.session, "S");
  const regrouped = structuredClone(rules);
  regrouped.rules.find((rule) => rule.name === "opiniões")!.group = "grupo novo";
  it.act("rules", regrouped);
  it.message();
  assert.equal(it.claim().session, null);
});

test("uma rodada interrompida por falhar vezes demais recomeça o assunto do zero, como o cartão diz", () => {
  const it = hub();
  it.round("S");
  it.message();
  for (let attempt = 0; attempt < 10; attempt++) {
    it.pass(61);
    const job = it.claim();
    assert.equal(job.session, "S");
    it.act("finish", job.run, job.token, { outcome: "failed", error: "longo demais", session: "S" });
  }
  assert.ok(it.cards().some((card) => card.text.includes("começará do zero")));
  assert.equal(it.round("T").session, null);
  assert.equal(it.round("U").session, "T");
  it.check();
});

test("uma rodada que o titular interrompeu também recomeça o assunto do zero", () => {
  const it = hub();
  it.round("S");
  it.message();
  const stopped = it.claim();
  it.act("cancel", stopped.run);
  it.act("finish", stopped.run, stopped.token, { outcome: "cancelled" });
  assert.equal(it.run(stopped.run).state, "cancelled");
  assert.equal(it.round("T").session, null);
  assert.equal(it.round("U").session, "T");
  it.check();
});
