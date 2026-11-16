// Modos de falha: decidir altera a entrada; tempo/aleatoriedade mudam a reprodução; fatos não commitados ficam visíveis;
// a reprodução perde regras, chaves ou recibos; capacidades em texto puro entram no log; escritas de projeção pulam o evolve;
// uma queda commita meio recibo; o stream perde o cursor; o why não identifica a regra usada por uma rodada.
// Normalizar eventos de recibo não pode alterar a requisição; workers que reconectam fecham cartões de Offline sem um tick.
// Fechar esse cartão não pode trazê-lo de volta na hora, nem esconder o trabalho que chega depois enquanto o worker segue ausente.
// Reconstruir uma projeção deve manter a mesma transação do seu snapshot de log, ou pode sobrescrever um recibo concorrente.
// IDs de eventos de fonte não podem colidir com IDs de respostas ou timers gerados internamente.
// Notificações silenciosas não podem escapar por um canal; um escritor defasado recebe Conflict, não uma falha de banco.
// Uma rodada na fila cuja regra foi removida ou renomeada espera para sempre, sem aviso, porque nada consegue pegá-la.
// Uma rodada interrompida pelo próprio recibo de falha devolve uso, sessão e marca de deduplicação ao que eram antes dele.
// Logs existentes podem ter uma rodada na fila com um Agent antigo após uma mudança de regras; a reprodução retém o que foi reservado.
// Uma entrada que o kernel não tem deve ser recusada, inclusive uma com o nome de algo que todo objeto herda.
// Um vencimento que nada vai mover de novo faz o único timer do host disparar na hora para sempre: um agendamento cuja regra
// sumiu ou não é mais agendada, um reenvio cujo horário passou com o canal ausente. Um reenvio também deve vencer no seu
// horário, ou um canal esperando o próximo cartão não é acordado para ele.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { empty, evolve, rows, snapshot, type Fact } from "../kernel/evolve.ts";
import { decide } from "../kernel/decide.ts";
import { InputError } from "../kernel/errors.ts";
import { parseRules } from "../protocol/rules.ts";
import { at } from "./helpers.ts";

const environment = { secret: "simulation-secret", publicUrl: "https://hub.test" };
const rules = parseRules(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"), 0, "UTC");
const seeded = () => evolve(empty(), decide(empty(), { type: "rules", args: [rules] }, 1, environment).facts);
test("decisões são determinísticas e deixam a entrada intacta", () => {
  const view = seeded();
  const before = snapshot(view);
  const input = { type: "ingest", args: ["app", { id: "1", type: "feedback.new", subject: "#1" }] };
  const a = decide(view, input, 1000, environment);
  const b = decide(view, input, 1000, environment);
  assert.deepEqual(a, b);
  assert.deepEqual(snapshot(view), before);
  assert.equal(rows(view, "events").length, 0);
  assert.equal(rows(evolve(view, a.facts), "events").length, 1);
  assert.throws(() => {
    view.get("config", "rules")!.value.bad = {};
  }, TypeError);
});

test("regras, reprodução de recibos e reconstrução retêm exatamente a mesma confirmação", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { commit, iterateLog } = await import("../kernel/store.ts");
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE facts(seq INTEGER PRIMARY KEY,fact TEXT); CREATE TABLE projections(collection TEXT,key TEXT,data TEXT,PRIMARY KEY(collection,key))",
  );
  let v = empty();
  const d = decide(v, { type: "rules", args: [rules] }, 0, environment);
  v = commit(db, v, () => d.facts);
  const expected = snapshot(v);
  db.prepare("INSERT INTO projections VALUES ('events','junk','{}')").run();
  const rebuilt = evolve(empty(), iterateLog(db), db, true);
  assert.deepEqual(snapshot(rebuilt), expected);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projections WHERE key='junk'").get()!.n, 0);
  db.close();
});

