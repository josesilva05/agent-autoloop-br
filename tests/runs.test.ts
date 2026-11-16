// O trabalho vai para o worker do Agent da regra, uma rodada por vez em cada grupo, ou, para uma regra que roda em paralelo,
// uma rodada por vez para cada objeto e não mais que o número dela de uma vez no grupo, e volta com o que aconteceu.
// Casos de falha: um worker pega trabalho do Agent de outro worker, ou o mesmo trabalho duas vezes; uma resposta perdida para um
// claim perde o trabalho (o mesmo claim precisa recebê-lo de volta) ou o entrega duas vezes; eventos que chegam enquanto o
// trabalho espera criam mais rodadas em vez de entrar nele; trabalho num grupo começa enquanto outro nele ainda roda; uma regra
// paralela põe dois objetos numa rodada só, começa uma segunda rodada num objeto enquanto uma roda, ou mais rodadas de uma vez do
// que o número dela; uma rodada concluída deixa a próxima esperando; uma rodada que falhou é perdida, é tentada de novo na hora,
// não é mesclada com o que chegou nesse meio tempo para ela, ou é mesclada com a de outro objeto; o titular é avisado de cada
// rodada em vez do que a regra diz, não é avisado de uma terceira falha seguida, é avisado dela duas vezes, ou não é avisado
// quando um worker para de relatar o trabalho que pegou ou para de aparecer; um token de rodada serve para outra rodada, ou um
// token antigo é aceito depois de a rodada ter sido entregue de novo; um resultado reenviado não é reconhecido, ou um diferente
// sob um token antigo é aceito; o recibo de uma rodada que falhou tem efeito (ela vai rodar de novo) além do que conta ao
// titular; um worker que sumiu com trabalho na mão libera o grupo enquanto o trabalho pode ainda estar em curso; cancelar libera
// o assunto antes de o worker dizer que parou; uma nova tentativa não recebe a própria sessão de volta; novas tentativas
// sobrescrevem o uso ou resultados reenviados o contam duas vezes; uma rodada que continua falhando segue gastando para sempre,
// para sem avisar o titular, ou leva eventos mais novos junto.
// Um relato de início é aceito com o que quer que contenha, por mais longo; parar uma rodada que não existe ou que já terminou
// quebra, ou a marca como parando.
// Recarregar as regras não pode combinar um Agent antigo com uma pasta nova, nem mudar um trabalho já reclamado e o worker dele.
// Limites de regra e de Agent precisam valer entre objetos e regras diferentes, sem perder o trabalho enfileirado separado deles.
import assert from "node:assert/strict";
import { test } from "node:test";
import { at, setup } from "./helpers.ts";

setup("runs");
const { ingest } = await import("./hub.ts");
const { claimNext, heartbeat, finish, started, sweep, cancel, cancels } = await import("./hub.ts");
const { AuthError, Conflict, InputError, NotFound } = await import("../kernel/errors.ts");
const { all, one, run } = await import("./storage.ts");

const note = (n: number, step = "new") => ({
  id: `feedback:${n}:${step}`,
  type: `feedback.${step}`,
  subject: `#${n}`,
  summary: `evento ${n}`,
  link: `https://x.test/feedback?id=${n}`,
});
const alert = (key: string) => ({ id: `alert:${key}`, type: "alert.raised", subject: key });
const told = () =>
  all<{ key: string; title: string; text: string; state: string }>(
    "SELECT key, title, text, state FROM cards ORDER BY id",
  );
const clean = () => {
  for (const table of ["run_events", "runs", "events", "seen", "cards", "deliveries", "timers"])
    run(`DELETE FROM ${table}`);
};
const claim = (worker: string, now: number) => claimNext(worker, `c${Math.random()}`, now);
const state = (id: number) => one<{ state: string }>("SELECT state FROM runs WHERE id = ?", [id])!.state;

