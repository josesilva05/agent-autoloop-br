// Ser visto. Um worker com trabalho em mãos consulta a cada segundo e um canal faz polling o dia inteiro; um fato é um sync
// de disco e fica no log para sempre, então ser visto só entra com a frequência que os julgamentos sobre ele conseguem usar.
// Casos de falha: um minuto de consultas escreve um fato por consulta, ou um por rodada em mãos; um worker ocioso ou um canal,
// voltando a cada 50 segundos, escreve todas as vezes; reter os carimbos faz um worker que está lá parecer sumido, e uma
// rodada que ele continua reportando fica incerta, ele é anunciado como offline, ou um único polling perdido o mostra como não
// online; ou faz um worker que sumiu parecer estar lá, e uma rodada na mão de um worker que ficou calado fica incerta em vez de
// esperar por ele; uma rodada que deixou de ser reportada nunca é julgada, ou é julgada antes do que o atraso de um carimbo
// permite; o cartão de offline continua aberto na volta, ou a rodada em mãos não é renovada pela mesma consulta que traz o
// worker de volta; uma consulta retida também retém um claim ou um cancelamento; a rodada de outro, ou uma rodada fora da
// retenção, faz toda consulta virar escrita ou acaba carimbada; um relógio atrasado deixa um carimbo no futuro que nada
// corrige; a retenção depende de qualquer coisa além do horário informado, ou o log deixa de se reproduzir na visão.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { empty, evolve, rows, snapshot, type Fact, type View } from "../kernel/evolve.ts";
import { parseRules } from "../protocol/rules.ts";
import { at, setup } from "./helpers.ts";

setup("heartbeat");
const runtime = await import("./hub.ts");
const { serve } = await import("../host/http.ts");

const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** O quanto um carimbo pode ficar atrás do último contato e, assim, o quanto antes do limite um julgamento pode vir. */
const LAG = MINUTE;
const LEASE = 5 * MINUTE;
const OFFLINE = 10 * MINUTE;