test("logs antigos com rotas defasadas na fila pegam a configuração atual e reproduzem as versões reservadas", () => {
  let view = seeded();
  const log: Fact[] = [...decide(empty(), { type: "rules", args: [rules] }, 1, environment).facts];
  const act = (type: string, ...args: unknown[]) => {
    const decided = decide(view, { type, args }, 1000 + log.length, environment);
    log.push(...decided.facts);
    view = evolve(view, decided.facts);
    return decided.value;
  };
  try {
    act("ingest", "app", { id: "old-log", type: "feedback.new" });
    const changed = structuredClone(rules);
    changed.rules[0].to = "a2";
    changed.rules[0].cwd = "/new-project";
    const version = view.seq + 1;
    // Antes desta correção, um fato de regras trocava apenas o config e deixava as atribuições na fila intactas.
    const oldFact: Fact = {
      version: 1,
      seq: version,
      at: 1002,
      type: "rules",
      changes: [{ table: "config", key: "rules", row: { value: changed, version } }],
    };
    log.push(oldFact);
    view = evolve(view, [oldFact]);
    assert.equal(act("claimNext", "w1", "old-worker"), null);
    const first = act("claimNext", "w2", "held");
    assert.equal(first.agent.id, "a2");
    assert.equal(first.rule.cwd, "/new-project");
    act("rules", rules);
    const rebuilt = evolve(empty(), log);
    try {
      const again = decide(rebuilt, { type: "claimNext", args: ["w2", "held"] }, 2000, environment).value;
      assert.deepEqual({ ...again, token: first.token }, first);
    } finally {
      rebuilt.close();
    }
  } finally {
    view.close();
  }
});
test("uma rodada na fila cuja regra sumiu é interrompida e diz isso, e o resto da fila segue", () => {
  let view = seeded();
  const act = (type: string, ...args: unknown[]) => {
    const decided = decide(view, { type, args }, 1000, environment);
    view = evolve(view, decided.facts);
    return decided.value;
  };
  try {
    act("ingest", "app", { id: "gone", type: "feedback.new" });
    act("ingest", "ops", { id: "stays", type: "alert.raised" });
    const [gone] = rows(view, "runs", { rule: "opiniões" });
    const [stays] = rows(view, "runs", { rule: "alerta" });
    const renamed = structuredClone(rules);
    renamed.rules.find((rule: { name: string }) => rule.name === "opiniões")!.name = "nome novo";
    act("rules", renamed);
    const stopped = view.get("runs", gone.id)!;
    assert.equal(stopped.state, "cancelled");
    assert.ok(stopped.finished_at);
    assert.match(stopped.summary, /A regra "opiniões" não existe mais/);
    assert.equal(view.get("runs", stays.id)!.state, "queued");
    const open = rows(view, "cards", { state: "open" });
    assert.deepEqual(
      open.map((card) => card.key),
      [`run:${gone.id}:rule-gone`],
    );
    assert.match(open[0].text, /A regra "opiniões" não existe mais/);
    act("rules", renamed);
    assert.equal(rows(view, "cards", { state: "open" }).length, 1, "avisado uma única vez");
  } finally {
    view.close();
  }
});
test("uma rodada já em curso quando a regra some termina normalmente, e se falhar é interrompida em vez de esperar", () => {
  let view = seeded();
  const act = (type: string, ...args: unknown[]) => {
    const decided = decide(view, { type, args }, 1000, environment);
    view = evolve(view, decided.facts);
    return decided.value;
  };
  try {
    act("ingest", "app", { id: "held", type: "feedback.new" });
    const job = act("claimNext", "w1", "claim");
    const renamed = structuredClone(rules);
    renamed.rules.find((rule: { name: string }) => rule.name === "opiniões")!.name = "nome novo";
    act("rules", renamed);
    assert.equal(view.get("runs", job.run)!.state, "claimed");
    act("finish", job.run, job.token, { outcome: "failed", error: "FALHOU" });
    const stopped = view.get("runs", job.run)!;
    assert.equal(stopped.state, "cancelled");
    assert.deepEqual([stopped.attempts, stopped.error, stopped.claim], [1, "FALHOU", null]);
    assert.equal(rows(view, "cards", { key: `run:${job.run}:rule-gone` }).length, 1);
  } finally {
    view.close();
  }
});
test("uma rodada interrompida pelo próprio recibo de falha mantém uso, sessão e marca de deduplicação daquele recibo", () => {
  let view = seeded();
  const act = (type: string, ...args: unknown[]) => {
    const decided = decide(view, { type, args }, 1000, environment);
    view = evolve(view, decided.facts);
    return decided.value;
  };
  try {
    act("ingest", "app", { id: "held", type: "feedback.new" });
    const job = act("claimNext", "w1", "claim");
    const renamed = structuredClone(rules);
    renamed.rules.find((rule: { name: string }) => rule.name === "opiniões")!.name = "nome novo";
    act("rules", renamed);
    const receipt = { outcome: "failed", error: "FALHOU", session: "s1", usage: { input: 5 } };
    act("finish", job.run, job.token, receipt);
    const stopped = view.get("runs", job.run)!;
    assert.equal(stopped.state, "cancelled");
    assert.equal(stopped.session, "s1");
    assert.deepEqual(JSON.parse(stopped.usage).input, 5);
    assert.equal(act("finish", job.run, job.token, receipt).duplicate, true);
  } finally {
    view.close();
  }
});
test("os fatos reproduzem o recibo inteiro sem nenhum texto puro de capacidade", () => {
  let view = empty();
  const log: Fact[] = [];
  const act = (type: string, ...args: unknown[]) => {
    const d = decide(view, { type, args }, 1000 + log.length, environment);
    log.push(...d.facts);
    view = evolve(view, d.facts);
    return d.value;
  };
  act("rules", rules);
  act("ingest", "app", { id: "1", type: "feedback.new" });
  const job = act("claimNext", "w1", "claim");
  act("finish", job.run, job.token, {
    outcome: "done",
    ask: [{ title: "escolha uma", text: "conteúdo", options: ["alfa", "beta"] }],
  });
  assert.deepEqual(snapshot(evolve(empty(), log)), snapshot(view));
  assert.ok(!JSON.stringify(log).includes(job.token));
  assert.ok(!JSON.stringify(log).includes(environment.secret));
  assert.equal(rows(view, "cards").length, 1);
});