test("o uso acumula entre tentativas uma vez só, sem inventar campos não relatados", () => {
  clean();
  ingest("app", note(1), at(0));
  const first = claim("w1", at(0))!;
  const failed = { outcome: "failed", usage: { input: 1000, output: 100, cost: 1 } };
  finish(first.run, first.token, failed, at(1));
  finish(first.run, first.token, failed, at(2));
  const retry = claim("w1", at(6))!;
  const done = { outcome: "done", usage: { input: 200, output: 20, cost: 0.2 } };
  finish(retry.run, retry.token, done, at(7));
  finish(retry.run, retry.token, done, at(8));
  const usage = JSON.parse(one<{ usage: string }>("SELECT usage FROM runs WHERE id = ?", [first.run])!.usage);
  assert.deepEqual(usage, { input: 1200, output: 120, cost: 1.2 });
});

test("o trabalho vai só para o worker do Agent dele, uma vez, com a regra e o que ler", () => {
  clean();
  ingest("ops", alert("probe.public"), at(0));
  const w2 = claim("w2", at(1))!;
  assert.equal(w2.rule.name, "alerta");
  assert.equal(w2.agent.use, "codex");
  assert.equal(w2.agent.access, "full");
  assert.deepEqual(
    w2.context.events.map((e) => [e.sourceName, e.type, e.subject]),
    [["operações", "alert.raised", "probe.public"]],
  );
  assert.ok(w2.askFirst.includes("apagar dados"));
  assert.equal(claim("w2", at(1)), null);
  const w1 = claim("w1", at(1))!;
  assert.equal(w1.rule.name, "alerta também registra");
  assert.equal(w1.agent.access, "edit");
  assert.equal(claim("w1", at(1)), null);
  assert.equal(claim("nobody", at(1)), null);
});

test("trabalho enfileirado pega o Agent e a pasta atuais juntos; um claim retido mantém a configuração dele", async () => {
  clean();
  const hub = await import("./hub.ts");
  const before = hub.getView().get("config", "rules")!.value;
  const next = structuredClone(before);
  next.rules[0].to = "a2";
  next.rules[0].cwd = "/new-project";
  ingest("app", note(1), at(0));
  try {
    hub.execute("rules", [next], at(1));
    assert.equal(claim("w1", at(2)), null, "o worker anterior não pode pegar a configuração nova");
    const first = claimNext("w2", "reloaded", at(2))!;
    assert.ok(first);
    assert.equal(first.agent.id, "a2");
    assert.equal(first.rule.cwd, "/new-project");
    const later = structuredClone(next);
    later.rules[0].cwd = "/another-project";
    later.agents.a2.worker = "w3";
    later.agents.a2.access = "read";
    hub.execute("rules", [later], at(3));
    const again = claimNext("w2", "reloaded", at(4))!;
    assert.ok(again, "uma resposta de claim perdida ainda pertence ao worker original dela");
    assert.deepEqual({ ...again, token: first.token }, first);
    heartbeat("w2", [first.run], at(5));
    assert.equal(hub.getView().get("runs", first.run)!.seen_at, new Date(at(5)).toISOString());
    cancel(first.run, at(6));
    assert.deepEqual(cancels("w2"), [first.run]);
    assert.deepEqual(cancels("w3"), []);
  } finally {
    hub.execute("rules", [before], at(7));
  }
});

test("um claim cuja resposta se perdeu recebe o mesmo trabalho de volta, sob um token que funciona", () => {
  clean();
  ingest("ops", alert("x"), at(0));
  const first = claimNext("w2", "claim-1", at(1))!;
  const again = claimNext("w2", "claim-1", at(2))!;
  assert.equal(again.run, first.run);
  assert.equal(again.attempt, first.attempt);
  assert.throws(
    () => finish(first.run, first.token, { outcome: "done" }, at(3)),
    AuthError,
    "a resposta que se perdeu não segura nada",
  );
  finish(again.run, again.token, { outcome: "done", summary: "pronto" }, at(3));
  assert.equal(claimNext("w2", "claim-1", at(4)), null, "um claim que terminou não volta");
  // O id de claim de outro worker não chega até ele.
  ingest("ops", alert("y"), at(5));
  const third = claimNext("w2", "claim-2", at(5))!;
  assert.equal(claimNext("w1", "claim-2", at(6))?.run === third.run, false);
});