const environment = { secret: "test-heartbeat", publicUrl: "https://hub.test" };
const fixture = parseRules(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"), 0, "UTC");
// Sem as regras agendadas nada mais vence, então o que o log ganha aqui vem de ser visto.
const rules = { ...fixture, rules: fixture.rules.filter((rule) => "source" in rule.when) };

/** O kernel como o host o executa: cada entrada decidida no horário atual e um temporizador só para o que vence. */
class Hub {
  view: View = empty();
  log: Fact[] = [];
  now = at(0);
  constructor() {
    this.act("rules", rules);
  }
  act(type: string, ...args: unknown[]) {
    const decided = decide(this.view, { type, args }, this.now, environment);
    this.log.push(...decided.facts);
    this.view = evolve(this.view, decided.facts);
    return decided.value;
  }
  runTo(time: number) {
    for (let fired = 0; ; fired++) {
      const next = Math.min(Infinity, ...rows(this.view, "due").map((due) => due.at));
      if (next > time) break;
      assert.ok(fired < 100, "há um vencimento que não para de vencer");
      this.now = Math.max(this.now, next);
      this.act("tick");
    }
    this.now = time;
  }
  repeat(every: number, until: number, action: () => void) {
    for (let time = this.now; time < until; time += every) {
      this.runTo(time);
      action();
    }
    this.runTo(until);
  }
  state(run: number) {
    return this.view.get("runs", run)!.state;
  }
  written(type: string) {
    return this.log.filter((fact) => fact.type === type).length;
  }
}

/** O a1 pertence ao w1 e pega notas três por vez. */
function inHand(hub: Hub, n: number): number {
  hub.act("ingest", "app", { id: `note:${n}`, type: "feedback.new", subject: `#${n}` });
  return hub.act("claimNext", "w1", `claim-${n}`).run;
}
const wentInDoubt = (hub: Hub, run: number) =>
  hub.log.find((fact) =>
    fact.changes.some(({ table, key, row }) => table === "runs" && key === String(run) && row?.state === "unknown"),
  );

test("consultar a cada segundo com três rodadas em mãos escreve um fato por minuto", () => {
  const hub = new Hub();
  const runs: number[] = [];
  hub.repeat(SECOND, at(1), () => {
    // Pegas no meio das consultas, então carimbadas em momentos diferentes, a menos que um heartbeat as una.
    if ((hub.now - at(0)) % (20 * SECOND) === 0) runs.push(inHand(hub, runs.length + 1));
    hub.act("heartbeat", "w1", runs);
  });
  assert.equal(runs.length, 3);
  const before = hub.log.length;
  hub.repeat(SECOND, at(2), () => hub.act("heartbeat", "w1", runs));
  assert.equal(hub.log.length - before, 1, "um minuto de consultas");
  hub.repeat(SECOND, at(62), () => hub.act("heartbeat", "w1", runs));
  assert.equal(hub.log.length - before, 61, "mais uma hora de consultas");
  assert.ok(hub.log.slice(before).every((fact) => fact.type === "heartbeat"));
});

test("voltar a cada 50 segundos sem nada em mãos escreve uma vez a cada duas, worker ou canal", () => {
  const worker = new Hub();
  worker.repeat(50 * SECOND, at(60), () => worker.act("heartbeat", "w1", []));
  assert.equal(worker.written("heartbeat"), 36);
  const channel = new Hub();
  channel.repeat(50 * SECOND, at(60), () => channel.act("channelSeen", "chat"));
  assert.equal(channel.written("channelSeen"), 36);
});

for (const every of [SECOND, 50 * SECOND]) {
  test(`uma rodada reportada a cada ${every / SECOND} segundos continua em mãos, e ninguém é avisado de nada`, () => {
    const hub = new Hub();
    const run = inHand(hub, 1);
    hub.repeat(every, at(30), () => hub.act("heartbeat", "w1", [run]));
    assert.equal(hub.state(run), "claimed");
    assert.deepEqual(rows(hub.view, "cards"), []);
    const job = hub.act("claimNext", "w1", "claim-1");
    hub.act("finish", run, job.token, { outcome: "done" });
    assert.equal(hub.state(run), "done");
  });
}

// Não importa como as consultas de um worker caem frente ao último carimbo: o julgamento vem só da tabela de vencimentos.
for (const [every, stops] of [
  [SECOND, [0, SECOND, 30 * SECOND, 59 * SECOND]],
  [50 * SECOND, [0, 50 * SECOND]],
] as const) {
  test(`worker que volta a cada ${every / SECOND} segundos: rodada não reportada fica incerta, com um aviso só`, () => {
    for (const stop of stops) {
      const hub = new Hub();
      const run = inHand(hub, 1);
      const other = every === SECOND ? [inHand(hub, 2)] : [];
      let last = 0;
      hub.repeat(every, at(10) + stop, () => {
        last = hub.now;
        hub.act("heartbeat", "w1", [run, ...other]);
      });
      hub.repeat(every, last + 2 * LEASE, () => hub.act("heartbeat", "w1", other));
      assert.equal(hub.state(run), "unknown");
      const judged = wentInDoubt(hub, run)!.at;
      assert.ok(judged > last + LEASE - LAG, `julgada ${judged - last} ms depois do último reporte`);
      assert.ok(judged <= last + LEASE + 1, `julgada ${judged - last} ms depois do último reporte`);
      const cards = rows(hub.view, "cards");
      assert.deepEqual(
        cards.map((card) => card.key),
        [`run:${run}:unknown`],
      );

      // Um worker segue reportando uma rodada incerta até poder entregá-la: isso é ser visto, não notícia sobre a rodada.
      hub.runTo(hub.now + LAG);
      const before = hub.log.length;
      const stamp = hub.view.get("runs", run)!.seen_at;
      hub.repeat(SECOND, hub.now + LAG, () => hub.act("heartbeat", "w1", [run, ...other]));
      assert.equal(hub.log.length - before, 1);
      assert.equal(hub.state(run), "unknown");
      assert.equal(hub.view.get("runs", run)!.seen_at, stamp);
    }
  });
}

test("worker que some com uma rodada em mãos a mantém, é avisado uma vez uns dez minutos depois e se resolve na volta", () => {
  for (const stop of [0, SECOND, 30 * SECOND, 59 * SECOND]) {
    const hub = new Hub();
    const run = inHand(hub, 1);
    let last = 0;
    hub.repeat(SECOND, at(5) + stop, () => {
      last = hub.now;
      hub.act("heartbeat", "w1", [run]);
    });
    hub.runTo(last + 60 * MINUTE);
    assert.equal(wentInDoubt(hub, run), undefined, "sumir não é perder: ele pode ainda estar trabalhando");
    const cards = rows(hub.view, "cards");
    assert.equal(cards.length, 1);
    assert.equal(cards[0].title, "o worker não conectou");
    const told = Date.parse(cards[0].created_at);
    assert.ok(told > last + OFFLINE - LAG, `avisado ${told - last} ms depois da última consulta`);
    assert.ok(told <= last + OFFLINE + 1, `avisado ${told - last} ms depois da última consulta`);

    const before = hub.log.length;
    hub.act("heartbeat", "w1", [run]);
    assert.equal(hub.log.length, before + 1, "o cartão, o worker e a rodada mudam todos no mesmo fato");
    assert.equal(hub.view.get("cards", cards[0].id)!.state, "closed");
    assert.equal(hub.view.get("runs", run)!.seen_at, new Date(hub.now).toISOString());
    hub.repeat(SECOND, hub.now + 10 * MINUTE, () => hub.act("heartbeat", "w1", [run]));
    assert.equal(hub.state(run), "claimed");
    assert.equal(rows(hub.view, "cards").length, 1);
  }
});

test("um worker ausente por alguns minutos que volta com a rodada em mãos nunca ficou incerto", () => {
  for (const away of [30 * SECOND, 4 * MINUTE, 9 * MINUTE]) {
    const hub = new Hub();
    const run = inHand(hub, 1);
    const report = () => hub.act("heartbeat", "w1", [run]);
    hub.repeat(SECOND, at(5), report);
    hub.runTo(hub.now + away);
    hub.repeat(SECOND, hub.now + 10 * MINUTE, report);
    assert.equal(hub.state(run), "claimed");
    assert.deepEqual(rows(hub.view, "cards"), []);
  }
});

test("uma rodada reportada de novo é renovada por essa mesma consulta, ainda que o worker tenha sido visto há pouco", () => {
  const hub = new Hub();
  const run = inHand(hub, 1);
  hub.repeat(SECOND, at(0) + LEASE - 30 * SECOND, () => hub.act("heartbeat", "w1", []));
  hub.act("heartbeat", "w1", [run]);
  assert.equal(hub.view.get("runs", run)!.seen_at, new Date(hub.now).toISOString());
  hub.repeat(SECOND, at(0) + LEASE + 30 * SECOND, () => hub.act("heartbeat", "w1", [run]));
  assert.equal(hub.state(run), "claimed");
});

test("um worker que volta sem a rodada que pegou tem essa rodada marcada como incerta imediatamente", () => {
  const hub = new Hub();
  const run = inHand(hub, 1);
  hub.repeat(SECOND, at(5), () => hub.act("heartbeat", "w1", [run]));
  hub.runTo(hub.now + 20 * MINUTE);
  hub.act("heartbeat", "w1", []);
  hub.runTo(hub.now);
  assert.equal(hub.state(run), "unknown");
});

test("uma consulta encerra um cartão de offline mesmo quando nada mais nela vale uma escrita", () => {
  const hub = new Hub();
  hub.act("heartbeat", "w1", []);
  const { card } = hub.act("createCard", {
    key: "worker:w1:offline:earlier",
    kind: "notice",
    title: "Offline",
    text: "",
  });
  hub.runTo(hub.now + SECOND);
  hub.act("heartbeat", "w1", []);
  assert.equal(hub.view.get("cards", card)!.state, "closed");
});

test("a rodada de outro, ou uma que não está mais em mãos, não é carimbada nem é motivo para escrever", () => {
  const hub = new Hub();
  hub.act("ingest", "ops", { id: "a", type: "alert.raised", subject: "a" });
  const theirs = hub.act("claimNext", "w2", "theirs").run;
  const finished = inHand(hub, 1);
  const { token } = hub.act("claimNext", "w1", "claim-1");
  hub.act("finish", finished, token, { outcome: "done" });
  const stamps = () => [theirs, finished].map((run) => hub.view.get("runs", run)!);
  const before = stamps();
  hub.runTo(at(2));
  hub.act("heartbeat", "w1", []);
  const written = hub.log.length;
  hub.runTo(hub.now + SECOND);
  hub.act("heartbeat", "w1", [theirs, finished, 999]);
  assert.equal(hub.log.length, written, "nada dele estava vencido");
  hub.runTo(hub.now + LAG);
  hub.act("heartbeat", "w1", [theirs, finished, 999]);
  assert.equal(hub.log.length, written + 1, "ser visto está vencido");
  assert.deepEqual(stamps(), before);
});

test("um relógio atrasado corrige os carimbos, em vez de deixá-los no futuro", () => {
  const hub = new Hub();
  hub.runTo(at(60));
  const run = inHand(hub, 1);
  hub.act("heartbeat", "w1", [run]);
  hub.act("channelSeen", "chat");
  hub.now = at(0);
  hub.act("heartbeat", "w1", [run]);
  hub.act("channelSeen", "chat");
  const earlier = new Date(at(0)).toISOString();
  assert.equal(hub.view.get("seen", "worker:w1")!.seen_at, earlier);
  assert.equal(hub.view.get("seen", "channel:chat")!.seen_at, earlier);
  assert.equal(hub.view.get("runs", run)!.seen_at, earlier);
});

test("a retenção segue o horário informado, não muda nada do que recebeu, e o log se reproduz na visão", () => {
  const hub = new Hub();
  const run = inHand(hub, 1);
  hub.act("heartbeat", "w1", [run]);
  const input = { type: "heartbeat", args: ["w1", [run]] };
  const given = structuredClone(input);
  const seen = snapshot(hub.view);
  const decideAt = (time: number) => decide(hub.view, input, time, environment);
  const soon = decideAt(hub.now + LAG - 1);
  const due = decideAt(hub.now + LAG);
  assert.deepEqual(soon.facts, []);
  assert.equal(due.facts.length, 1);
  assert.deepEqual(decideAt(hub.now + LAG - 1), soon);
  assert.deepEqual(decideAt(hub.now + LAG), due);
  assert.deepEqual(input, given);
  assert.deepEqual(snapshot(hub.view), seen);

  hub.repeat(SECOND, hub.now + 5 * MINUTE, () => {
    hub.act("heartbeat", "w1", [run]);
    hub.act("channelSeen", "chat");
  });
  assert.deepEqual(snapshot(evolve(empty(), hub.log)), snapshot(hub.view));
});

test("um único polling perdido não mostra um worker ou canal como não online; sumir ainda mostra", () => {
  const worker = (now: number) => runtime.stateOf(now).agents.find((agent) => agent.worker === "w1")!;
  const channel = (now: number) => runtime.stateOf(now).channels.find((known) => known.id === "chat")!;
  const seen = (now: number) => {
    runtime.heartbeat("w1", [], now);
    runtime.execute("channelSeen", ["chat"], now);
  };
  const missed = at(0) + 100 * SECOND;
  seen(at(0));
  seen(at(0) + 50 * SECOND);
  for (let now = at(0); now < missed + 50 * SECOND; now += 5 * SECOND) {
    assert.equal(worker(now).online, true, `worker aos ${(now - at(0)) / SECOND} segundos`);
    assert.equal(channel(now).online, true, `canal aos ${(now - at(0)) / SECOND} segundos`);
  }
  const last = missed + 50 * SECOND;
  seen(last);
  assert.equal(worker(last + 2 * MINUTE).online, true);
  assert.equal(channel(last + 2 * MINUTE).online, true);
  assert.equal(worker(last + 2 * MINUTE + LAG + 1).online, false);
  assert.equal(channel(last + 2 * MINUTE + LAG + 1).online, false);
});

const keys = {
  ops: runtime.addKey("source", "ops"),
  w2: runtime.addKey("worker", "w2"),
  chat: runtime.addKey("channel", "chat"),
  owner: runtime.addKey("owner", "owner"),
};
const server = serve(0, "127.0.0.1", { commit: "abc123" });
let base = "";
before(async () => {
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});
async function call(path: string, key: string, body?: unknown) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.status, 200, path);
  return response.json();
}
// Por tipo: o temporizador da própria central pode acrescentar um fato a qualquer momento, por um worker que não consulta aqui.
const beenSeen = () =>
  runtime.one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM facts WHERE json_extract(fact, '$.type') IN ('heartbeat', 'channelSeen')",
  )!.n;