test("uma única tabela de vencimentos retém cron, nova tentativa, timer e Offline sem ticking periódico", () => {
  let v = seeded();
  const act = (type: string, args: unknown[], now: number) => {
    const d = decide(v, { type, args }, now, environment);
    v = evolve(v, d.facts);
    return d.value;
  };
  act("tick", [], 1000);
  assert.ok(rows(v, "due").some((d) => d.kind === "cron"));
  act("ingest", ["app", { id: "1", type: "feedback.new" }], 1000);
  const job = act("claimNext", ["w1", "c"], 1000);
  act("finish", [job.run, job.token, { outcome: "failed" }], 2000);
  assert.ok(rows(v, "due").some((d) => d.kind === "retry" && d.at === 302000));
  assert.deepEqual(decide(v, { type: "tick", args: [] }, 2000, environment).facts, []);
});

test("um agendamento cuja regra sumiu ou não é mais agendada para de vencer", () => {
  let v = seeded();
  const act = (type: string, args: unknown[], now: number) => {
    v = evolve(v, decide(v, { type, args }, now, environment).facts);
  };
  act("tick", [], 1000);
  const schedules = () =>
    rows(v, "due")
      .filter((due) => due.kind === "cron")
      .map((due) => due.key)
      .sort();
  assert.deepEqual(schedules(), ["inspeção", "briefing matinal"].sort());
  const withoutMorning = rules.rules.filter((rule) => rule.name !== "briefing matinal");
  act("rules", [{ ...rules, rules: withoutMorning }], 2000);
  assert.deepEqual(schedules(), ["inspeção"]);
  const unscheduled = withoutMorning.map((rule) =>
    rule.name === "inspeção" ? { ...rule, when: { source: "app", types: ["poll.done"] } } : rule,
  );
  act("rules", [{ ...rules, rules: unscheduled }], 3000);
  assert.deepEqual(schedules(), []);
  // Nada mais move o próximo horário deles, então, passado ele, ficariam vencidos em todo tick dali em diante.
  act("tick", [], 30 * 24 * 3600_000);
  assert.deepEqual(schedules(), []);
});

