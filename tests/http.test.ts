// As portas. Casos de falha: uma requisição sem chave, com a chave de outro tipo, ou com uma chave inventada entra; uma
// fonte publica como outra fonte ou avisa em nome de outra; um worker esperando trabalho não recebe o que chega enquanto
// espera, ou espera para sempre quando nada vem; uma resposta perdida a um claim perde o trabalho; um token de rodada é
// recusado para a própria rodada ou aceito no lugar de uma chave de worker; um corpo grande demais ou que não é JSON é
// lido; o health não diz qual commit está rodando; o estado fica aberto a qualquer um; um worker avisa como se fosse uma
// tarefa que não é sua, ou avisa o mesmo assunto duas vezes; um canal responde sem estar na lista; um cookie ou um login
// abre alguma coisa; alguém que não é o titular lê tudo, responde, resolve ou para; olhar o link de um cartão o
// responde; as palavras de um cartão rodam como markup ou a página carrega um script; Enter na caixa de texto escolhe a
// primeira opção; um link de cartão responde mais do que o seu cartão; um webhook com assinatura inválida é aceito, ou
// um sem adaptador; o segredo de um webhook vaza em qualquer coisa que ele retorne; a chave do titular abre a porta do
// worker; existe uma página além da de um cartão; o link de um cartão ainda responde ou mostra o cartão depois da sua
// semana, ou te manda para um comando que não funciona; um link abre quando nenhum canal aceita links.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("http");
mkdirSync(join(home, "plugins", "echo"), { recursive: true });
writeFileSync(
  join(home, "plugins", "echo", "source.ts"),
  `
import { createHmac, timingSafeEqual } from "node:crypto";
export default function ({ headers, body, secret }) {
  const sign = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const given = String(headers["x-sign"] ?? "");
  if (given.length !== sign.length || !timingSafeEqual(Buffer.from(given), Buffer.from(sign))) throw new Error("bad signature");
  return JSON.parse(body).items;
}`,
);
process.env.AGENT_AUTOLOOP_SECRET_HOOKS = "hook-secret";
const { serve } = await import("../host/http.ts");
const { addKey, createCard, getView, reloadRules, view } = await import("./hub.ts");
const { all, one } = await import("./hub.ts");

