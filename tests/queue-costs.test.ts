// O que uma fila longa custa a cada entrada. Tudo roda numa thread só e um worker com trabalho em mãos consulta a cada segundo,
// então uma leitura que cresce com a fila trava todas as outras requisições.
// Casos de falha: as regras são lidas e analisadas de novo para cada rodada na fila, e de novo para cada worker; guardá-las
// esconde regras novas da próxima visão ou do próximo leitor de outro escritor, vaza a mudança de um rascunho para a visão de
// onde ele veio, impede uma decisão de ver as regras que acabou de mudar, ou entrega a uma rodada em mãos as regras atuais no
// lugar das suas. Uma entrada que não mudou nada ainda assim lê a fila para calcular vencimentos que não podem ter se movido,
// ou escreve um fato por eles; deixá-los de lado encalha o que só o relógio muda, porque um tick não traz mais a tabela para o
// presente, ou uma mudança não traz mais, ou um relógio atrasado nunca recupera seus vencimentos.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { credential } from "../kernel/credentials.ts";
import { deadlines } from "../kernel/due.ts";
import { empty, evolve, rows, snapshot, type Fact, type View } from "../kernel/evolve.ts";
import { configuration, workerOf } from "../kernel/query.ts";
import { commit, openView } from "../kernel/store.ts";
import { parseRules } from "../protocol/rules.ts";