test("polling repetido das portas não escreve nada, e um cancelamento e um trabalho novo ainda passam direto", async () => {
  await call("/v1/cards/next?wait=0", keys.chat);
  let seen = beenSeen();
  // Não que nada volte: o temporizador da central pode criar um cartão a qualquer momento, por um worker calado no relógio do teste.
  for (let n = 0; n < 10; n++) await call("/v1/cards/next?wait=0", keys.chat);
  assert.equal(beenSeen(), seen, "um canal ocioso fazendo polling");

  // O alerta também dá trabalho ao w1. Ele foi visto pela última vez no relógio do próprio teste, então seu vencimento de
  // offline estaria atrasado, e um vencimento atrasado se move a cada entrada até o temporizador alcançá-lo.
  runtime.heartbeat("w1", []);
  const ask = (query: string) => call(`/v1/work?wait=0&claim=door&${query}`, keys.w2);
  await call("/v1/events", keys.ops, { id: "door:1", type: "alert.raised", subject: "door" });
  const { job } = await ask("capacity=1");
  assert.equal(job.rule.name, "alerta");

  seen = beenSeen();
  for (let n = 0; n < 10; n++) {
    assert.deepEqual(await ask(`capacity=0&running=${job.run}`), { job: null, cancel: [] });
  }
  await call(`/v1/runs/${job.run}/cancel`, keys.owner, {});
  assert.deepEqual(await ask(`capacity=0&running=${job.run}`), { job: null, cancel: [job.run] });
  await call(`/v1/runs/${job.run}/result`, job.token, { outcome: "cancelled" });
  await call("/v1/events", keys.ops, { id: "door:2", type: "alert.raised", subject: "door" });
  const next = await call("/v1/work?wait=0&claim=door-2&capacity=1", keys.w2);
  assert.equal(next.job.rule.name, "alerta");
  assert.notEqual(next.job.run, job.run);
  assert.equal(beenSeen(), seen, "um worker consultando com uma rodada em mãos");
});
