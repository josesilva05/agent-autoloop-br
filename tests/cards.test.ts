// O que chega ao titular. As palavras de um cartão nunca mudam; só o estado dele muda. Casos de falha: perguntar a mesma coisa
// enquanto ela está aberta cria um segundo cartão, ou, fechada, bloqueia perguntar de novo; uma resposta aceita uma opção que
// não existe, carrega mais palavras ou uma referência mais longa do que o protocolo permite, conta duas vezes, ou vence um
// resolve que veio primeiro (só um dos dois pode mudar um cartão aberto); uma resposta de alguém que não está na lista do canal,
// ou sobre uma mensagem que não é a enviada, conta; uma resposta não acorda o assunto que perguntou, acorda outro assunto, se
// perde porque a rodada dela foi mesclada, ou não carrega a sessão, o título de sessão da regra e o que quem perguntou deixou
// para si; o cartão não mostra o que foi feito depois que a rodada dele termina; uma rodada encerra um cartão fora do que lhe foi
// dado para verificar, ou um id inválido estraga o próprio resultado; encerrar não acorda ninguém. Entrega: um canal recebe um
// cartão que ele tem, não recebe um que deveria, perde um relato e envia uma segunda mensagem (a referência fica, e um relato
// antigo não desfaz um mais novo); uma falha antiga atrasa uma versão mais nova; um envio que falhou é tentado de novo na hora,
// ou para sempre; um canal que nunca apareceu conta como tendo falhado; um cartão resolvido antes de ser enviado incomoda o
// titular; dois canais não recebem cada um a própria cópia; uma resposta num canal não atualiza o outro.
// Palavras numa resposta ou num aviso que não são texto quebram em vez de ser recusadas; uma resposta a um cartão cuja regra sumiu
// quebra ou inicia algo; fechar ou relatar uma falha num cartão que não está lá, ou que não foi entregue, quebra.
// O recibo de uma rodada parada tem efeito, ou a resposta que ele carregava aparece como executada. Uma rodada que falhou, mesclada
// com o que chegou nesse meio tempo, perde a sessão da resposta que está nela, ou a tem apagada por uma que não tinha nenhuma. Uma
// rodada com eventos de duas fontes recebe, ou encerra, cartões que não têm fonte. Um canal que pega um cartão e nunca relata o
// recebe para sempre. Um cartão fechado enquanto a primeira mensagem está a caminho nunca tem aquela mensagem atualizada.
// Uma regra que lista os próprios canais tem os cartões dela, e os avisos das rodadas dela, enviados a outros também; uma que não
// lista nenhum para de chegar a todo canal; um aviso de regra nenhuma chega só a alguns. Com defaultChannels, um cartão que não
// nomeia canais próprios (um tell, o alerta da própria central, uma tarefa em outro lugar perguntando, uma regra sem lista) ainda
// chega a todo canal, então vários canais cada um o repetem (issue #221); e uma regra que lista os próprios fica presa ao padrão.
// FYIs de recibo precisam chegar fechados sem botões, ficar fora das listas de abertos seguintes, e nunca acordar trabalho quando
// clicados; avisos comuns, perguntas, regras silenciosas e a janela de entrega de um dia do FYI precisam manter o comportamento atual.
// A linha do tempo do why precisa mostrar FYIs de recibo sem acrescentar encerramentos vazios nem repetir avisos de fim gerados pela central.
// O material de answers carrega o texto escolhido, ou uma opção baseada em 0 é lida como a primeira (issue #197: um Agent relatou
// verde como azul).
import assert from "node:assert/strict";
import { test } from "node:test";
import { at, setup } from "./helpers.ts";
import { render } from "../plugins/feishu/channel.ts";
import { formatWhy } from "../cli/why.ts";

setup("cards");
const { ingest } = await import("./hub.ts");
const { cancel, claimNext, execute, finish, heartbeat, started, sweep, why } = await import("./hub.ts");
const { answer, resolve, nextCard, delivered, failed, tell, cardByToken, getView } = await import("./hub.ts");
const { AuthError, InputError, NotFound } = await import("../kernel/errors.ts");
const { all, one, run } = await import("./storage.ts");

const clean = () => {
  for (const table of ["run_events", "runs", "events", "seen", "cards", "deliveries", "timers"])
    run(`DELETE FROM ${table}`);
};
const note = (n: number, step = "new") => ({ id: `feedback:${n}:${step}`, type: `feedback.${step}`, subject: `#${n}` });
const claim = (worker: string, now: number) => claimNext(worker, `c${Math.random()}`, now);
const question = {
  title: "Apagar a tabela antiga?",
  text: "Ocupa 10 GB.",
  options: ["Apagar", "Manter"],
  recommend: 1,
  about: "A tabela é old_x; faça backup antes de apagar",
  key: "drop-old-x",
};
const card = (id: number) => one<any>("SELECT * FROM cards WHERE id = ?", [id])!;

/** Uma rodada no objeto #n que termina perguntando. */
function asked(n: number, now = at(0)) {
  ingest("app", note(n), now);
  const job = claim("w1", now)!;
  started(job.run, job.token, { session: `s-${n}`, link: `app://s-${n}` }, now);
  finish(
    job.run,
    job.token,
    { outcome: "done", summary: "aguardando sua decisão", session: `s-${n}`, ask: [question] },
    now,
  );
  return { job, id: one<{ id: number }>("SELECT id FROM cards WHERE run_id = ?", [job.run])!.id };
}