const environment = { secret: "test-queue-costs", publicUrl: "https://hub.test" };
const fixture = parseRules(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"), 0, "UTC");
const rules = { ...fixture, rules: fixture.rules.filter((rule) => "source" in rule.when) };

/** O kernel como o host o executa, num horário fixo. */
class Hub {
  view: View = empty();
  now = 1000;
  constructor(given = rules) {
    this.act("rules", given);
  }
  act(type: string, ...args: unknown[]) {
    const decided = decide(this.view, { type, args }, this.now, environment);
    this.view = evolve(this.view, decided.facts);
    return decided.value;
  }
  /** Rodadas na fila para o w1, cada uma com seu próprio objeto. */
  queue(count: number, from = 0) {
    for (let n = from; n < from + count; n++)
      this.act("ingest", "app", { id: `${n}`, type: "feedback.new", subject: `#${n}` });
  }
}

/** Quantas vezes as regras são analisadas enquanto isto roda, numa visão da qual nada leu ainda. */
function rulesParsed(hub: Hub, type: string, ...args: unknown[]) {
  const fresh = evolve(hub.view, []);
  const parse = JSON.parse;
  let parsed = 0;
  JSON.parse = (text: string, ...rest: []) => {
    if (typeof text === "string" && text.includes('"askFirst"')) parsed++;
    return parse(text, ...rest);
  };
  try {
    decide(fresh, { type, args }, hub.now, environment);
  } finally {
    JSON.parse = parse;
  }
  return parsed;
}

for (const [type, args] of [
  ["heartbeat", ["w1", []]],
  ["claimNext", ["w1", "new"]],
  ["ingest", ["app", { id: "more", type: "feedback.new", subject: "#more" }]],
  ["tick", []],
] as const) {
  test(`${type} analisa as regras uma vez só, não importa o tamanho da fila`, () => {
    const hub = new Hub();
    hub.queue(1);
    assert.equal(rulesParsed(hub, type, ...args), 1);
    hub.queue(49, 1);
    assert.equal(rulesParsed(hub, type, ...args), 1);
  });
}

test("as regras mais antigas de uma rodada em mãos são analisadas mais uma vez, não importa quantas rodadas as tenham", () => {
  const hub = new Hub();
  hub.queue(3);
  for (const n of [0, 1, 2]) hub.act("claimNext", "w1", `claim-${n}`);
  hub.act("rules", { ...rules, askFirst: ["outra coisa"] });
  assert.equal(rulesParsed(hub, "tick"), 2);
});

test("regras novas chegam à próxima visão, e uma decisão em andamento deixa intacta a visão de onde veio", () => {
  const hub = new Hub();
  const before = hub.view;
  const was = configuration(before).askFirst;
  const decided = decide(before, { type: "rules", args: [{ ...rules, askFirst: ["outra coisa"] }] }, 2000, environment);
  assert.deepEqual(configuration(before).askFirst, was);
  assert.deepEqual(configuration(evolve(before, decided.facts)).askFirst, ["outra coisa"]);
});

test("uma visão aberta depois de outro escritor mudar as regras vê as novas", () => {
  const db = new DatabaseSync(":memory:");
  const facts = (view: View, given: typeof rules) =>
    decide(view, { type: "rules", args: [given] }, 1000, environment).facts;
  const view = openView(db, "format");
  const first = commit(db, view, () => facts(view, rules));
  assert.deepEqual(configuration(first).askFirst, rules.askFirst);
  // Um comando escreve neste banco a partir do seu próprio processo, numa visão só dele.
  const other = openView(db, "format");
  commit(db, other, () => facts(other, { ...rules, askFirst: ["outra coisa"] }));
  assert.deepEqual(configuration(openView(db, "format")).askFirst, ["outra coisa"]);
  db.close();
});

test("uma decisão que muda as regras vê a própria mudança no que faz em seguida", () => {
  const moved = {
    ...rules,
    rules: rules.rules.map((rule) => (rule.name === "opiniões" ? { ...rule, to: "a2" } : rule)),
  };
  const hub = new Hub();
  hub.queue(1);
  const decided = decide(hub.view, { type: "rules", args: [moved] }, 2000, environment);
  const run = decided.facts[0].changes.find((change) => change.table === "runs")!.row!;
  assert.equal(run.agent, "a2");
  assert.equal(run.rules_version, decided.facts[0].seq);
});

test("uma rodada em mãos mantém as regras sob as quais recebeu o claim, lidas da mesma visão que as atuais", () => {
  const moved = { ...rules, agents: { ...rules.agents, a1: { ...rules.agents.a1, worker: "w2" } } };
  const hub = new Hub();
  hub.queue(1);
  const { run } = hub.act("claimNext", "w1", "claim");
  hub.act("rules", moved);
  const view = evolve(hub.view, []);
  assert.equal(configuration(view).agents.a1.worker, "w2");
  assert.equal(workerOf(view, view.get("runs", run)!), "w1");
  assert.equal(configuration(view).agents.a1.worker, "w2");
});

/** Quantas vezes as rodadas são lidas do banco enquanto uma entrada é decidida, e o que ela decidiu. */
function runReads(hub: Hub, type: string, ...args: unknown[]) {
  const all = StatementSync.prototype.all;
  let reads = 0;
  StatementSync.prototype.all = function (...given: any[]) {
    if (this.sourceSQL.includes("collection='runs'")) reads++;
    return all.apply(this, given as any);
  };
  try {
    const decided = decide(hub.view, { type, args }, hub.now, environment);
    return { ...decided, reads };
  } finally {
    StatementSync.prototype.all = all;
  }
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** Uma rodada em mãos e mais atrás dela, e todos vistos há pouco. */
function busyHub() {
  const hub = new Hub();
  hub.queue(5);
  const job = hub.act("claimNext", "w1", "held");
  hub.act("heartbeat", "w1", [job.run]);
  hub.act("heartbeat", "w2", []);
  hub.act("channelSeen", "chat");
  hub.now += SECOND;
  return { hub, job };
}

test("uma entrada que não muda nada não lê rodadas nem escreve fato", () => {
  const { hub, job } = busyHub();
  const nothing: [string, ...unknown[]][] = [
    ["heartbeat", "w1", [job.run]],
    ["heartbeat", "w2", []],
    ["channelSeen", "chat"],
    ["ingest", "app", { id: "0", type: "feedback.new", subject: "#0" }],
    ["nextCard", "chat"],
  ];
  for (const [type, ...args] of nothing) {
    const decided = runReads(hub, type, ...args);
    assert.deepEqual(decided.facts, [], type);
    assert.equal(decided.reads, 0, type);
  }
});

test("um recibo entregue de novo não lê rodadas", () => {
  const { hub, job } = busyHub();
  hub.act("finish", job.run, job.token, { outcome: "done" });
  const again = runReads(hub, "finish", job.run, job.token, { outcome: "done" });
  assert.equal(again.value.duplicate, true);
  assert.deepEqual(again.facts, []);
  assert.equal(again.reads, 0);
});

test("um claim que não encontra nada lê as rodadas só para procurar uma", () => {
  const hub = new Hub();
  hub.queue(5);
  for (const n of [0, 1, 2]) hub.act("claimNext", "w1", `claim-${n}`);
  hub.act("heartbeat", "w1", []);
  hub.now += SECOND;
  const blocked = runReads(hub, "claimNext", "w1", "nothing");
  assert.equal(blocked.value, null);
  assert.deepEqual(blocked.facts, []);
  assert.equal(blocked.reads, 1);
});

/** Uma rodada que falhou esperando sua nova tentativa, com o vencimento na tabela. */
function waitingForRetry() {
  const hub = new Hub();
  hub.queue(1);
  const job = hub.act("claimNext", "w1", "first");
  hub.act("finish", job.run, job.token, { outcome: "failed", error: "FALHOU" });
  const retry = rows(hub.view, "due").find((due) => due.kind === "retry")!;
  assert.equal(retry.at, hub.now + 5 * MINUTE);
  return { hub, job, retry };
}

test("o que só o relógio muda espera pelo tick que o vencimento traz, e esse tick resolve", () => {
  const { hub, retry } = waitingForRetry();
  hub.now = retry.at - 30 * SECOND;
  hub.act("heartbeat", "w1", []);
  hub.now = retry.at + 1;
  // Passou do horário e nada mudou: a tabela fica de pé até o temporizador marcado para aquele vencimento disparar.
  assert.deepEqual(decide(hub.view, { type: "heartbeat", args: ["w1", []] }, hub.now, environment).facts, []);
  assert.equal(
    rows(hub.view, "due").some((due) => due.kind === "retry"),
    true,
  );
  const [fact] = decide(hub.view, { type: "tick", args: [] }, hub.now, environment).facts;
  assert.ok(fact.changes.every((change) => change.table === "due"));
  hub.act("tick");
  const kinds = rows(hub.view, "due").map((due) => due.kind);
  assert.equal(kinds.includes("retry"), false);
  assert.equal(kinds.includes("offline"), true, "uma rodada pronta para ir agora espera pelo seu worker");
});

test("uma rodada além do horário de nova tentativa pode receber claim antes de qualquer tick", () => {
  const { hub, retry } = waitingForRetry();
  hub.now = retry.at + 1;
  const job = hub.act("claimNext", "w1", "second");
  assert.equal(job.attempt, 2);
  assert.equal(
    rows(hub.view, "due").some((due) => due.kind === "retry"),
    false,
  );
});

test("qualquer coisa que mude algo traz a tabela inteira para o presente", () => {
  const { hub, retry } = waitingForRetry();
  hub.now = retry.at + 1;
  hub.act("ingest", "ops", { id: "other", type: "alert.raised" });
  assert.equal(
    rows(hub.view, "due").some((due) => due.kind === "retry"),
    false,
  );
});

test("um tick sem nada a fazer deixa a tabela como está e não escreve nada", () => {
  const { hub, retry } = waitingForRetry();
  hub.now = retry.at - MINUTE;
  assert.deepEqual(decide(hub.view, { type: "tick", args: [] }, hub.now, environment).facts, []);
});

test("um relógio atrasado recupera seus vencimentos no próximo tick", () => {
  const { hub, retry } = waitingForRetry();
  hub.now = retry.at + 1;
  hub.act("tick");
  assert.equal(
    rows(hub.view, "due").some((due) => due.kind === "retry"),
    false,
  );
  hub.now = retry.at - MINUTE;
  hub.act("tick");
  assert.equal(rows(hub.view, "due").find((due) => due.kind === "retry")?.at, retry.at);
});

test("a tabela é o que calculá-la diz, até o último fato, não importa o que veio depois", () => {
  const hub = new Hub();
  const log: Fact[] = [];
  const act = (type: string, ...args: unknown[]) => {
    const decided = decide(hub.view, { type, args }, hub.now, environment);
    log.push(...decided.facts);
    hub.view = evolve(hub.view, decided.facts);
    if (log.length) assert.deepEqual(snapshot(hub.view).tables.due, deadlines(hub.view, log.at(-1)!.at), type);
    return decided.value;
  };
  act("ingest", "app", { id: "a", type: "feedback.new", subject: "#a" });
  act("ingest", "app", { id: "b", type: "feedback.new", subject: "#b" });
  const job = act("claimNext", "w1", "one");
  for (let n = 0; n < 20; n++) {
    hub.now += 30 * SECOND;
    act("heartbeat", "w1", [job.run]);
    act("channelSeen", "chat");
    act("claimNext", "w1", `poll-${n}`);
  }
  act("finish", job.run, credential(environment, "run", job.run, hub.view.get("runs", job.run)!.issued), {
    outcome: "failed",
  });
  for (let n = 0; n < 30; n++) {
    hub.now += MINUTE;
    act("heartbeat", "w2", []);
    if (rows(hub.view, "due").some((due) => due.at <= hub.now)) act("tick");
  }
});