const keys = {
  app: addKey("source", "app"),
  ops: addKey("source", "ops"),
  w1: addKey("worker", "w1"),
  w2: addKey("worker", "w2"),
  chat: addKey("channel", "chat"),
  plain: addKey("channel", "plain"),
  owner: addKey("owner", "owner"),
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

type Options = {
  key?: string;
  body?: unknown;
  raw?: string;
  method?: string;
  headers?: Record<string, string>;
  redirect?: RequestRedirect;
};
async function call(path: string, { key, body, raw, method, headers, redirect }: Options = {}) {
  const response = await fetch(base + path, {
    method: method ?? (body !== undefined || raw !== undefined ? "POST" : "GET"),
    redirect,
    headers: { ...(key && { authorization: `Bearer ${key}` }), "content-type": "application/json", ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: response.status, json, text, headers: response.headers };
}
const note = (n: number) => ({ id: `n:${n}`, type: "feedback.new", subject: `#${n}` });

test("o health diz qual commit está rodando, e nada mais está aberto", async () => {
  assert.deepEqual((await call("/healthz")).json, { ok: true, commit: "abc123" });
  for (const path of ["/v1/state", "/v1/work", "/v1/cards/next"]) assert.equal((await call(path)).status, 401, path);
  assert.equal((await call("/v1/nope", { key: keys.owner })).status, 404);
});

test("cada porta aceita o seu próprio tipo de chave e nenhum outro", async () => {
  assert.equal((await call("/v1/events", { body: note(1) })).status, 401);
  assert.equal((await call("/v1/events", { key: "made-up", body: note(1) })).status, 401);
  assert.equal((await call("/v1/events", { key: keys.w1, body: note(1) })).status, 401);
  assert.equal((await call("/v1/events", { key: keys.owner, body: note(1) })).status, 401);
  assert.equal((await call("/v1/work?claim=x&wait=0", { key: keys.app })).status, 401);
  assert.equal((await call("/v1/work?claim=x&wait=0", { key: keys.owner })).status, 401);
  assert.equal((await call("/v1/cards/next?wait=0", { key: keys.w1 })).status, 401);
  assert.equal((await call("/v1/state", { key: keys.w1 })).status, 401);
  assert.equal((await call("/v1/state", { key: keys.owner })).status, 200);
  const taken = await call("/v1/events", { key: keys.app, body: note(1) });
  assert.equal(taken.status, 200);
  assert.deepEqual(taken.json.routed, ["opiniões"]);
  assert.equal(all<{ source: string }>("SELECT source FROM events")[0].source, "app", "a chave diz de quem é");
});

test("um corpo inválido é recusado", async () => {
  assert.equal((await call("/v1/events", { key: keys.app, raw: "{not json" })).status, 400);
  assert.equal(
    (
      await call("/v1/events", {
        key: keys.app,
        raw: JSON.stringify({ id: "x", type: "y", detail: "z".repeat(2 * 1024 * 1024) }),
      })
    ).status,
    413,
  );
  assert.equal((await call("/v1/events", { key: keys.app, body: { type: "no.id" } })).status, 400);
});

test("a espera de um worker: o que chega enquanto ele espera vem na hora; nada vem, ela termina; uma resposta perdida devolve o trabalho", async () => {
  const empty = await call("/v1/work?claim=empty&wait=0&running=", { key: keys.w2 });
  assert.deepEqual(empty.json, { job: null, cancel: [] });
  const waiting = call("/v1/work?claim=c-2&wait=5", { key: keys.w2 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await call("/v1/events", { key: keys.ops, body: { id: "a:1", type: "alert.raised", subject: "x" } });
  const started = Date.now();
  const got = await waiting;
  assert.ok(Date.now() - started < 2000);
  assert.equal(got.json.job.rule.name, "alerta");
  const again = await call("/v1/work?claim=c-2&wait=0", { key: keys.w2 });
  assert.equal(again.json.job.run, got.json.job.run, "o mesmo claim recebe o mesmo trabalho de volta");
  // Só o token mais recente detém a rodada.
  const refused = await call(`/v1/runs/${got.json.job.run}/result`, {
    key: got.json.job.token,
    body: { outcome: "done" },
  });
  assert.equal(refused.status, 401);
  assert.equal(
    (await call(`/v1/runs/${again.json.job.run}/started`, { key: keys.w2, body: { link: "x://y" } })).status,
    401,
    "uma chave de worker não é o token de uma rodada",
  );
  assert.equal(
    (
      await call(`/v1/runs/${again.json.job.run}/started`, {
        key: again.json.job.token,
        body: { session: "s", link: "x://y" },
      })
    ).status,
    200,
  );
  const result = {
    outcome: "done",
    summary: "pronto",
    ask: [{ title: "pergunta", text: "o que fazer", options: ["alfa", "beta"] }],
  };
  const done = await call(`/v1/runs/${again.json.job.run}/result`, { key: again.json.job.token, body: result });
  assert.deepEqual(done.json, { rejected: [] });
  const replay = await call(`/v1/runs/${again.json.job.run}/result`, { key: again.json.job.token, body: result });
  assert.equal(replay.json.duplicate, true);
  const conflict = await call(`/v1/runs/${again.json.job.run}/result`, {
    key: again.json.job.token,
    body: { outcome: "done", summary: "outra coisa" },
  });
  assert.equal(conflict.status, 409);
  const bad = await call(`/v1/work?claim=${"x".repeat(201)}&wait=0`, { key: keys.w2 });
  assert.equal(bad.status, 400);
});

test("uma fonte avisa em seu próprio nome, uma vez por chave; um worker só como sua própria tarefa", async () => {
  const told = await call("/v1/tell", { key: keys.app, body: { key: "weekly-44", text: "relatório semanal" } });
  assert.deepEqual([told.status, told.json.duplicate], [200, false]);
  assert.equal(one<{ title: string }>("SELECT title FROM cards WHERE id = ?", [told.json.card])!.title, "aplicativo");
  assert.equal(
    (await call("/v1/tell", { key: keys.app, body: { key: "weekly-44", text: "relatório semanal" } })).json.duplicate,
    true,
  );
  assert.equal((await call("/v1/tell", { key: keys.app, body: { key: "Bad Key", text: "x" } })).status, 400);
  assert.equal((await call("/v1/tell", { key: keys.app, body: { key: "k", text: " " } })).status, 400);
  assert.equal((await call("/v1/tell", { key: keys.app, body: { key: "k", text: "x", oops: 1 } })).status, 400);
  assert.equal((await call("/v1/tell", { body: { key: "k", text: "x" } })).status, 401);
  const task = await call("/v1/tell", {
    key: keys.w1,
    body: { task: "limpeza semanal", key: "m", text: "para você dar uma olhada" },
  });
  assert.equal(task.status, 200);
  assert.equal(
    one<{ title: string }>("SELECT title FROM cards WHERE id = ?", [task.json.card])!.title,
    "limpeza semanal",
  );
  assert.equal(
    (await call("/v1/tell", { key: keys.w2, body: { task: "limpeza semanal", key: "m2", text: "x" } })).status,
    401,
    "não é uma tarefa dos Agents dele",
  );
  assert.equal(
    (await call("/v1/tell", { key: keys.w1, body: { task: "não existe esta", key: "m3", text: "x" } })).status,
    401,
  );
});

test("um canal vem buscar cartões, os reporta e repassa quem respondeu; a lista decide", async () => {
  // Tudo até agora para este canal, do mais antigo para o mais novo, e então uma espera vazia.
  const seen: any[] = [];
  for (;;) {
    const { json } = await call("/v1/cards/next?wait=0", { key: keys.chat });
    if (!json.card) break;
    seen.push(json.card);
    assert.equal(
      (
        await call(`/v1/cards/${json.card.id}/delivered`, {
          key: keys.chat,
          body: { version: json.card.version, ref: `om_${json.card.id}` },
        })
      ).status,
      200,
    );
  }
  const ask = seen.find((c) => c.kind === "ask");
  assert.deepEqual(ask.options, ["alfa", "beta"]);
  const url = `/v1/cards/${ask.id}/answer`;
  assert.equal((await call(url, { key: keys.w1, body: { choice: 0, by: "me", ref: `om_${ask.id}` } })).status, 401);
  assert.equal(
    (await call(url, { key: keys.chat, body: { choice: 0, by: "stranger", ref: `om_${ask.id}` } })).status,
    401,
  );
  assert.equal((await call(url, { key: keys.chat, body: { choice: 0, by: "me", ref: "om_other" } })).status, 401);
  assert.equal((await call(url, { key: keys.chat, body: { choice: 9, by: "me", ref: `om_${ask.id}` } })).status, 400);
  const yes = await call(url, { key: keys.chat, body: { choice: 1, by: "me", ref: `om_${ask.id}` } });
  assert.deepEqual([yes.status, yes.json.changed], [200, true]);
  assert.equal(
    (await call(url, { key: keys.chat, body: { choice: 0, by: "me", ref: `om_${ask.id}` } })).json.changed,
    false,
  );
  const next = await call("/v1/work?claim=c-3&wait=0", { key: keys.w2 });
  assert.equal(next.json.job.context.answers[0].choice, 1);
  await call(`/v1/runs/${next.json.job.run}/result`, {
    key: next.json.job.token,
    body: { outcome: "done", summary: "escolheu beta" },
  });
  assert.equal(
    (await call(`/v1/cards/${ask.id}/failed`, { key: keys.chat, body: { version: 1, error: "x" } })).status,
    200,
  );
  assert.equal(
    (await call("/v1/cards/99999/delivered", { key: keys.chat, body: { version: 1, ref: "x" } })).status,
    404,
  );
});

test("a chave do titular lê tudo, responde, resolve e para; nada mais faz isso, e não existe login", async () => {
  assert.equal((await call("/v1/login/code", { key: keys.owner, body: {} })).status, 404);
  assert.equal((await call("/login?code=x", { redirect: "manual" })).status, 404);
  assert.equal((await call("/v1/state", { headers: { cookie: "agent_autoloop_session=x" } })).status, 401);
  assert.ok(Array.isArray((await call("/v1/state", { key: keys.owner })).json.runs));

  await call("/v1/events", { key: keys.app, body: note(50) });
  const job = (await call("/v1/work?claim=c-9&wait=0", { key: keys.w1 })).json.job;
  const asked = {
    outcome: "done",
    ask: [{ title: "o titular responde", text: "escolha uma", options: ["alfa", "beta"], key: "own" }],
    notice: [{ title: "veja isto", text: "isto" }],
  };
  await call(`/v1/runs/${job.run}/result`, { key: job.token, body: asked });
  const [card, notice] = (await call("/v1/state", { key: keys.owner })).json.cards
    .sort((a: any, b: any) => a.id - b.id)
    .slice(-2);
  assert.equal(card.link, null, "um link só vai para um canal autorizado a ter um");
  const url = `/v1/cards/${card.id}/answer`;
  assert.equal((await call(url, { body: { choice: 0 } })).status, 401);
  assert.equal((await call(url, { key: keys.w1, body: { choice: 0 } })).status, 401);
  assert.equal((await call(url, { key: keys.owner, body: { choice: 0 } })).json.changed, true);
  assert.equal(one<{ by: string }>("SELECT by FROM cards WHERE id = ?", [card.id])!.by, "o titular");
  assert.equal((await call(`/v1/cards/${notice.id}/resolve`, { body: { reason: "resolvi" } })).status, 401);
  assert.equal((await call(`/v1/cards/${notice.id}/resolve`, { key: keys.owner, body: { reason: " " } })).status, 400);
  const resolved = await call(`/v1/cards/${notice.id}/resolve`, { key: keys.owner, body: { reason: "resolvi" } });
  assert.deepEqual([resolved.status, resolved.json.changed], [200, true]);
  const waiting = await call("/v1/work?claim=c-10&wait=0", { key: keys.w1 });
  assert.equal((await call(`/v1/runs/${waiting.json.job.run}/cancel`, { body: {} })).status, 401);
  assert.equal((await call(`/v1/runs/${waiting.json.job.run}/cancel`, { key: keys.owner, body: {} })).status, 200);
  assert.deepEqual((await call("/v1/work?claim=c-11&wait=0", { key: keys.w1 })).json.cancel, [waiting.json.job.run]);
});

const form = (path: string, fields: string) =>
  call(path, { raw: fields, headers: { "content-type": "application/x-www-form-urlencoded" }, redirect: "manual" });
/** Faz o Agent perguntar isto, e obtém o link que foi dado ao canal autorizado apenas a enviar texto. */
async function linkFor(n: number, receipt: Record<string, unknown>) {
  await call("/v1/events", { key: keys.app, body: note(n) });
  const job = (await call(`/v1/work?claim=c-${n}&wait=0`, { key: keys.w1 })).json.job;
  await call(`/v1/runs/${job.run}/result`, { key: job.token, body: { outcome: "done", ...receipt } });
  let given: any;
  for (;;) {
    const { json } = await call("/v1/cards/next?wait=0", { key: keys.plain });
    if (!json.card) break;
    given = json.card;
    await call(`/v1/cards/${json.card.id}/delivered`, {
      key: keys.plain,
      body: { version: json.card.version, ref: "p" },
    });
  }
  return { id: given.id as number, path: new URL(given.link).pathname };
}
const stored = (id: number) =>
  one<{ state: string; choice: number | null; answer: string | null; by: string }>(
    "SELECT state, choice, answer, by FROM cards WHERE id = ?",
    [id],
  )!;

test("o link de um cartão é uma página simples: mostra aquele cartão em texto, não roda nada, e só um clique responde", async () => {
  const title = "<script>alert(1)</script>resposta pelo link";
  const { id, path } = await linkFor(60, {
    ask: [{ title, text: "escolha uma & <b>outra</b>", options: ["alfa", "beta<i>"], recommend: 0 }],
  });
  const page = await call(path);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type")!, /^text\/html/);
  assert.ok(!/<script|<b>|<i>/.test(page.text), page.text);
  assert.ok(page.text.includes("&lt;script&gt;alert(1)&lt;/script&gt;resposta pelo link"));
  assert.match(page.text, /<p class="from">Fonte: [^<]+<\/p>/, "a página diz de que regra o cartão veio");
  assert.match(page.headers.get("content-security-policy")!, /default-src 'none'/);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(
    stored(id).state,
    "open",
    "olhá-lo, como faz um app de chat que pré-visualiza o link, não responde nada",
  );
  const forms = page.text.split("<form").slice(1);
  assert.equal(forms.length, 2);
  assert.match(forms[0], /<button name="choice" value="0" class="best" autofocus>/);
  assert.equal(page.text.split("autofocus").length - 1, 1, "o Enter envia apenas a opção recomendada em foco");
  assert.ok(!forms[1].includes('name="choice"'), "o Enter na caixa de texto não escolhe uma opção");

  assert.equal((await call("/c/made-up")).status, 404);
  assert.equal((await form("/c/made-up", "choice=0")).status, 404);
  assert.equal((await form(path, "choice=9")).status, 400);
  assert.equal((await form(path, "text=")).status, 400);
  assert.match(
    (await form(path, "choice=9")).text,
    /Esta opção não existe/,
    "a pessoa é avisada em texto, não em JSON",
  );
  const yes = await form(path, "choice=1");
  assert.deepEqual([yes.status, yes.headers.get("location")], [303, path]);
  assert.deepEqual([stored(id).choice, stored(id).by], [1, "link"]);
  assert.ok((await call(path)).text.includes('Você escolheu “beta&lt;i&gt;”'));
  assert.ok(!(await call(path)).text.includes("<form"), "nada sobrou para clicar");
  assert.equal((await form(path, "choice=0")).status, 303);
  assert.equal(stored(id).choice, 1, "só o primeiro clique conta");
  assert.equal((await call(`${path}.json`)).status, 404);
});

test("um link de cartão foca sua primeira opção quando o Agent não recomenda nenhuma", async () => {
  const { path } = await linkFor(66, {
    ask: [{ title: "sem opção recomendada", text: "escolha uma", options: ["alfa", "beta"] }],
  });
  const page = await call(path);
  assert.match(page.text, /<button name="choice" value="0" autofocus>/);
  assert.equal(page.text.split("autofocus").length - 1, 1);
});

test("o link de um cartão dura uma semana: depois disso ele nem responde nem mostra o cartão", async () => {
  const days = (count: number) => Date.now() - count * 24 * 60 * 60_000;
  const made = (key: string, at: number) =>
    createCard(
      {
        key,
        kind: "ask",
        title: "pergunta de há muito tempo",
        text: "conteúdo de há muito tempo",
        options: ["alfa", "beta"],
      },
      at,
    ).card;
  const linkOf = (id: number) => new URL(view(getView().get("cards", id)!, null, true).link!).pathname;

  const recent = made("link-recent", days(6));
  assert.equal((await call(linkOf(recent))).status, 200);
  assert.equal((await form(linkOf(recent), "choice=1")).status, 303);
  assert.equal(stored(recent).choice, 1);

  const old = made("link-old", days(8));
  const shown = await call(linkOf(old));
  assert.equal(shown.status, 401);
  assert.ok(!shown.text.includes("há muito tempo"), "o que ele perguntou fica fora da página");
  assert.ok(shown.text.includes("agent-autoloop status"), "e ela diz onde responder em vez disso");
  assert.equal((await form(linkOf(old), "choice=1")).status, 401);
  assert.deepEqual([stored(old).state, stored(old).choice], ["open", null]);
});

test("sem nenhum canal aceitando links, o link de um cartão não abre", async () => {
  const { path } = await linkFor(65, {
    ask: [{ title: "pergunta", text: "pergunta", options: ["alfa", "beta"], key: "no-links" }],
  });
  const fixture = process.env.AGENT_AUTOLOOP_RULES!;
  const rules = JSON.parse(readFileSync(fixture, "utf8"));
  delete rules.channels.plain.links;
  const file = join(home, "no-links.json");
  writeFileSync(file, JSON.stringify(rules));
  reloadRules(file);
  try {
    assert.equal((await call(path)).status, 404);
  } finally {
    reloadRules(fixture);
  }
  assert.equal((await call(path)).status, 200);
});

test("o link de um cartão aceita texto seu, e uma notificação aceita uma linha própria", async () => {
  const asked = await linkFor(61, {
    ask: [{ title: "outra ideia", text: "escolha uma", options: ["alfa", "beta"], key: "words" }],
  });
  assert.equal((await form(asked.path, `text=${encodeURIComponent("nenhuma delas")}`)).status, 303);
  assert.deepEqual([stored(asked.id).choice, stored(asked.id).answer], [null, "nenhuma delas"]);
  assert.ok((await call(asked.path)).text.includes('Você escolheu “nenhuma delas”'));
  const told = await linkFor(62, {
    notice: [{ title: "fique atento", text: "o disco está quase cheio", key: "disk" }],
  });
  const page = await call(told.path);
  assert.equal(page.text.split("<form").length - 1, 2);
  assert.ok(page.text.includes("Resolvido"));
  assert.ok(page.text.includes("Registrar e encerrar"), "uma notificação pode ser resolvida com uma linha sua");
  assert.equal((await form(told.path, `text=${encodeURIComponent("limpei 3GB de cache")}`)).status, 303);
  assert.equal(stored(told.id).state, "closed");
  assert.equal(stored(told.id).answer, "limpei 3GB de cache", "a linha é guardada junto com o cartão");
  assert.ok((await call(told.path)).text.includes("Nota de tratamento: limpei 3GB de cache"));
  const silent = await linkFor(63, { notice: [{ title: "ele de novo", text: "spam em massa", key: "ad" }] });
  assert.equal((await form(silent.path, "choice=0")).status, 303);
  assert.deepEqual([stored(silent.id).state, stored(silent.id).answer], ["closed", null]);
  const long = await linkFor(64, { notice: [{ title: "longo demais", text: "nota longa demais", key: "long" }] });
  assert.equal((await form(long.path, `text=${"á".repeat(4001)}`)).status, 400);
  assert.equal(stored(long.id).state, "open", "longo demais é recusado, não cortado");
});

test("o webhook de outra pessoa passa pelo adaptador da sua fonte: assinado, ou não é aceito", async () => {
  const items = JSON.stringify({
    items: [
      { id: "h1", type: "push.done", subject: "main" },
      { id: "h2", type: "push.done" },
    ],
  });
  const sign = (body: string) => "sha256=" + createHmac("sha256", "hook-secret").update(body).digest("hex");
  const taken = await call("/v1/in/hooks", { raw: items, headers: { "x-sign": sign(items) } });
  assert.equal(taken.status, 200);
  assert.deepEqual(
    taken.json.events.map((e: any) => e.duplicate),
    [false, false],
  );
  assert.equal(
    (await call("/v1/in/hooks", { raw: items, headers: { "x-sign": sign(items) } })).json.events[0].duplicate,
    true,
  );
  const refused = await call("/v1/in/hooks", { raw: items, headers: { "x-sign": "sha256=00" } });
  assert.equal(refused.status, 401);
  assert.ok(!refused.text.includes("hook-secret"));
  assert.equal((await call("/v1/in/app", { raw: items })).status, 404, "uma fonte sem adaptador não recebe webhooks");
  assert.equal((await call("/v1/in/nowhere", { raw: items })).status, 404);
});

test("não existe outra página: o que está acontecendo é lido pelas portas", async () => {
  for (const path of ["/", "/index.html", "/app.js", "/style.css", "/../package.json"])
    assert.equal((await call(path)).status, 404, path);
});