/** Faz `then` com as regras mudadas por `change`, e as põe de volta. */
function underRules(change: (rules: any) => void, then: () => void) {
  const before = getView().get("config", "rules")!.value;
  const changed = structuredClone(before);
  change(changed);
  execute("rules", [changed], at(0));
  try {
    then();
  } finally {
    execute("rules", [before], at(0));
  }
}

test("a mesma pergunta não é feita duas vezes enquanto está aberta, e pode ser feita de novo depois de fechada", () => {
  clean();
  const { id } = asked(1);
  ingest("app", note(1, "followup"), at(1));
  let job = claim("w1", at(1))!;
  finish(job.run, job.token, { outcome: "done", ask: [question] }, at(2));
  assert.equal(all("SELECT id FROM cards").length, 1);
  resolve(id, "não precisa mais", "owner", at(3));
  ingest("app", note(1, "decided"), at(4));
  job = claim("w1", at(4))!;
  finish(job.run, job.token, { outcome: "done", ask: [question] }, at(5));
  assert.equal(all("SELECT id FROM cards").length, 2);
  // O escopo da chave é o assunto: outro objeto pergunta por conta própria.
  asked(2, at(6));
  assert.equal(all("SELECT id FROM cards").length, 3);
});

test("uma resposta acorda o assunto que perguntou, na sessão dele, com o que ele deixou para si; o cartão então mostra o que foi feito", () => {
  clean();
  const { id } = asked(1);
  assert.equal(claim("w1", at(1)), null, "perguntar encerrou a rodada; nada roda enquanto ela espera");
  assert.equal(answer(id, { choice: 1, by: "me" }, at(2)).changed, true);
  assert.equal(card(id).state, "decided");
  const job = claim("w1", at(2))!;
  assert.equal(job.rule.name, "opiniões");
  assert.equal(job.rule.title, "note-{id}", "o título de sessão da regra vai ao worker como escrito");
  assert.equal(job.session, "s-1");
  assert.deepEqual(
    job.context.events.map((e) => [e.type, e.subject]),
    [["card.answered", "#1"]],
  );
  assert.deepEqual(
    job.context.answers.map((a) => [a.card, a.title, a.options[a.choice!], a.about, a.by]),
    [[id, "Apagar a tabela antiga?", "Manter", "A tabela é old_x; faça backup antes de apagar", "me"]],
  );
  const before = card(id).version;
  finish(job.run, job.token, { outcome: "done", summary: "mantida, registrado" }, at(3));
  assert.deepEqual([card(id).state, card(id).result], ["done", "mantida, registrado"]);
  assert.equal(card(id).version, before + 1);
});

test("o material de answers carrega o texto escolhido para que a opção baseada em 0 não possa ser lida como a primeira", () => {
  clean();
  const { id } = asked(1);
  answer(id, { choice: 1, by: "me" }, at(1));
  const job = claim("w1", at(1))!;
  assert.deepEqual([job.context.answers[0].choice, job.context.answers[0].chosen], [1, "Manter"]);
  // Uma resposta em texto livre não tem opção: o texto escolhido é a própria resposta.
  finish(job.run, job.token, { outcome: "done", ask: [question] }, at(2));
  const second = one<{ id: number }>("SELECT id FROM cards WHERE id != ?", [id])!.id;
  answer(second, { text: "faça backup antes de apagar", by: "me" }, at(3));
  const free = claim("w1", at(3))!;
  assert.deepEqual(
    [free.context.answers[0].choice, free.context.answers[0].chosen],
    [null, "faça backup antes de apagar"],
  );
});

test("uma resposta enquanto outra rodada segura o assunto entra na próxima rodada, e uma rodada mesclada ainda a carrega", () => {
  clean();
  const { id } = asked(1);
  ingest("app", note(1, "followup"), at(1));
  const going = claim("w1", at(1))!;
  answer(id, { choice: 0, by: "me" }, at(2));
  assert.equal(claim("w1", at(2)), null, "uma rodada por vez num assunto");
  ingest("app", note(1, "decided"), at(3));
  finish(going.run, going.token, { outcome: "done", summary: "complemento verificado" }, at(4));
  const next = claim("w1", at(4))!;
  assert.deepEqual(
    next.context.events.map((e) => e.type),
    ["card.answered", "feedback.decided"],
  );
  assert.equal(next.context.answers[0].card, id);
  assert.equal(next.session, "s-1");
});

test("uma rodada que falhou e carregava uma resposta a mantém para a nova tentativa; o cartão fica decidido até ser executada", () => {
  clean();
  const { id } = asked(1);
  answer(id, { choice: 0, by: "me" }, at(1));
  let job = claim("w1", at(1))!;
  finish(job.run, job.token, { outcome: "failed", error: "sem rede" }, at(2));
  assert.equal(card(id).state, "decided");
  job = claim("w1", at(8))!;
  assert.equal(job.context.answers[0].card, id);
  finish(job.run, job.token, { outcome: "nothing", summary: "alguém já apagou" }, at(9));
  assert.deepEqual([card(id).state, card(id).result], ["done", "alguém já apagou"]);
});

