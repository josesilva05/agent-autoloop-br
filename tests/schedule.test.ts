// Os eventos do relógio. Casos de falha: um agendamento dispara quando não está vencido, duas vezes no mesmo instante,
// ou num agendamento que acabou de mudar; uma central dormindo através de várias execuções deve só a última (ou nenhuma);
// uma reverificação dispara cedo, duas vezes, ou não acorda o próprio assunto na sessão dele; escrever a mesma chave
// cria uma segunda reverificação; cancelar a preserva; uma reverificação disparada impede que outra seja marcada sob a
// mesma chave; um arquivo de regras ruim impede a central de subir ou não é avisado; avisado a cada tick, ou o cartão
// continua depois de corrigido; um arquivo de regras que some impede a central de subir, ou não é percebido quando volta
// para o lugar, ou traz de volta um cartão que o titular fechou a cada tick.
// Cancelar uma reverificação que não está em espera estraga o recibo em que ela está; uma reverificação que vence depois
// que a regra dela se foi para o relógio de todo o resto, ou inicia algo; um relógio voltado para trás roda o mesmo
// instante agendado uma segunda vez.
import assert from "node:assert/strict";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { at, setup } from "./helpers.ts";

const home = setup("schedule");
const rulesFile = join(home, "rules.json");
writeFileSync(rulesFile, readFileSync(process.env.AGENT_AUTOLOOP_RULES!, "utf8"));
process.env.AGENT_AUTOLOOP_RULES = rulesFile;
const { execute, reloadRules, tick } = await import("./hub.ts");
const { ingest } = await import("./hub.ts");
const { claimNext, finish, started, heartbeat } = await import("./hub.ts");
const { all, one, run } = await import("./storage.ts");

const clean = () => {
  for (const table of ["run_events", "runs", "events", "seen", "cards", "deliveries", "timers", "schedules"])
    run(`DELETE FROM ${table}`);
};
const ticks = () =>
  all<{ key: string }>("SELECT key FROM events WHERE type = 'schedule.tick' ORDER BY id").map((e) => e.key);
const claim = (worker: string, now: number) => claimNext(worker, `c${Math.random()}`, now);
const keepWorkersHere = (now: number) => {
  heartbeat("w1", [], now);
  heartbeat("w2", [], now);
};

test("um agendamento dispara uma vez quando vence, como um evento da própria regra", () => {
  clean();
  // 10:00 em Asia/Shanghai em at(0): o de cinco em cinco minutos vence em seguida às 10:05, o matinal só amanhã.
  tick(at(0));
  assert.deepEqual(ticks(), []);
  tick(at(4));
  assert.deepEqual(ticks(), []);
  tick(at(5));
  assert.deepEqual(ticks(), ["inspeção@2026-10-18T02:05:00.000Z"]);
  tick(at(5.5));
  assert.equal(ticks().length, 1);
  const job = claim("w1", at(6))!;
  assert.equal(job.rule.name, "inspeção");
  assert.deepEqual(
    job.context.events.map((e) => [e.source, e.sourceName, e.type]),
    [["schedule", "agendamento", "schedule.tick"]],
  );
  assert.deepEqual(JSON.parse(one<{ routed: string }>("SELECT routed FROM events")!.routed), ["inspeção"]);
});

test("uma central dormindo através de várias só deve a última", () => {
  clean();
  tick(at(0));
  tick(at(37));
  assert.deepEqual(ticks(), ["inspeção@2026-10-18T02:35:00.000Z"]);
  tick(at(38));
  assert.equal(ticks().length, 1);
  tick(at(40));
  assert.equal(ticks().length, 2);
});

test("um agendamento que muda começa a contar a partir da mudança", () => {
  clean();
  tick(at(0));
  const changed = JSON.parse(readFileSync(rulesFile, "utf8"));
  changed.rules[4].when.cron = "0 12 * * *";
  writeFileSync(rulesFile, JSON.stringify(changed));
  tick(at(6));
  assert.deepEqual(ticks(), [], "o horário antigo não dispara sob o agendamento novo");
  tick(at(119));
  assert.deepEqual(ticks(), []);
  tick(at(120));
  assert.deepEqual(ticks(), ["inspeção@2026-10-18T04:00:00.000Z"]);
  changed.rules[4].when.cron = "*/5 * * * *";
  writeFileSync(rulesFile, JSON.stringify(changed));
  tick(at(121));
});