test("o reenvio de um cartão vence no seu horário e para de vencer quando ele passa, é enviado ou tem desistência", () => {
  let v = seeded();
  const act = (type: string, args: unknown[], now: number) => {
    const d = decide(v, { type, args }, now, environment);
    v = evolve(v, d.facts);
    return d.value;
  };
  const { card } = act("tell", ["k", "aplicativo", "relatório semanal"], at(0));
  const resendAt = (id = card) => rows(v, "due").find((due) => due.kind === "delivery" && due.key === `${id}:chat`)?.at;
  // Pegou e nunca mais deu notícia: um canal esperando o próximo cartão acorda quando este pode ir de novo. O canal pode
  // ter sumido até lá, então o vencimento não pode ficar para trás.
  act("nextCard", ["chat"], at(0));
  assert.equal(resendAt(), at(1));
  act("tick", [], at(1));
  assert.equal(resendAt(), undefined);
  const tries = [1, 3, 7, 15, 25, 35, 45, 55];
  for (const [n, minute] of tries.entries()) {
    const { version } = act("nextCard", ["chat"], at(minute));
    act("failed", ["chat", card, version, "caiu"], at(minute));
    assert.equal(resendAt(), n + 1 < tries.length ? at(tries[n + 1]) : undefined, `após a tentativa em ${minute}`);
  }
  const { card: sent } = act("tell", ["k2", "aplicativo", "relatório mensal"], at(60));
  const { version } = act("nextCard", ["chat"], at(60));
  assert.equal(resendAt(sent), at(61));
  act("delivered", ["chat", sent, version, "om_1"], at(60));
  assert.equal(resendAt(sent), undefined);
});

test("uma entrada que o kernel não tem é recusada, inclusive uma com nome de algo que todo objeto tem", () => {
  const view = seeded();
  for (const type of ["nope", "constructor", "toString"])
    assert.throws(() => decide(view, { type, args: [] }, 1000, environment), InputError, type);
});

test("a normalização do recibo deixa a requisição intacta e pode ser decidida duas vezes", () => {
  let v = seeded();
  const act = (type: string, ...args: unknown[]) => {
    const d = decide(v, { type, args }, 1000, environment);
    v = evolve(v, d.facts);
    return d.value;
  };
  act("ingest", "app", { id: "x", type: "feedback.new" });
  const job = act("claimNext", "w1", "c");
  const input = {
    type: "finish",
    args: [job.run, job.token, { outcome: "done", events: [{ id: "next", type: "feedback.new" }] }],
  };
  const before = structuredClone(input);
  const a = decide(v, input, 2000, environment);
  const b = decide(v, input, 2000, environment);
  assert.deepEqual(input, before);
  assert.deepEqual(a, b);
});

/** Uma central com um worker e uma regra, e em que deu o cartão dela sobre esse worker não conectar. */
function workerAway() {
  const local = { ...rules, rules: rules.rules.filter((r) => "source" in r.when) };
  let v = evolve(empty(), decide(empty(), { type: "rules", args: [local] }, 0, environment).facts);
  const act = (type: string, args: unknown[], now: number) => {
    const d = decide(v, { type, args }, now, environment);
    v = evolve(v, d.facts);
    return d.value;
  };
  return {
    act,
    cards: () => rows(v, "cards").filter((card) => card.key.startsWith("worker:w1:offline:")),
    // O único timer do host é o que está aqui, então um cartão sem nada a vencer é um cartão que nunca aparece.
    dueBy: (now: number) => rows(v, "due").filter((due) => due.kind === "offline" && due.at <= now),
    waiting: () => rows(v, "runs", { state: "queued" }),
  };
}

test("o cartão sobre um worker que não conecta, uma vez fechado, fica fechado até o worker voltar", () => {
  const { act, cards, dueBy } = workerAway();
  act("heartbeat", ["w1", []], 0);
  act("ingest", ["app", { id: "x", type: "feedback.new" }], 0);
  assert.deepEqual(dueBy(600000), []);
  assert.equal(dueBy(600001).length, 1);
  act("tick", [], 600001);
  assert.equal(cards().length, 1);
  assert.deepEqual(dueBy(Infinity), [], "avisado, então não sobrou nada para vencer");
  act("answer", [cards()[0].id, { by: "o titular" }], 600002);
  assert.deepEqual(dueBy(Infinity), [], "nada vence para trazê-lo de volta");
  act("tick", [], 700000);
  assert.equal(cards().length, 1, "avisado uma única vez para este trabalho");
  act("heartbeat", ["w1", []], 800000);
  assert.equal(dueBy(800000 + 600000).length, 0);
  assert.equal(dueBy(800000 + 600001).length, 1, "voltou e sumiu de novo vence por conta própria");
  act("tick", [], 800000 + 600001);
  assert.equal(cards().length, 2, "uma ausência nova é avisada");
  assert.equal(cards().filter((card) => card.state === "open").length, 1);
});

