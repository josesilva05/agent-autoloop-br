// Uma tarefa agendada em outro lugar (digamos, no aplicativo do Claude) que pergunta algo a você. Casos de falha: a pergunta
// chega sem opções, então não há nada para tocar; a mesma pergunta ainda aberta é feita de novo; a sua resposta é só anotada e
// nada continua a partir dela; o que continua roda num Agent, numa pasta ou com as palavras que a requisição da tarefa escolheu
// em vez do rules.json; vai para o Agent de outro worker; recarregar as regras a descarta antes de ela começar; o cartão fica
// aberto depois da rodada que o executou; uma tarefa que nunca disse onde continua pode perguntar, então a resposta não tem para
// onde ir; um worker pergunta como uma tarefa que não é dele; uma fonte pergunta; uma pergunta sem duas opções, ou enviada junto
// com uma mensagem simples, entra.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { at, setup } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-elsewhere-ask-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const rulesFile = join(dir, "rules.json");
const weekly = {
  name: "limpeza semanal",
  source: "app",
  to: "a1",
  cron: "0 6 * * 0",
  where: "tarefa agendada no aplicativo",
  cwd: "~/code/app",
  skill: "weekly-sweep",
  prompt: 'Siga a seção "ele respondeu" do manual.',
};
const rulesWith = (where: string) => ({
  sources: { app: { name: "aplicativo" } },
  agents: {
    a1: { name: "alfa", worker: "w1", use: "claude" },
    a2: { name: "beta", worker: "w2", use: "codex" },
  },
  channels: { chat: { name: "chat", answerers: ["me"] } },
  rules: [],
  elsewhere: [
    { ...weekly, where },
    { name: "relatório diário", source: "app", to: "a1", cron: "0 9 * * *", where: "tarefa agendada no aplicativo" },
  ],
});
writeFileSync(rulesFile, JSON.stringify(rulesWith("tarefa agendada no aplicativo")));
setup("elsewhere-ask", rulesFile);

const { serve } = await import("../host/http.ts");
const hub = await import("./hub.ts");
const { addKey, answer, claimNext, delivered, finish, nextCard, reloadRules } = hub;
const { one } = await import("./storage.ts");

const question = {
  title: "Fazer o merge do PR #12?",
  text: "Ele acrescenta um comando novo, sem impacto para os usuários.",
  options: ["Fazer merge", "Fechar explicando o motivo"],
  recommend: 0,
  about: "Se escolher merge, integre ao main; se escolher fechar, responda o motivo e feche.",
};

test("a pergunta vem com opções, e a sua resposta continua onde o rules.json diz, no Agent da própria tarefa", () => {
  const asked = hub.ask("limpeza semanal", { ...question, key: "pr-12" }, at(0));
  assert.equal(asked.duplicate, false);
  const again = hub.ask("limpeza semanal", { ...question, key: "pr-12" }, at(1));
  assert.deepEqual(again, { card: asked.card, duplicate: true }, "ainda aberta: não perguntada duas vezes");

  const card = nextCard("chat", at(1))!;
  assert.equal(card.id, asked.card);
  assert.deepEqual([card.kind, card.state, card.options, card.recommend], ["ask", "open", question.options, 0]);
  delivered("chat", card.id, card.version, "om_1", at(1));
  answer(card.id, { choice: 1, by: "me", channel: "chat", ref: "om_1" }, at(2));

  assert.equal(claimNext("w2", "c0", at(3)), null, "não é o Agent do outro worker");
  // Regras lidas de novo antes de alguém pegá-la: a rodada continua lá.
  writeFileSync(rulesFile, JSON.stringify(rulesWith("tarefa agendada no aplicativo (descrição alterada)")));
  assert.deepEqual(reloadRules(rulesFile), {});
  const job = claimNext("w1", "c1", at(3))!;
  const { name, cwd, skill, prompt, emits } = job.rule;
  assert.deepEqual(
    [name, cwd, skill, prompt, emits],
    ["limpeza semanal", "~/code/app", "weekly-sweep", weekly.prompt, undefined],
  );
  assert.equal(job.agent.id, "a1");
  assert.equal(job.session, null);
  assert.equal(job.context.answers.length, 1);
  const [given] = job.context.answers;
  assert.deepEqual(
    [given.card, given.title, given.options, given.choice, given.about, given.by],
    [asked.card, question.title, question.options, 1, question.about, "me"],
  );

  finish(job.run, job.token, { outcome: "done", summary: "motivo informado e PR fechado" }, at(4));
  const row = one<{ state: string; result: string }>("SELECT state, result FROM cards WHERE id = ?", [asked.card])!;
  assert.deepEqual(row, { state: "done", result: "motivo informado e PR fechado" });
  const later = hub.ask("limpeza semanal", { ...question, key: "pr-12" }, at(5));
  assert.equal(later.duplicate, false, "depois de respondida, perguntar de novo é uma pergunta nova");
  // O mesmo assunto comunicado depois sob a mesma chave é novidade, não uma repetição da pergunta.
  assert.equal(hub.tell("elsewhere:limpeza semanal:pr-12", "limpeza semanal", "fechado", at(6)).duplicate, false);
});

test("só uma tarefa que diz onde continua pode perguntar, e só como ela mesma; uma mensagem e uma pergunta não se misturam", async () => {
  const keys = { app: addKey("source", "app"), w1: addKey("worker", "w1"), w2: addKey("worker", "w2") };
  const server = serve(0, "127.0.0.1", { commit: "abc123" });
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  const tell = async (key: string, body: object) => {
    const response = await fetch(`${base}/v1/tell`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  };
  const asked = await tell(keys.w1, { task: "limpeza semanal", ask: question });
  assert.equal(asked.status, 200);
  const card = one<{ kind: string; state: string; options: string; title: string }>(
    "SELECT kind, state, options, title FROM cards WHERE id = ?",
    [asked.json.card],
  )!;
  assert.deepEqual(card, {
    kind: "ask",
    state: "open",
    options: JSON.stringify(question.options),
    title: question.title,
  });

  const refused = async (key: string, body: object, status: number, why: string) =>
    assert.equal((await tell(key, body)).status, status, why);
  assert.equal(
    (await tell(keys.w1, { task: "limpeza semanal", ask: question })).json.duplicate,
    true,
    "mesma pergunta, ainda aberta",
  );
  await refused(
    keys.w1,
    { task: "relatório diário", ask: question },
    400,
    "sem cwd: ninguém para continuar com a resposta",
  );
  await refused(keys.w2, { task: "limpeza semanal", ask: question }, 401, "não é uma tarefa dos Agents dele");
  await refused(keys.app, { key: "x3", ask: question }, 400, "uma fonte não tem tarefa para continuar");
  await refused(keys.w1, { task: "limpeza semanal", ask: { ...question, options: ["só uma"] } }, 400, "uma opção só");
  await refused(keys.w1, { task: "limpeza semanal", text: "só um aparte", ask: question }, 400, "as duas de uma vez");
  await refused(keys.w1, { task: "limpeza semanal", key: "x6", ask: question }, 400, "a key da pergunta é dela mesma");
  const told = await tell(keys.w1, { task: "relatório diário", key: "x7", text: "relatório diário pronto" });
  assert.equal(told.status, 200, "uma tarefa sem cwd ainda assim comunica");
});