test("eventos enquanto o trabalho espera entram nele; enquanto ele roda, esperam a próxima rodada", () => {
  clean();
  ingest("ops", alert("first"), at(0));
  ingest("ops", alert("second"), at(1));
  const first = claim("w2", at(2))!;
  assert.deepEqual(
    first.context.events.map((e) => e.subject),
    ["first", "second"],
  );
  ingest("ops", alert("third"), at(3));
  assert.equal(claim("w2", at(4)), null, "o grupo já tem uma rodada em curso");
  finish(first.run, first.token, { outcome: "done", summary: "dois alertas tratados" }, at(5));
  const second = claim("w2", at(5))!;
  assert.deepEqual(
    second.context.events.map((e) => e.subject),
    ["third"],
  );
});

test("uma regra paralela roda cada objeto por conta própria, não mais que o número dela de uma vez", () => {
  clean();
  for (const n of [1, 2, 3, 4]) ingest("app", note(n), at(n));
  const running = [1, 2, 3].map(() => claim("w1", at(5))!);
  assert.deepEqual(
    running.map((job) => job.context.events.map((e) => e.subject)),
    [["#1"], ["#2"], ["#3"]],
  );
  assert.equal(claim("w1", at(5)), null, "três de uma vez, no máximo");
  finish(running[1].run, running[1].token, { outcome: "done", summary: "evento 2 corrigido" }, at(6));
  assert.deepEqual(
    claim("w1", at(6))!.context.events.map((e) => e.subject),
    ["#4"],
  );
});

test("um limite de regra deixa os objetos separados ao compartilhar um grupo com outras regras", async () => {
  clean();
  const hub = await import("./hub.ts");
  const before = hub.getView().get("config", "rules")!.value;
  const next = structuredClone(before);
  next.rules[0].maxActive = 1;
  next.rules[2].group = next.rules[0].group;
  next.rules[2].parallel = next.rules[0].parallel;
  hub.execute("rules", [next], at(0));
  try {
    ingest("app", note(1), at(1));
    ingest("app", note(2), at(2));
    ingest("ops", alert("probe"), at(3));
    const first = claim("w1", at(4))!;
    assert.deepEqual(
      first.context.events.map((event) => event.subject),
      ["#1"],
    );
    assert.equal(claim("w1", at(4))?.rule.name, "alerta também registra");
    assert.equal(claim("w1", at(4)), null);
    finish(first.run, first.token, { outcome: "done" }, at(5));
    assert.deepEqual(
      claim("w1", at(5))!.context.events.map((event) => event.subject),
      ["#2"],
    );
  } finally {
    hub.execute("rules", [before], at(6));
  }
});

test("um limite de Agent vale entre regras sem bloquear outro Agent no worker dele", async () => {
  clean();
  const hub = await import("./hub.ts");
  const before = hub.getView().get("config", "rules")!.value;
  const next = structuredClone(before);
  next.agents.a1.maxActive = 1;
  next.agents.a2.worker = "w1";
  hub.execute("rules", [next], at(0));
  try {
    ingest("app", note(1), at(1));
    ingest("ops", alert("probe"), at(2));
    const first = claim("w1", at(3))!;
    assert.equal(first.rule.name, "opiniões");
    assert.equal(claim("w1", at(3))?.rule.name, "alerta");
    assert.equal(claim("w1", at(3)), null);
    finish(first.run, first.token, { outcome: "done" }, at(4));
    assert.equal(claim("w1", at(4))?.rule.name, "alerta também registra");
  } finally {
    hub.execute("rules", [before], at(5));
  }
});