test("a reverificação de uma rodada dispara uma vez na hora dela, no assunto dela, na sessão dela, com o que ela deixou", () => {
  clean();
  ingest("app", { id: "1", type: "feedback.new", subject: "#1" }, at(0));
  const job = claim("w1", at(0))!;
  started(job.run, job.token, { session: "s-1" }, at(0));
  finish(
    job.run,
    job.token,
    {
      outcome: "done",
      later: [{ key: "recheck", at: new Date(at(60)).toISOString(), about: "ver se o site original se recuperou" }],
    },
    at(1),
  );
  keepWorkersHere(at(59));
  tick(at(59));
  assert.equal(claim("w1", at(59)), null);
  keepWorkersHere(at(60));
  tick(at(60));
  tick(at(60.5));
  // 11:00 é também quando a regra de cinco em cinco minutos vence, no mesmo worker.
  const poll = claim("w1", at(61))!;
  assert.equal(poll.rule.name, "inspeção");
  finish(poll.run, poll.token, { outcome: "nothing" }, at(61));
  const next = claim("w1", at(61))!;
  assert.equal(next.rule.name, "opiniões");
  assert.equal(next.session, "s-1");
  assert.deepEqual(
    next.context.events.map((e) => [e.type, e.subject]),
    [["timer.due", "#1"]],
  );
  assert.deepEqual(
    next.context.timers.map((t) => [t.key, t.about]),
    [["recheck", "ver se o site original se recuperou"]],
  );
  finish(
    next.run,
    next.token,
    { outcome: "nothing", later: [{ key: "recheck", at: new Date(at(120)).toISOString(), about: "ver mais uma vez" }] },
    at(62),
  );
  assert.equal(
    all("SELECT id FROM timers WHERE event_id IS NULL").length,
    1,
    "a que disparou não impede uma nova sob a mesma chave",
  );
});

test("a mesma chave move a reverificação; outro assunto tem a sua; uma rodada vê o que está em espera e pode cancelar", () => {
  clean();
  const end = (n: number, now: number, later: object[]) => {
    ingest("app", { id: `${n}:${now}`, type: "feedback.new", subject: `#${n}` }, now);
    const job = claim("w1", now)!;
    const seen = job.context.waiting;
    finish(job.run, job.token, { outcome: "done", later }, now);
    return seen;
  };
  end(1, at(0), [{ key: "k", at: new Date(at(100)).toISOString(), about: "primeira vez" }]);
  const seen = end(1, at(1), [{ key: "k", at: new Date(at(200)).toISOString(), about: "mudou" }]);
  assert.deepEqual(
    seen.map((t) => [t.key, t.about]),
    [["k", "primeira vez"]],
  );
  end(2, at(2), [{ key: "k", at: new Date(at(300)).toISOString(), about: "outro assunto" }]);
  assert.deepEqual(
    all<{ lane: string; about: string; at: string }>("SELECT lane, about FROM timers ORDER BY id").map((t) => [
      t.lane,
      t.about,
    ]),
    [
      ["#1", "mudou"],
      ["#2", "outro assunto"],
    ],
  );
  end(1, at(3), [{ key: "k", cancel: true }]);
  assert.deepEqual(
    all<{ lane: string }>("SELECT lane FROM timers").map((t) => t.lane),
    ["#2"],
  );
});

test("cancelar uma reverificação que não está em espera não muda nada, e o resto do recibo conta", () => {
  clean();
  ingest("app", { id: "1", type: "feedback.new", subject: "#1" }, at(0));
  const job = claim("w1", at(0))!;
  const later = [
    { key: "never-set", cancel: true },
    { key: "kept", at: new Date(at(100)).toISOString(), about: "ver de novo" },
  ];
  assert.deepEqual(finish(job.run, job.token, { outcome: "done", summary: "Pronto", later }, at(1)).rejected, []);
  assert.equal(one<{ state: string }>("SELECT state FROM runs WHERE id = ?", [job.run])!.state, "done");
  assert.deepEqual(
    all<{ key: string }>("SELECT key FROM timers").map((t) => t.key),
    ["kept"],
  );
});