test("uma rodada que falhou, mesclada com o que chegou nesse meio tempo, segue na sessão de quem perguntou, seja qual delas a carregou", () => {
  clean();
  // A resposta chega enquanto outra rodada segura o assunto, então ela espera sozinha até aquela rodada falhar.
  const first = asked(1);
  ingest("app", note(1, "followup"), at(1));
  const going = claim("w1", at(1))!;
  answer(first.id, { choice: 0, by: "me" }, at(2));
  finish(going.run, going.token, { outcome: "failed", error: "sem rede" }, at(3));
  const merged = claim("w1", at(8))!;
  assert.equal(merged.run, going.run);
  assert.equal(merged.session, "s-1");
  assert.deepEqual(
    merged.context.events.map((e) => e.type),
    ["feedback.followup", "card.answered"],
  );
  // Ao contrário: a rodada em curso é a que tem a sessão, e a que espera não tem nenhuma para apagá-la.
  const second = asked(2, at(10));
  answer(second.id, { choice: 0, by: "me" }, at(11));
  const answering = claim("w1", at(11))!;
  assert.equal(answering.session, "s-2");
  ingest("app", note(2, "followup"), at(12));
  finish(answering.run, answering.token, { outcome: "failed", error: "sem rede" }, at(13));
  const retried = claim("w1", at(18))!;
  assert.equal(retried.run, answering.run);
  assert.equal(retried.session, "s-2");
  assert.deepEqual(
    retried.context.events.map((e) => e.type),
    ["card.answered", "feedback.followup"],
  );
});

test("o recibo de uma rodada parada não tem efeito, e a resposta que ele carregava não aparece como executada", () => {
  clean();
  const { id } = asked(1);
  const other = asked(2).id;
  answer(id, { choice: 0, by: "me" }, at(1));
  const job = claim("w1", at(1))!;
  cancel(job.run, at(2));
  finish(
    job.run,
    job.token,
    {
      outcome: "cancelled",
      summary: "Interrompida",
      ask: [{ title: "Ainda preciso perguntar", text: "x", options: ["a", "b"] }],
      notice: [{ title: "Ainda preciso avisar", text: "x" }],
      resolve: [{ card: other, reason: "aproveitei e encerrei" }],
      later: [{ key: "k", at: new Date(at(60)).toISOString(), about: "verificar de novo" }],
    },
    at(3),
  );
  assert.equal(one<{ state: string }>("SELECT state FROM runs WHERE id = ?", [job.run])!.state, "cancelled");
  assert.deepEqual([card(id).state, card(id).result], ["decided", null]);
  assert.equal(card(other).state, "open");
  assert.equal(all("SELECT id FROM cards").length, 2);
  assert.deepEqual(all("SELECT id FROM timers"), []);
});

test("uma resposta a um cartão cuja regra sumiu ainda conta, e não acorda ninguém", () => {
  clean();
  const { id } = asked(1);
  underRules(
    (rules) => {
      rules.rules = rules.rules.filter((rule: { name: string }) => rule.name !== "opiniões");
    },
    () => {
      assert.deepEqual(answer(id, { choice: 1, by: "me" }, at(1)), { changed: true, state: "decided" });
      assert.equal(card(id).choice, 1);
      const event = one<{ routed: string }>("SELECT routed FROM events WHERE type = 'card.answered'")!;
      assert.deepEqual(JSON.parse(event.routed), []);
      assert.deepEqual(all("SELECT id FROM runs WHERE state = 'queued'"), []);
    },
  );
});

test("uma rodada com eventos de duas fontes não tem nada para verificar: um cartão sem fonte não é um dos dela", () => {
  clean();
  const { id } = asked(1);
  // Um worker parou de mencionar uma rodada em #2: o cartão da própria central sobre isso tem o grupo, mas nenhuma fonte.
  ingest("app", note(2), at(0));
  const quiet = claim("w1", at(0))!;
  heartbeat("w1", [], at(6));
  sweep(at(6));
  const hubs = one<{ id: number }>("SELECT id FROM cards WHERE key = ?", [`run:${quiet.run}:unknown`])!.id;
  underRules(
    (rules) => {
      rules.rules[0].when = { source: "ops", types: ["feedback.*"] };
    },
    () => {
      // #1 recebe um evento da fonte nova, e a resposta ao que ele perguntou sob a antiga entra junto.
      ingest("ops", { id: "moved", type: "feedback.new", subject: "#1" }, at(7));
      answer(id, { choice: 0, by: "me" }, at(7));
      const job = claim("w1", at(8))!;
      assert.deepEqual(
        job.context.events.map((e) => e.source),
        ["ops", "app"],
      );
      assert.deepEqual(job.context.open, []);
      const receipt = finish(
        job.run,
        job.token,
        { outcome: "done", resolve: [{ card: hubs, reason: "verificado" }] },
        at(9),
      );
      assert.deepEqual(
        receipt.rejected.map((r) => r.card),
        [hubs],
      );
      assert.equal(card(hubs).state, "open");
    },
  );
});