test("os eventos de um objeto entram na rodada dele que espera, e esperam enquanto ela roda; outros objetos seguem", () => {
  clean();
  ingest("app", note(1), at(0));
  ingest("app", note(1, "followup"), at(1));
  ingest("app", note(2), at(2));
  const first = claim("w1", at(3))!;
  assert.deepEqual(
    first.context.events.map((e) => [e.type, e.subject]),
    [
      ["feedback.new", "#1"],
      ["feedback.followup", "#1"],
    ],
  );
  assert.deepEqual(
    claim("w1", at(3))!.context.events.map((e) => e.subject),
    ["#2"],
  );
  ingest("app", note(1, "decided"), at(4));
  assert.equal(claim("w1", at(4)), null, "#1 já tem uma rodada em curso");
  finish(first.run, first.token, { outcome: "done", summary: "evento 1 pronto" }, at(5));
  assert.deepEqual(
    claim("w1", at(5))!.context.events.map((e) => [e.type, e.subject]),
    [["feedback.decided", "#1"]],
  );
});

test("uma rodada que falhou volta depois com o que chegou nesse meio tempo, na própria sessão, e a terceira falha seguida é contada uma vez", () => {
  clean();
  ingest("app", note(1), at(0));
  let job = claim("w1", at(0))!;
  assert.equal(job.session, null);
  started(job.run, job.token, { session: "s-1", link: "app://s-1" }, at(0));
  ingest("app", note(1, "followup"), at(1));
  ingest("app", note(2), at(1));
  const other = claim("w1", at(1))!;
  assert.deepEqual(
    other.context.events.map((e) => e.subject),
    ["#2"],
  );
  finish(job.run, job.token, { outcome: "failed", error: "as ferramentas não carregaram" }, at(2));
  assert.equal(claim("w1", at(6)), null, "a primeira nova tentativa espera cinco minutos");
  job = claim("w1", at(7))!;
  assert.equal(job.attempt, 2);
  assert.equal(job.session, "s-1");
  assert.deepEqual(
    job.context.events.map((e) => [e.type, e.subject]),
    [
      ["feedback.new", "#1"],
      ["feedback.followup", "#1"],
    ],
  );
  assert.deepEqual(
    all<{ id: number }>("SELECT id FROM runs WHERE rule = 'opiniões' ORDER BY id").map((r) => r.id),
    [job.run, other.run],
  );
  finish(job.run, job.token, { outcome: "failed", error: "as ferramentas não carregaram" }, at(8));
  assert.equal(claim("w1", at(17)), null, "a segunda espera dez");
  job = claim("w1", at(18))!;
  assert.deepEqual(told(), []);
  finish(job.run, job.token, { outcome: "failed", error: "as ferramentas não carregaram" }, at(19));
  assert.equal(told().length, 1);
  assert.match(
    told()[0].text,
    /O tratamento automático não concluiu 3 vezes seguidas \(parou em: as ferramentas não carregaram\); nova tentativa automática às 10:39/,
  );
  job = claim("w1", at(39))!;
  finish(job.run, job.token, { outcome: "failed", error: "ainda não funciona" }, at(40));
  assert.equal(told().length, 1);
  assert.equal(claim("w1", at(79)), null, "e assim por diante, dobrando");
  job = claim("w1", at(80))!;
  finish(job.run, job.token, { outcome: "done", summary: "pronto" }, at(81));
  assert.equal(told()[0].state, "closed", "depois que funcionou, o cartão de falha se fecha sozinho");
});