test("o cartão sobre um worker que nunca conectou, uma vez fechado, também fica fechado", () => {
  const { act, cards, dueBy } = workerAway();
  act("ingest", ["app", { id: "x", type: "feedback.new" }], 0);
  assert.deepEqual(dueBy(600000), []);
  assert.equal(dueBy(600001).length, 1);
  act("tick", [], 600001);
  assert.equal(cards().length, 1);
  act("answer", [cards()[0].id, { by: "o titular" }], 600002);
  assert.deepEqual(dueBy(Infinity), []);
  act("tick", [], 700000);
  assert.equal(cards().length, 1);
  assert.equal(cards()[0].state, "closed");
});

test("o trabalho que chega depois de o cartão ser fechado é avisado, tenham ou não visto o worker antes", () => {
  for (const seen of [true, false]) {
    const { act, cards, dueBy, waiting } = workerAway();
    if (seen) act("heartbeat", ["w1", []], 0);
    act("ingest", ["app", { id: "x", type: "feedback.new" }], 0);
    act("tick", [], 600001);
    act("answer", [cards()[0].id, { by: "o titular" }], 600002);
    act("cancel", [waiting()[0].id], 700000);
    act("tick", [], 700000);
    assert.equal(cards().length, 1, "nada está esperando");

    const later = 7 * 24 * 60 * 60_000;
    act("ingest", ["app", { id: "y", type: "feedback.new" }], later);
    const whenDue = seen ? later : later + 600001;
    assert.deepEqual(dueBy(whenDue - 1), []);
    assert.equal(dueBy(whenDue).length, 1, "vence por conta própria");
    act("tick", [], whenDue);
    assert.equal(cards().length, 2);
    assert.equal(cards()[1].state, "open");
    assert.match(cards()[1].text, /1 tarefa/);
    assert.deepEqual(dueBy(Infinity), [], "avisado, então não sobrou nada para vencer");
  }
});

test("mais trabalho sobre o que o titular já fechou o cartão não é novidade", () => {
  const { act, cards, dueBy } = workerAway();
  act("heartbeat", ["w1", []], 0);
  act("ingest", ["app", { id: "x", type: "feedback.new" }], 0);
  act("tick", [], 600001);
  act("answer", [cards()[0].id, { by: "o titular" }], 600002);
  act("ingest", ["app", { id: "y", type: "feedback.new" }], 700000);
  assert.deepEqual(dueBy(Infinity), []);
  act("tick", [], 700000);
  assert.equal(cards().length, 1);
});

test("o heartbeat de um worker fecha o cartão de Offline dele sem trabalho agendado para depois", () => {
  const local = { ...rules, rules: rules.rules.filter((r) => "source" in r.when) };
  let v = evolve(empty(), decide(empty(), { type: "rules", args: [local] }, 0, environment).facts);
  const act = (type: string, args: unknown[], now: number) => {
    const d = decide(v, { type, args }, now, environment);
    v = evolve(v, d.facts);
    return d.value;
  };
  act("ingest", ["app", { id: "x", type: "feedback.new" }], 0);
  act("tick", [], 600001);
  assert.equal(rows(v, "cards").filter((c) => c.state === "open").length, 1);
  act("heartbeat", ["w1", []], 610000);
  assert.equal(rows(v, "cards").filter((c) => c.state === "open").length, 0);
  const job = act("claimNext", ["w1", "back"], 610000);
  act("finish", [job.run, job.token, { outcome: "done" }], 610001);
  assert.deepEqual(rows(v, "due"), []);
});