test("uma reverificação que vence depois que a regra se foi fica registrada, não inicia nada e não para o relógio", () => {
  clean();
  ingest("app", { id: "1", type: "feedback.new", subject: "#1" }, at(0));
  const job = claim("w1", at(0))!;
  const later = [{ key: "recheck", at: new Date(at(60)).toISOString(), about: "ver se o site original se recuperou" }];
  finish(job.run, job.token, { outcome: "done", later }, at(1));
  const before = readFileSync(rulesFile, "utf8");
  const changed = JSON.parse(before);
  changed.rules = changed.rules.filter((rule: { name: string }) => rule.name !== "opiniões");
  writeFileSync(rulesFile, JSON.stringify(changed));
  try {
    tick(at(60));
    const event = one<{ routed: string }>("SELECT routed FROM events WHERE type = 'timer.due'")!;
    assert.deepEqual(JSON.parse(event.routed), []);
    assert.deepEqual(all("SELECT id FROM timers WHERE event_id IS NULL"), [], "ela não vence de novo");
    assert.deepEqual(all("SELECT id FROM runs WHERE rule = 'opiniões' AND state = 'queued'"), []);
  } finally {
    writeFileSync(rulesFile, before);
    reloadRules();
  }
});

test("um relógio voltado para trás não roda o mesmo instante agendado duas vezes, mesmo com o agendamento mudado no meio", () => {
  clean();
  tick(at(0));
  tick(at(5));
  assert.deepEqual(ticks(), ["inspeção@2026-10-18T02:05:00.000Z"]);
  const before = readFileSync(rulesFile, "utf8");
  const changed = JSON.parse(before);
  changed.rules = changed.rules.map((rule: { name: string }) =>
    rule.name === "inspeção" ? { ...rule, when: { cron: "5 10 * * *" } } : rule,
  );
  // De volta às 10:02, um agendamento que também lê 10:05 começa a contar a partir dali.
  writeFileSync(rulesFile, JSON.stringify(changed));
  try {
    tick(at(2));
    tick(at(5));
    assert.deepEqual(ticks(), ["inspeção@2026-10-18T02:05:00.000Z"]);
  } finally {
    writeFileSync(rulesFile, before);
    reloadRules();
  }
});

test("um arquivo de regras ruim mantém a central rodando, avisa uma vez, e o cartão fecha quando é corrigido", () => {
  clean();
  const good = readFileSync(rulesFile, "utf8");
  const bad = JSON.parse(good);
  bad.rules[0].to = "nobody";
  writeFileSync(rulesFile, JSON.stringify(bad));
  const stamp = new Date(Date.now() + 2000);
  tick(at(0));
  tick(at(1));
  const cards = () => all<{ title: string; text: string; state: string }>("SELECT title, text, state FROM cards");
  assert.equal(cards().length, 1);
  assert.match(cards()[0].text, /nobody/);
  assert.equal(cards()[0].state, "open");
  writeFileSync(rulesFile, good);
  void stamp;
  tick(at(2));
  assert.equal(cards()[0].state, "closed");
});

test("um arquivo de regras que some mantém a central rodando, avisa uma vez, e o cartão fecha quando ele volta", () => {
  clean();
  const away = `${rulesFile}.away`;
  // Voltar com ele preserva o tempo de modificação, então o retorno não pode parecer que nada mudou.
  renameSync(rulesFile, away);
  tick(at(0));
  tick(at(1));
  const cards = () => all<{ text: string; state: string }>("SELECT text, state FROM cards");
  assert.equal(cards().length, 1);
  assert.match(cards()[0].text, /não encontrei/);
  assert.equal(cards()[0].state, "open");
  renameSync(away, rulesFile);
  tick(at(2));
  assert.equal(cards()[0].state, "closed");
});

test("um cartão fechado enquanto o arquivo de regras ainda some continua fechado, e sumir de novo depois de voltar é avisado de novo", () => {
  clean();
  const away = `${rulesFile}.away`;
  const cards = () => all<{ id: number; state: string }>("SELECT id, state FROM cards ORDER BY id");
  renameSync(rulesFile, away);
  try {
    tick(at(0));
    assert.equal(cards().length, 1);
    execute("answer", [cards()[0].id, { by: "o titular" }], at(1));
    tick(at(2));
    assert.equal(cards().length, 1, "o titular ficou sabendo");
    renameSync(away, rulesFile);
    tick(at(3));
    renameSync(rulesFile, away);
    tick(at(4));
    assert.equal(cards().length, 2);
  } finally {
    renameSync(away, rulesFile);
    tick(at(5));
  }
});