test("depois de dez falhas seguidas uma rodada para, avisa o titular uma vez, e eventos mais novos ainda são feitos", () => {
  clean();
  ingest("app", note(1), at(0));
  const step = 100;
  let job = claim("w1", at(0))!;
  const { run: id } = job;
  for (let failure = 1; failure < 10; failure++) {
    finish(id, job.token, { outcome: "failed", error: "sem login" }, at(failure * step));
    assert.equal(state(id), "queued", `ainda tentando de novo depois da falha ${failure}`);
    job = claim("w1", at((failure + 1) * step - 1))!;
    assert.equal(job.run, id);
  }
  ingest("app", note(1, "followup"), at(10 * step - 2));
  finish(id, job.token, { outcome: "failed", error: "sem login." }, at(10 * step));
  assert.equal(state(id), "cancelled");
  const stopped = one<{ attempts: number; error: string; summary: string; finished_at: string }>(
    "SELECT attempts, error, summary, finished_at FROM runs WHERE id = ?",
    [id],
  )!;
  assert.equal(stopped.attempts, 10);
  assert.equal(stopped.error, "sem login");
  assert.match(stopped.summary, /Não concluiu 10 vezes seguidas/);
  assert.ok(stopped.finished_at);
  const open = told().filter((card) => card.state === "open");
  assert.deepEqual(
    open.map((card) => card.key),
    [`run:${id}:stopped`],
    "o cartão da terceira falha foi substituído por este",
  );
  assert.match(
    open[0].text,
    /O tratamento automático não concluiu 10 vezes seguidas.*parou em: sem login.*não haverá mais nova tentativa automática/,
  );

  const next = claim("w1", at(10 * step + 1))!;
  assert.notEqual(next.run, id, "o que chegou nesse meio tempo é uma rodada própria, com uma contagem limpa");
  assert.equal(next.attempt, 1);
  assert.deepEqual(
    next.context.events.map((event) => event.type),
    ["feedback.followup"],
  );
  finish(next.run, next.token, { outcome: "done", summary: "pronto" }, at(10 * step + 2));
  assert.equal(claim("w1", at(100 * step)), null, "não sobrou nada para rodar de novo por conta própria");
});

test("o titular é avisado do que a regra diz: needed só com um cartão, always toda vez, never só o que trava o trabalho", () => {
  clean();
  ingest("app", note(1), at(0));
  let job = claim("w1", at(0))!;
  finish(job.run, job.token, { outcome: "done", summary: "evento 1 corrigido" }, at(1));
  assert.deepEqual(told(), []);
  ingest("app", note(2), at(2));
  job = claim("w1", at(2))!;
  finish(
    job.run,
    job.token,
    {
      outcome: "done",
      summary: "código em produção",
      notice: [{ title: "Permissão a liberar", text: "Ação sua: libere a permissão de leitura dos dados." }],
    },
    at(3),
  );
  assert.deepEqual(
    told().map((m) => [m.title, m.text, m.state]),
    [["Permissão a liberar", "Ação sua: libere a permissão de leitura dos dados.", "open"]],
  );

  clean();
  ingest("ops", alert("probe.public"), at(0));
  const ops = claim("w2", at(0))!;
  const quiet = claim("w1", at(0))!;
  finish(ops.run, ops.token, { outcome: "done", summary: "o site voltou ao normal" }, at(1));
  finish(
    quiet.run,
    quiet.token,
    { outcome: "done", summary: "registrado", notice: [{ title: "Dar uma olhada", text: "detalhes" }] },
    at(1),
  );
  const cards = all<{ title: string; text: string; state: string; fyi: number; quiet: number }>(
    "SELECT title, text, state, fyi, quiet FROM cards ORDER BY id",
  );
  assert.deepEqual(
    cards[0],
    { title: "alerta", text: "o site voltou ao normal", state: "closed", fyi: 1, quiet: 0 },
    "always: avisado e não precisa de nada de volta",
  );
  assert.deepEqual(
    cards[1],
    { title: "Dar uma olhada", text: "detalhes", state: "open", fyi: 0, quiet: 1 },
    "never: guardado para a página, não enviado",
  );
});

test("uma rodada sem nada a fazer não é contada a ninguém e libera o grupo dela", () => {
  clean();
  ingest("ops", alert("probe.public"), at(0));
  const job = claim("w2", at(0))!;
  finish(job.run, job.token, { outcome: "nothing", summary: "já foi restabelecido" }, at(1));
  assert.equal(state(job.run), "nothing");
  assert.deepEqual(told(), []);
  ingest("ops", alert("probe.public:2"), at(2));
  assert.ok(claim("w2", at(2)));
});