test("a reconstrução trava o snapshot do log e a projeção em uma única transação", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const store = await import("../kernel/store.ts");
  const directory = mkdtempSync(`${tmpdir()}/hub-rebuild-`);
  const db = new DatabaseSync(`${directory}/hub.db`);
  const other = new DatabaseSync(`${directory}/hub.db`);
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE facts(seq INTEGER PRIMARY KEY,fact TEXT); CREATE TABLE projections(collection TEXT,key TEXT,data TEXT,PRIMARY KEY(collection,key));",
    );
    let v = store.commit(db, empty(), () => decide(empty(), { type: "rules", args: [rules] }, 0, environment).facts);
    const concurrent = decide(
      v,
      { type: "ingest", args: ["app", { id: "during", type: "feedback.new" }] },
      1000,
      environment,
    );
    let attempted = false;
    const proxy = new Proxy(db, {
      get(target, key) {
        if (key === "exec")
          return (sql: string) => {
            target.exec(sql);
            if (sql === "DELETE FROM projections") {
              attempted = true;
              assert.throws(() => store.commit(other, v, () => concurrent.facts), /locked/);
            }
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    assert.equal(typeof store.rebuild, "function");
    const expected = snapshot(v);
    assert.deepEqual(snapshot(store.rebuild(proxy)), expected);
    assert.ok(attempted);
    v = store.commit(other, v, () => concurrent.facts);
    const updated = snapshot(v);
    assert.deepEqual(snapshot(store.rebuild(db)), updated);
  } finally {
    db.close();
    other.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("IDs de fonte não podem colidir com os eventos gerados por respostas ou timers", () => {
  let v = seeded();
  const act = (type: string, args: unknown[], now = 1000) => {
    const d = decide(v, { type, args }, now, environment);
    v = evolve(v, d.facts);
    return d.value;
  };
  act("ingest", ["app", { id: "start", type: "feedback.new" }]);
  const job = act("claimNext", ["w1", "start"]);
  act("finish", [
    job.run,
    job.token,
    {
      outcome: "done",
      ask: [{ title: "escolha", text: "conteúdo", options: ["alfa", "beta"] }],
      later: [{ key: "check", at: "1970-01-01T00:00:02Z", about: "verificar" }],
    },
  ]);
  for (const id of ["card:1", "card:1:1", "timer:1"]) act("ingest", ["app", { id, type: "unmatched" }]);
  act("answer", [1, { choice: 0 }]);
  act("tick", [], 2000);
  const events = rows(v, "events");
  assert.equal(new Set(events.map((e) => `${e.source}:${e.key}`)).size, events.length);
  assert.equal(events.filter((e) => e.type === "card.answered").length, 1);
  assert.equal(events.filter((e) => e.type === "timer.due").length, 1);
});

test("notificações silenciosas ficam de fora da entrega por canal", () => {
  let v = seeded();
  v = evolve(
    v,
    decide(
      v,
      { type: "createCard", args: [{ key: "quiet", kind: "notice", title: "silencioso", text: "nota", quiet: true }] },
      1000,
      environment,
    ).facts,
  );
  assert.equal(decide(v, { type: "nextCard", args: ["chat"] }, 1000, environment).value, null);
});

test("um escritor defasado recebe um conflito e não consegue mudar a view já commitada", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { commit, iterateLog } = await import("../kernel/store.ts");
  const { Conflict } = await import("../kernel/errors.ts");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE facts(seq INTEGER PRIMARY KEY,fact TEXT); CREATE TABLE projections(collection TEXT,key TEXT,data TEXT,PRIMARY KEY(collection,key));",
    );
    const initial = commit(db, empty(), () => decide(empty(), { type: "rules", args: [rules] }, 0, environment).facts);
    const changed = commit(
      db,
      initial,
      () =>
        decide(initial, { type: "ingest", args: ["app", { id: "first", type: "feedback.new" }] }, 1000, environment)
          .facts,
    );
    const stale = decide(
      initial,
      { type: "ingest", args: ["app", { id: "second", type: "feedback.new" }] },
      1000,
      environment,
    );
    assert.throws(() => commit(db, initial, () => stale.facts), Conflict);
    assert.deepEqual(snapshot(evolve(empty(), iterateLog(db))), snapshot(changed));
  } finally {
    db.close();
  }
});