test("uma resposta conta uma vez; uma opção precisa existir; só um entre responder e encerrar muda um cartão aberto", () => {
  clean();
  const { id } = asked(1);
  assert.throws(() => answer(id, { choice: 2, by: "me" }, at(1)), InputError);
  assert.throws(() => answer(id, { by: "me" }, at(1)), InputError);
  assert.throws(() => answer(9999, { choice: 0, by: "me" }, at(1)), NotFound);
  assert.equal(answer(id, { choice: 0, by: "me" }, at(1)).changed, true);
  assert.equal(answer(id, { choice: 1, by: "me" }, at(2)).changed, false);
  assert.equal(card(id).choice, 0);
  assert.equal(all("SELECT id FROM events WHERE type = 'card.answered'").length, 1);
  assert.equal(resolve(id, "tarde demais", "owner", at(3)), false, "já decidido");
  assert.equal(card(id).state, "decided");

  const other = asked(2, at(4)).id;
  assert.equal(resolve(other, "o problema se resolveu sozinho", "owner", at(5)), true);
  assert.equal(
    answer(other, { choice: 0, by: "me" }, at(6)).changed,
    false,
    "encerrado primeiro: a resposta tardia não inicia nada",
  );
  assert.equal(all("SELECT id FROM events WHERE type = 'card.answered'").length, 1);
});

test("uma resposta em texto livre conta como resposta", () => {
  clean();
  const { id } = asked(1);
  assert.throws(() => answer(id, { text: " ", by: "me" }, at(1)), InputError);
  answer(id, { text: "nenhuma das opções; mude para arquivar", by: "me" }, at(1));
  const job = claim("w1", at(1))!;
  assert.deepEqual(
    [job.context.answers[0].choice, job.context.answers[0].text],
    [null, "nenhuma das opções; mude para arquivar"],
  );
});

test("uma resposta é limitada pelo protocolo, e uma recusada não muda nada", () => {
  clean();
  const words = (n: number) => "x".repeat(n);
  const first = asked(1);
  const before = getView().seq;
  assert.throws(() => answer(first.id, { text: words(4001), by: "me" }, at(1)), InputError);
  assert.throws(() => answer(first.id, { text: "ok", by: "N".repeat(501) }, at(1)), InputError);
  assert.throws(() => answer(first.id, { text: "ok", by: 42 } as any, at(1)), InputError);
  assert.throws(() => answer(first.id, { text: "ok", ref: "r".repeat(501) }, at(1)), InputError);
  assert.throws(() => answer(first.id, { text: "ok", ref: 42 } as any, at(1)), InputError);
  assert.throws(() => answer(first.id, { text: 42 } as any, at(1)), InputError);
  assert.equal(getView().seq, before, "uma resposta recusada não grava nenhum fato");
  assert.equal(card(first.id).state, "open", "uma resposta recusada deixa o cartão aberto");
  // O próprio limite é permitido.
  assert.equal(answer(first.id, { text: words(4000), by: "N".repeat(500), ref: "r".repeat(500) }, at(1)).changed, true);
  // O id de mensagem do próprio canal tem o mesmo limite.
  const second = asked(2);
  const version = card(second.id).version;
  const beforeDelivery = getView().seq;
  assert.throws(() => delivered("chat", second.id, version, "r".repeat(501), at(2)), InputError);
  assert.throws(() => delivered("chat", second.id, version, 42 as any, at(2)), InputError);
  assert.equal(getView().seq, beforeDelivery, "um relato recusado não grava nenhum fato");
  delivered("chat", second.id, version, "r".repeat(500), at(2));
  assert.ok(getView().seq > beforeDelivery);
});

test("a resposta de um canal precisa vir de alguém da lista dele, sobre a mensagem que ele enviou", () => {
  clean();
  const { id } = asked(1);
  const given = nextCard("chat", at(1))!;
  delivered("chat", id, given.version, "om_1", at(1));
  assert.throws(() => answer(id, { choice: 0, by: "someone-else", channel: "chat", ref: "om_1" }, at(2)), AuthError);
  assert.throws(() => answer(id, { choice: 0, by: "me", channel: "chat", ref: "om_forwarded" }, at(2)), AuthError);
  assert.equal(card(id).state, "open");
  assert.equal(answer(id, { choice: 0, by: "me", channel: "chat", ref: "om_1" }, at(2)).changed, true);
});

test("uma rodada só pode encerrar o que lhe foi dado para verificar, e um id inválido não estraga o próprio resultado", () => {
  clean();
  const mine = asked(1).id;
  const elsewhere = (() => {
    // Mesma fonte, outro grupo.
    ingest("ops", { id: "a", type: "alert.raised", subject: "x" }, at(0));
    const w2 = claim("w2", at(0))!;
    const w1 = claim("w1", at(0))!;
    finish(w1.run, w1.token, { outcome: "nothing" }, at(0));
    finish(w2.run, w2.token, { outcome: "done", notice: [{ title: "Outro grupo", text: "x" }] }, at(0));
    return one<{ id: number }>("SELECT id FROM cards WHERE title = 'Outro grupo'")!.id;
  })();
  ingest("app", note(2), at(1));
  const job = claim("w1", at(2))!;
  assert.deepEqual(
    job.context.open.map((c) => c.card),
    [mine],
  );
  const receipt = finish(
    job.run,
    job.token,
    {
      outcome: "done",
      summary: "pronto",
      resolve: [
        { card: mine, reason: "o site original voltou" },
        { card: elsewhere, reason: "fora dos limites" },
        { card: 9999, reason: "cartão inexistente" },
      ],
    },
    at(3),
  );
  assert.deepEqual(
    receipt.rejected.map((r) => r.card),
    [elsewhere, 9999],
  );
  assert.deepEqual(
    receipt.rejected.map((r) => r.reason),
    ["fora do escopo de verificação desta rodada", "fora do escopo de verificação desta rodada"],
  );
  assert.equal(one<{ state: string }>("SELECT state FROM runs WHERE id = ?", [job.run])!.state, "done");
  assert.deepEqual([card(mine).state, card(mine).result], ["closed", "o site original voltou"]);
  assert.equal(card(elsewhere).state, "open");
  assert.equal(all("SELECT id FROM events WHERE type = 'card.answered'").length, 0, "encerrar não acorda ninguém");
});