test("um resultado é verificado com rigor e nada de um resultado inválido tem efeito", () => {
  clean();
  ingest("ops", alert("x"), at(0));
  const job = claim("w2", at(0))!;
  for (const bad of [
    null,
    [],
    {},
    { outcome: "maybe" },
    { outcome: "done", oops: 1 },
    { outcome: "done", summary: "x".repeat(501) },
    { outcome: "failed", error: "x".repeat(501) },
    { outcome: "done", ask: [{ title: "x", text: "y", options: ["só uma"] }] },
    { outcome: "done", ask: [{ title: "x", text: "y", options: ["a", "b", "c", "d", "e", "f"] }] },
    { outcome: "done", ask: [{ title: "x", text: "y", options: ["a", "b"], recommend: 2 }] },
    { outcome: "done", ask: [{ title: "", text: "y", options: ["a", "b"] }] },
    { outcome: "done", notice: [{ title: "x".repeat(201), text: "y" }] },
    { outcome: "done", resolve: [{ card: 1.5, reason: "x" }] },
    { outcome: "done", resolve: [{ card: 1, reason: " " }] },
    { outcome: "done", later: [{ key: "x", at: "not a time", about: "y" }] },
    { outcome: "done", later: [{ key: "x", at: "2026-10-18T10:00:00", about: "y" }] },
    { outcome: "done", later: [{ key: "x", cancel: false }] },
    { outcome: "done", usage: { input: "many" } },
  ])
    assert.throws(() => finish(job.run, job.token, bad, at(1)), InputError, JSON.stringify(bad));
  assert.equal(state(job.run), "claimed");
  assert.deepEqual(told(), []);
});

test("o recibo de uma rodada que falhou avisa o titular mas não muda mais nada: ela vai rodar de novo", () => {
  clean();
  ingest("app", note(1), at(0));
  let job = claim("w1", at(0))!;
  const seen = job.run;
  const receipt = finish(
    job.run,
    job.token,
    {
      outcome: "failed",
      error: "precisa de aprovação",
      notice: [{ title: "Preciso da sua aprovação", text: "confirme as permissões do servidor" }],
      ask: [{ title: "x", text: "y", options: ["a", "b"] }],
      later: [{ key: "k", at: "2026-10-18T10:00:00+08:00", about: "y" }],
      events: [{ id: "e", type: "feedback.new" }],
    },
    at(1),
  );
  assert.deepEqual(
    told().map((m) => m.title),
    ["Preciso da sua aprovação"],
  );
  assert.equal(all("SELECT id FROM timers").length, 0);
  assert.equal(all("SELECT id FROM events").length, 1);
  assert.deepEqual(
    receipt.rejected.map((r) => r.reason),
    [
      "uma rodada que falhou só pode enviar notificação",
      "uma rodada que falhou só pode enviar notificação",
      "uma rodada que falhou só pode enviar notificação",
    ],
  );
  // O mesmo aviso quando falha de novo não é contado de novo; um novo é. E uma falha com o próprio aviso não é contada também como falha.
  for (const n of [1, 2]) {
    job = claim("w1", at(70 * n))!;
    assert.equal(job.run, seen);
    finish(
      job.run,
      job.token,
      {
        outcome: "failed",
        error: "precisa de aprovação",
        notice: [
          { title: "Preciso da sua aprovação", text: "confirme as permissões do servidor" },
          ...(n === 2 ? [{ title: "Ainda falta", text: "conecte o celular" }] : []),
        ],
      },
      at(70 * n),
    );
  }
  assert.deepEqual(
    told().map((m) => m.title),
    ["Preciso da sua aprovação", "Ainda falta"],
  );
});