test("um cartão criado depois de esta rodada ter sido reclamada não está no escopo dela", () => {
  clean();
  ingest("app", note(1), at(0));
  const job = claim("w1", at(0))!;
  ingest("app", note(2), at(1));
  const other = claim("w1", at(1))!;
  finish(other.run, other.token, { outcome: "done", notice: [{ title: "Criado depois", text: "x" }] }, at(2));
  const later = one<{ id: number }>("SELECT id FROM cards")!.id;
  const receipt = finish(
    job.run,
    job.token,
    { outcome: "done", resolve: [{ card: later, reason: "verificado" }] },
    at(3),
  );
  assert.deepEqual(
    receipt.rejected.map((r) => r.card),
    [later],
  );
});

test("cada canal recebe cada cartão uma vez, e uma atualização quando o estado muda; um relato perdido não envia uma segunda mensagem", () => {
  clean();
  const { id } = asked(1);
  const first = nextCard("chat", at(1))!;
  assert.deepEqual(
    [first.id, first.version, first.ref, first.kind, first.state, first.options, first.recommend],
    [id, 1, null, "ask", "open", ["Apagar", "Manter"], 1],
  );
  assert.equal(nextCard("chat", at(1)), null, "fora com o canal por um minuto");
  // O relato se perdeu: ele volta de novo sob a mesma identidade de mensagem.
  const again = nextCard("chat", at(3))!;
  assert.equal(again.id, id);
  delivered("chat", id, 1, "om_1", at(3));
  assert.equal(nextCard("chat", at(10)), null);
  const plain = nextCard("plain", at(10))!;
  assert.equal(plain.id, id, "o outro canal tem a própria cópia");
  delivered("plain", id, 1, "p_1", at(10));
  answer(id, { choice: 1, by: "me", channel: "chat", ref: "om_1" }, at(11));
  const update = nextCard("chat", at(11))!;
  assert.deepEqual([update.version, update.ref, update.state, update.choice], [2, "om_1", "decided", 1]);
  assert.equal(nextCard("plain", at(11))!.ref, "p_1", "e o outro canal também fica sabendo");
  // Um relato tardio da versão mais antiga não muda nada.
  delivered("chat", id, 2, "om_1", at(12));
  delivered("chat", id, 1, "om_other", at(13));
  const row = one<{ version: number; ref: string }>(
    "SELECT version, ref FROM deliveries WHERE card_id = ? AND channel = 'chat'",
    [id],
  )!;
  assert.deepEqual([row.version, row.ref], [2, "om_1"]);
});

test("uma regra que lista canais tem os cartões enviados só para lá; uma que não lista nenhum, ou um aviso de regra nenhuma, vai para todos", () => {
  clean();
  underRules(
    (rules) => {
      rules.rules.find((rule: { name: string }) => rule.name === "opiniões").channels = ["plain"];
    },
    () => {
      const { id } = asked(1);
      assert.equal(nextCard("chat", at(1)), null, "chat não está na lista da regra");
      assert.equal(nextCard("plain", at(1))?.id, id);
      tell("hub:test", "central", "todos devem saber", at(2));
      assert.ok(nextCard("chat", at(2)), "um aviso de regra nenhuma ainda chega a todo canal");
    },
  );
  clean();
  const { id } = asked(2);
  assert.equal(nextCard("chat", at(1))?.id, id, "sem lista, todo canal recebe");
  assert.equal(nextCard("plain", at(1))?.id, id);
});

test("defaultChannels fica com todo cartão que não nomeia canais próprios; a lista da regra ainda vence", () => {
  clean();
  underRules(
    (rules) => {
      rules.defaultChannels = ["plain"];
      rules.rules.find((rule: { name: string }) => rule.name === "opiniões").channels = ["chat"];
    },
    () => {
      const told = tell("source:app:k", "aplicativo", "dito uma única vez", at(1)).card;
      assert.equal(nextCard("chat", at(1)), null, "um tell não é repetido no chat");
      assert.equal(nextCard("plain", at(1))?.id, told);
      delivered("plain", told, 1, "p_1", at(1));
      const { id } = asked(1);
      assert.equal(nextCard("chat", at(2))?.id, id, "a lista da própria regra, não o padrão");
      assert.equal(nextCard("plain", at(2)), null);
    },
  );
  clean();
  underRules(
    (rules) => {
      rules.defaultChannels = ["plain"];
    },
    () => {
      const { id } = asked(2);
      assert.equal(nextCard("chat", at(1)), null, "uma regra sem lista vai para onde o padrão diz");
      assert.equal(nextCard("plain", at(1))?.id, id);
    },
  );
});

test("um envio que falha é tentado de novo com intervalos cada vez maiores, e então desistido dentro da hora; um canal que nunca apareceu não falhou", () => {
  clean();
  const id = tell("source:app:k", "aplicativo", "o relatório semanal chegou", at(0)).card;
  const tries = [0, 1, 3, 7, 15, 25, 35, 45, 55];
  for (const minute of tries) {
    const given = nextCard("chat", at(minute));
    assert.equal(given?.id, id, `tentativa em ${minute}`);
    assert.equal(nextCard("chat", at(minute)), null);
    failed("chat", id, given!.version, "o Feishu caiu", at(minute));
  }
  assert.equal(nextCard("chat", at(56)), null);
  assert.equal(nextCard("chat", at(500)), null, "desistiu");
  assert.equal(one<{ given_up: number }>("SELECT given_up FROM deliveries WHERE channel = 'chat'")!.given_up, 1);
  // Passada uma hora um canal não pode mais descartar uma repetição, então ele para; o canal que não apareceu ainda o recebe.
  assert.equal(nextCard("plain", at(500))?.id, id);
  // Uma falha de uma versão mais antiga não segura a mais nova.
  clean();
  const { id: asking } = asked(1, at(0));
  const v1 = nextCard("chat", at(0))!;
  delivered("chat", asking, v1.version, "om_1", at(0));
  answer(asking, { choice: 0, by: "me", channel: "chat", ref: "om_1" }, at(1));
  const v2 = nextCard("chat", at(1))!;
  failed("chat", asking, 1, "falha antiga", at(1));
  assert.ok(nextCard("chat", at(1)), "uma falha antiga não atrasa a atualização");
  assert.equal(v2.version, 2);
});

test("um canal que pega um cartão e nunca relata para de o receber: depois da última tentativa, ou passada uma hora", () => {
  clean();
  const id = tell("source:app:k", "aplicativo", "relatório semanal", at(0)).card;
  for (const minute of [0, 1, 2, 3, 4, 5, 6, 7, 8])
    assert.equal(nextCard("chat", at(minute))?.id, id, `tentativa em ${minute}`);
  assert.equal(nextCard("chat", at(9)), null, "aquela foi a última tentativa");
  const givenUp = (channel: string) =>
    one<{ given_up: number }>("SELECT given_up FROM deliveries WHERE channel = ?", [channel])?.given_up;
  assert.equal(givenUp("chat"), 1);
  assert.equal(nextCard("chat", at(30)), null);

  clean();
  const { id: asking } = asked(1, at(60));
  assert.equal(nextCard("chat", at(60))?.id, asking);
  assert.equal(nextCard("chat", at(60 + 58)), null, "tarde demais para um canal descartar uma repetição");
  assert.equal(givenUp("chat"), 1);
  assert.equal(nextCard("plain", at(60 + 58))?.id, asking, "o canal que não apareceu ainda o recebe");
});

test("fechar um cartão que não está lá, ou relatar uma falha num que o canal não tem, é recusado", () => {
  clean();
  const { id } = asked(1);
  assert.throws(() => resolve(9999, "cartão inexistente", "owner", at(1)), NotFound);
  assert.throws(() => failed("chat", 9999, 1, "caiu", at(1)), NotFound);
  assert.throws(() => failed("chat", id, 1, "caiu", at(1)), NotFound, "ele nunca foi entregue a este canal");
  assert.deepEqual(all("SELECT card_id FROM deliveries"), []);
});

test("um cartão fechado enquanto a primeira mensagem está a caminho ainda tem aquela mensagem atualizada", () => {
  clean();
  const { id } = asked(1);
  const out = nextCard("chat", at(1))!;
  resolve(id, "o problema se resolveu sozinho", "owner", at(2));
  delivered("chat", id, out.version, "om_1", at(3));
  const update = nextCard("chat", at(3))!;
  assert.deepEqual([update.id, update.state, update.ref, update.version], [id, "closed", "om_1", 2]);
  delivered("chat", id, update.version, "om_1", at(3));
  assert.equal(nextCard("chat", at(4)), null);
});

test("a nota de tratamento de um aviso precisa ser texto, e uma que não é não muda nada", () => {
  clean();
  ingest("app", note(1), at(0));
  const job = claim("w1", at(0))!;
  finish(
    job.run,
    job.token,
    { outcome: "done", notice: [{ title: "Preciso de uma ação sua", text: "liberar permissão" }] },
    at(0),
  );
  const { id } = one<{ id: number }>("SELECT id FROM cards")!;
  assert.throws(() => answer(id, { text: 42 } as any, at(1)), InputError);
  assert.equal(card(id).state, "open");
});

test("um cartão resolvido antes de ser enviado não incomoda o titular; um fechado já enviado é atualizado", () => {
  clean();
  const { id } = asked(1);
  resolve(id, "o problema se resolveu sozinho", "owner", at(1));
  assert.equal(nextCard("chat", at(2)), null);
  const sent = asked(2, at(3)).id;
  const v1 = nextCard("chat", at(3))!;
  delivered("chat", sent, v1.version, "om_2", at(3));
  resolve(sent, "o problema se resolveu sozinho", "owner", at(4));
  const update = nextCard("chat", at(4))!;
  assert.deepEqual(
    [update.id, update.state, update.ref, update.options, update.result],
    [sent, "closed", "om_2", ["Apagar", "Manter"], "o problema se resolveu sozinho"],
  );
});