test("um token de rodada serve só para a rodada dele, e só para aquela tentativa; um reenvio recebe a mesma resposta", () => {
  clean();
  ingest("app", note(1), at(0));
  ingest("ops", alert("x"), at(0));
  const mine = claim("w1", at(0))!;
  const theirs = claim("w2", at(0))!;
  assert.throws(() => finish(mine.run, theirs.token, { outcome: "done", summary: "x" }, at(1)), AuthError);
  assert.throws(() => started(mine.run, "made-up", { link: "app://1" }, at(1)), AuthError);
  started(mine.run, mine.token, { link: "app://1" }, at(1));
  const failure = { outcome: "failed", error: "sem rede" };
  finish(mine.run, mine.token, failure, at(2));
  assert.equal(
    finish(mine.run, mine.token, failure, at(3)).duplicate,
    true,
    "a resposta se perdeu: o mesmo relato é aceito como já aceito",
  );
  assert.equal(state(mine.run), "queued");
  assert.throws(() => finish(mine.run, mine.token, { outcome: "done", summary: "tentativa antiga" }, at(3)), Conflict);
  const again = claim("w1", at(8))!;
  assert.equal(again.run, mine.run);
  assert.notEqual(again.token, mine.token);
  assert.throws(
    () => finish(mine.run, mine.token, { outcome: "done", summary: "tentativa antiga" }, at(9)),
    AuthError,
    "o token de uma tentativa mais antiga já era",
  );
  const success = {
    outcome: "done",
    summary: "pronto",
    notice: [{ title: "Um cartão", text: "enviado uma única vez" }],
  };
  finish(again.run, again.token, success, at(9));
  assert.equal(finish(again.run, again.token, success, at(10)).duplicate, true);
  assert.throws(() => finish(again.run, again.token, { outcome: "done", summary: "mais uma vez" }, at(10)), Conflict);
  assert.equal(told().filter((m) => m.title === "Um cartão").length, 1);
});

test("trabalho que um worker pegou e parou de relatar, continuando presente, é contado uma vez como incerto; um resultado tardio ainda vale", () => {
  clean();
  const unknown = () => told().filter((m) => m.key.startsWith("run:"));
  ingest("ops", alert("probe.public"), at(0));
  const job = claim("w2", at(0))!;
  heartbeat("w2", [job.run], at(3));
  heartbeat("w2", [], at(6));
  sweep(at(6));
  assert.deepEqual(unknown(), []);
  heartbeat("w2", [], at(9));
  sweep(at(9));
  assert.equal(state(job.run), "unknown");
  assert.equal(unknown().length, 1);
  assert.match(unknown()[0].text, /Entregue a beta, já passou de 5 minutos sem notícia; Incerto se terminou ou não/);
  heartbeat("w2", [], at(12));
  sweep(at(12));
  assert.equal(unknown().length, 1);
  ingest("ops", alert("other"), at(13));
  assert.ok(claim("w2", at(13)), "uma rodada incerta não segura mais o grupo dela");
  finish(job.run, job.token, { outcome: "done", summary: "na verdade foi corrigido" }, at(14));
  assert.equal(state(job.run), "done");
  assert.equal(unknown()[0].state, "closed", "o cartão se fecha assim que o resultado chega");
});

test("um worker que sumiu com trabalho na mão mantém o trabalho, é avisado uma vez a cada sumiço, e o cartão se fecha quando ele volta", () => {
  clean();
  heartbeat("w1", [], at(0));
  ingest("app", note(1), at(1));
  const job = claim("w1", at(1))!;
  heartbeat("w1", [job.run], at(2));
  sweep(at(11));
  assert.deepEqual(told(), []);
  sweep(at(13));
  assert.equal(state(job.run), "claimed", "sumir não é perder: ele pode ainda estar trabalhando");
  assert.deepEqual(
    told().map((m) => m.text),
    [
      "w1 está há 11 minutos sem conectar à central; 1 tarefa(s) na fila ou em curso (dê uma olhada naquele computador: se desligou, hibernou ou perdeu a rede).",
    ],
  );
  sweep(at(30));
  assert.equal(told().length, 1);
  heartbeat("w1", [job.run], at(31));
  sweep(at(31));
  assert.equal(told()[0].state, "closed");
  sweep(at(45));
  assert.equal(told().length, 2, "ele sumiu de novo, com trabalho na mão");

  clean();
  ingest("ops", alert("first"), at(0));
  sweep(at(11));
  assert.deepEqual(
    told()
      .map((m) => m.text)
      .sort(),
    [
      "w1 nunca conectou à central; 1 tarefa(s) esperam há 11 minutos sem ninguém (dê uma olhada naquele computador: se está ligado e na rede).",
      "w2 nunca conectou à central; 1 tarefa(s) esperam há 11 minutos sem ninguém (dê uma olhada naquele computador: se está ligado e na rede).",
    ],
  );
});