test("um aviso tem um botão que o fecha; algo só para saber não tem nenhum e não fica aberto", () => {
  clean();
  ingest("app", note(1), at(0));
  const job = claim("w1", at(0))!;
  finish(
    job.run,
    job.token,
    { outcome: "done", notice: [{ title: "Preciso de uma ação sua", text: "liberar permissão" }] },
    at(0),
  );
  const id = one<{ id: number }>("SELECT id FROM cards")!.id;
  const shown = nextCard("chat", at(0))!;
  assert.deepEqual([shown.kind, shown.options], ["notice", ["Resolvido"]]);
  delivered("chat", id, shown.version, "om_1", at(0));
  assert.equal(answer(id, { choice: 0, by: "me", channel: "chat", ref: "om_1" }, at(1)).changed, true);
  assert.equal(card(id).state, "closed");
  assert.equal(all("SELECT id FROM events WHERE type = 'card.answered'").length, 0, "nada para acordar");
  const closed = nextCard("chat", at(1))!;
  assert.deepEqual([closed.id, closed.state, closed.options], [id, "closed", []], "a mensagem dele perde o botão");
  delivered("chat", id, closed.version, "om_1", at(1));
  const fyi = tell("source:app:k2", "aplicativo", "apenas para você saber", at(2)).card;
  const given = nextCard("chat", at(2))!;
  assert.deepEqual([given.id, given.state, given.options], [fyi, "closed", []]);
});

test("um cartão fechado ao ser criado diz quando, senão o que quer que leia o estado o toma por ainda esperando", () => {
  clean();
  tell("source:app:k3", "aplicativo", "apenas para você saber", at(1));
  ingest("app", note(1), at(2));
  const job = claim("w1", at(2))!;
  finish(
    job.run,
    job.token,
    { outcome: "done", notice: [{ title: "Configurado", text: "todos os dias às nove", fyi: true }] },
    at(3),
  );
  const [told, receipt] = [nextCard("chat", at(3))!, nextCard("chat", at(3))!];
  assert.deepEqual([told.state, told.closedAt], ["closed", new Date(at(1)).toISOString()]);
  assert.deepEqual([receipt.state, receipt.closedAt], ["closed", new Date(at(3)).toISOString()]);
});

test("FYIs de recibo chegam como cartões cinzas fechados; avisos comuns e perguntas ainda precisam de tratamento", () => {
  clean();
  ingest("app", note(1), at(0));
  const job = claim("w1", at(0))!;
  finish(
    job.run,
    job.token,
    {
      outcome: "done",
      ask: [question],
      notice: [
        { title: "Configurado", text: "verificação todos os dias às nove", fyi: true },
        { title: "Permissão a liberar", text: "Libere a permissão, por favor" },
        { title: "Alerta a verificar", text: "Verifique os logs, por favor", fyi: false },
      ],
    },
    at(1),
  );
  const shown = Array.from({ length: 4 }, () => nextCard("chat", at(1))!);
  assert.deepEqual(
    shown.map((c) => [c.title, c.state, c.options]),
    [
      [question.title, "open", question.options],
      ["Configurado", "closed", []],
      ["Permissão a liberar", "open", ["Resolvido"]],
      ["Alerta a verificar", "open", ["Resolvido"]],
    ],
  );
  for (const c of shown) delivered("chat", c.id, c.version, `om_${c.id}`, at(1));
  const fyi = shown[1];
  const grey = render(fyi);
  assert.equal(grey.header.template, "grey");
  assert.doesNotMatch(JSON.stringify(grey), /callback|Resolvido/);
  for (const c of [shown[0], shown[2], shown[3]]) {
    assert.equal(render(c).header.template, "blue");
    assert.match(JSON.stringify(render(c)), /callback/);
  }
  assert.deepEqual(answer(fyi.id, { choice: 0, by: "me", channel: "chat", ref: `om_${fyi.id}` }, at(2)), {
    changed: false,
    state: "closed",
  });
  assert.equal(claim("w1", at(2)), null, "um FYI fechado não pode acordar outra rodada");
  ingest("app", note(1, "followup"), at(3));
  const next = claim("w1", at(3))!;
  assert.deepEqual(
    next.context.events.map((e) => e.type),
    ["feedback.followup"],
  );
  assert.deepEqual(next.context.answers, []);
  assert.deepEqual(
    next.context.open.map((c) => c.title),
    [question.title, "Permissão a liberar", "Alerta a verificar"],
  );
  finish(
    next.run,
    next.token,
    {
      outcome: "done",
      resolve: [{ card: shown[2].id, reason: "permissão liberada" }],
    },
    at(4),
  );
  const resolved = nextCard("chat", at(4))!;
  assert.deepEqual([resolved.id, resolved.state, resolved.options], [shown[2].id, "closed", []]);
  assert.equal(answer(shown[3].id, { choice: 0, by: "me" }, at(4)).changed, true);
  assert.equal(answer(shown[0].id, { choice: 1, by: "me" }, at(5)).changed, true);
  assert.deepEqual(
    claim("w1", at(5))!.context.events.map((e) => e.type),
    ["card.answered"],
  );
});

test("uma rodada que continua falhando diz o FYI dela uma vez, e a terceira falha seguida ainda é contada", () => {
  clean();
  ingest("app", note(1), at(0));
  for (let attempt = 0; attempt < 3; attempt++) {
    const job = claim("w1", at(attempt * 120))!;
    finish(
      job.run,
      job.token,
      {
        outcome: "failed",
        error: "boom",
        notice: [{ title: "Já tentei", text: "ainda tentando", key: "retry", fyi: true }],
      },
      at(attempt * 120 + 1),
    );
  }
  const cards = all<{ key: string; state: string }>("SELECT key, state FROM cards ORDER BY id");
  assert.equal(cards.filter((card) => card.key.endsWith(":retry")).length, 1);
  assert.equal(cards.filter((card) => card.key.endsWith(":failing") && card.state === "open").length, 1);
});

test("why mostra os FYIs de recibo mantendo ocultos os avisos de fim da central e os encerramentos vazios", () => {
  clean();
  ingest("ops", { id: "why-fyi", type: "alert.raised", subject: "probe" }, at(0));
  const job = claim("w2", at(0))!;
  finish(
    job.run,
    job.token,
    {
      outcome: "done",
      summary: "verificação desta rodada concluída",
      notice: [
        { title: "resultado apenas informativo", text: "verificação concluída", fyi: true },
        { title: "resultado que ainda exige tratamento", text: "verifique os logs" },
      ],
    },
    at(1),
  );
  const output = formatWhy(job.run, why(job.run));
  assert.match(output, /Notificação: resultado apenas informativo/);
  assert.match(output, /verificação concluída/);
  assert.match(output, /Notificação: resultado que ainda exige tratamento/);
  assert.match(output, /Fim: verificação desta rodada concluída/);
  assert.doesNotMatch(output, /Notificação: alerta|Encerrado: resultado apenas informativo/);
  assert.equal(output.split("verificação desta rodada concluída").length - 1, 1);
});

test("um FYI de recibo fica entregável por um dia mesmo começando fechado", () => {
  clean();
  ingest("app", note(1), at(0));
  const job = claim("w1", at(0))!;
  finish(
    job.run,
    job.token,
    {
      outcome: "done",
      notice: [{ title: "No ar", text: "já pode ser usado", fyi: true }],
    },
    at(0),
  );
  assert.equal(nextCard("chat", at(24 * 60))?.state, "closed");
  assert.equal(nextCard("plain", at(24 * 60 + 1)), null);
});

for (const fyi of [undefined, false, true]) {
  test(`tell nunca mantém avisos de recibo silenciosos com fyi=${fyi}, enquanto perguntas ainda chegam`, () => {
    clean();
    ingest("ops", { id: "alert", type: "alert.raised", subject: "probe" }, at(0));
    const job = claim("w1", at(0))!;
    finish(
      job.run,
      job.token,
      {
        outcome: "done",
        ask: [question],
        notice: [{ title: "registrado", text: "fica para o registro", ...(fyi !== undefined && { fyi }) }],
      },
      at(0),
    );
    const shown = nextCard("chat", at(1))!;
    assert.deepEqual([shown.kind, shown.state, shown.options], ["ask", "open", question.options]);
    delivered("chat", shown.id, shown.version, "om_ask", at(1));
    assert.equal(nextCard("chat", at(2)), null, "avisos silenciosos nunca chegam ao canal");
  });
}

test("o que só precisava ser dito é dito uma vez por chave; desistido, pode ser dito de novo", () => {
  clean();
  const first = tell("source:app:k", "aplicativo", "relatório semanal", at(0));
  assert.equal(first.duplicate, false);
  assert.equal(tell("source:app:k", "aplicativo", "relatório semanal", at(1)).duplicate, true);
  for (const minute of [0, 1, 3, 7, 15, 25, 35, 45, 55])
    failed("chat", first.card, nextCard("chat", at(minute))!.version, "caiu", at(minute));
  assert.equal(nextCard("chat", at(60)), null);
  const again = tell("source:app:k", "aplicativo", "relatório semanal (atualizado)", at(70));
  assert.deepEqual(
    [again.card, again.duplicate],
    [first.card, false],
    "dito de novo, ele sai na hora com as palavras novas",
  );
  assert.equal(nextCard("chat", at(70))?.text, "relatório semanal (atualizado)");
  assert.equal(nextCard("plain", at(70))?.text, "relatório semanal (atualizado)");
});

test("o que só precisava ser dito envelhece: um canal que volta depois de um dia não recebe o de ontem", () => {
  clean();
  tell("source:app:k", "aplicativo", "assunto de ontem", at(0));
  assert.equal(nextCard("chat", at(25 * 60)), null);
  const { id } = asked(1, at(25 * 60));
  assert.equal(nextCard("chat", at(25 * 60))?.id, id, "o que ainda precisa de resposta recebe");
});

test("o link de um cartão vai só a um canal que o permite, e abre só aquele cartão", () => {
  clean();
  const { id } = asked(1);
  const link = nextCard("plain", at(1))!.link!;
  assert.match(link, /^https:\/\/hub\.test\/c\/[\w-]+$/);
  assert.equal(nextCard("chat", at(1))!.link, null, "um canal com botões não tem uso para um link que responde");
  assert.equal(cardByToken(new URL(link).pathname.slice("/c/".length))!.id, id);
  assert.equal(cardByToken("made-up"), undefined);
});