test("cancelar uma rodada que espera a encerra; cancelar uma em curso segura o assunto dela até o worker dizer que parou", () => {
  clean();
  ingest("ops", alert("a"), at(0));
  const going = claim("w2", at(0))!;
  ingest("ops", alert("b"), at(1));
  const waiting = one<{ id: number }>("SELECT id FROM runs WHERE state = 'queued' AND agent = 'a2'")!.id;
  cancel(waiting, at(2));
  assert.equal(state(waiting), "cancelled");
  assert.deepEqual(cancels("w2"), []);
  cancel(going.run, at(3));
  assert.equal(state(going.run), "claimed");
  assert.deepEqual(cancels("w2"), [going.run]);
  assert.deepEqual(cancels("w1"), []);
  ingest("ops", alert("c"), at(4));
  assert.equal(claim("w2", at(4)), null, "ainda segurando o grupo dele");
  finish(going.run, going.token, { outcome: "cancelled" }, at(5));
  assert.equal(state(going.run), "cancelled");
  assert.deepEqual(cancels("w2"), []);
  assert.ok(claim("w2", at(5)));
});

test("parar uma rodada que não existe, ou que já terminou, é recusado e não muda nada", () => {
  clean();
  assert.throws(() => cancel(9999, at(0)), NotFound);
  ingest("ops", alert("x"), at(0));
  const job = claim("w2", at(0))!;
  finish(job.run, job.token, { outcome: "done", summary: "pronto" }, at(1));
  assert.throws(() => cancel(job.run, at(2)), InputError);
  const row = one<{ state: string; cancel_at: string | null }>("SELECT state, cancel_at FROM runs WHERE id = ?", [
    job.run,
  ])!;
  assert.deepEqual([row.state, row.cancel_at], ["done", null]);
});

test("um relato de início é limitado, e um recusado não muda nada", () => {
  clean();
  ingest("ops", alert("x"), at(0));
  const job = claim("w2", at(0))!;
  const reported = () => {
    const row = one<{ session: string | null; link: string | null }>("SELECT session, link FROM runs WHERE id = ?", [
      job.run,
    ])!;
    return [row.session, row.link];
  };
  for (const bad of [{ session: 42 }, { link: {} }, { session: "s".repeat(501) }, { link: "l".repeat(501) }])
    assert.throws(() => started(job.run, job.token, bad, at(1)), InputError, JSON.stringify(bad));
  assert.deepEqual(reported(), [null, null]);
  // O próprio limite é permitido.
  started(job.run, job.token, { session: "s".repeat(500), link: "l".repeat(500) }, at(1));
  assert.deepEqual(reported(), ["s".repeat(500), "l".repeat(500)]);
});

test("o uso e a sessão de uma rodada são mantidos", () => {
  clean();
  ingest("ops", alert("x"), at(0));
  const job = claim("w2", at(0))!;
  finish(
    job.run,
    job.token,
    { outcome: "done", summary: "pronto", session: "t-1", usage: { input: 100, output: 20, cached: 50, cost: 0.1 } },
    at(1),
  );
  const row = one<{ session: string; usage: string }>("SELECT session, usage FROM runs WHERE id = ?", [job.run])!;
  assert.equal(row.session, "t-1");
  assert.deepEqual(JSON.parse(row.usage), { input: 100, output: 20, cached: 50, cost: 0.1 });
});
