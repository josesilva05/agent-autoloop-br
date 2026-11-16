// Modos de falha: why omite a regra ou a resposta; um stream perde fatos ao reconectar, expõe hashes de chave ou aceita
// uma fonte; as ações rejeitadas de um recibo mudam na reexecução; uma escrita de view que falha depois do acréscimo
// deixa um recibo commitado só em parte. Tentar de novo após editar as regras deve manter as duas versões visíveis em why.
// Leitores lentos de stream não devem carregar nem bufferizar o log histórico inteiro.
// Um stream já aberto deve parar na revogação da chave e desanexar seu listener de aborto ao ser cancelado.
// Fechar um cartão offline durante o heartbeat deve acordar um canal que já consulta por essa atualização.
import assert from "node:assert/strict";
import { rows, snapshot } from "../kernel/evolve.ts";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";
setup("stream");
const hub = await import("./hub.ts");
const { makeHandler } = await import("../host/server.ts");
const runtime = makeHandler("test");
after(runtime.close);
const owner = hub.addKey("owner", "me");
const source = hub.addKey("source", "app");
const call = (path: string, key = owner, body?: unknown) =>
  runtime.handle(
    new Request(`http://local${path}`, {
      headers: { authorization: `Bearer ${key}` },
      ...(body !== undefined && { method: "POST", body: JSON.stringify(body) }),
    }),
  );

test("handler no padrão web transmite fatos com cursores e rastreia uma rodada inteira", async () => {
  assert.equal((await call("/v1/stream", source)).status, 401);
  const before = hub.getView().seq;
  hub.ingest("app", { id: "trace", type: "feedback.new" });
  const job = hub.claimNext("w1", "trace")!;
  const result = {
    outcome: "done",
    resolve: [{ card: 999, reason: "fora dos limites" }],
    ask: [{ title: "escolha uma", text: "conteúdo", options: ["alfa", "beta"] }],
  };
  const first = hub.finish(job.run, job.token, result);
  assert.deepEqual(hub.finish(job.run, job.token, result).rejected, first.rejected);
  const card = rows(hub.getView(), "cards").find((c) => c.run_id === job.run)!;
  hub.answer(card.id, { choice: 0, by: "titular" });
  const facts = await (await call(`/v1/runs/${job.run}/why`)).json();
  for (const type of ["rules", "ingest", "claimNext", "finish", "answer"])
    assert.ok(
      facts.some((f: any) => f.type === type),
      type,
    );
  const stream = await call(`/v1/stream?after=${before}`);
  const reader = stream.body!.getReader();
  const text = new TextDecoder().decode((await reader.read()).value);
  assert.match(text, new RegExp(`id: ${before + 1}\\n`));
  assert.ok(!text.includes(owner));
  assert.ok(!text.includes(job.token));
  await reader.cancel();
  assert.equal((await call("/v1/stream?after=-1")).status, 400);
});
test("uma falha de projeção reverte tanto o recibo quanto o log", () => {
  hub.ingest("app", { id: "atomic", type: "feedback.new", subject: "atomic" });
  const job = hub.claimNext("w1", "atomic")!;
  const before = snapshot(hub.getView());
  hub.db.exec(
    "CREATE TEMP TRIGGER reject_card BEFORE INSERT ON projections WHEN NEW.collection='cards' BEGIN SELECT RAISE(ABORT,'disk failure'); END;",
  );
  assert.throws(
    () => hub.finish(job.run, job.token, { outcome: "done", notice: [{ title: "Notificação", text: "conteúdo" }] }),
    /disk failure/,
  );
  hub.db.exec("DROP TRIGGER reject_card");
  assert.deepEqual(snapshot(hub.getView()), before);
  assert.equal(hub.getView().get("runs", job.run)!.state, "claimed");
});

test("why retém cada versão das regras entre tentativas que falharam e as repetidas", () => {
  const before = hub.rules;
  const now = Date.now();
  hub.ingest("ops", { id: "versions", type: "alert.raised" }, now);
  const first = hub.claimNext("w2", "versions", now)!;
  hub.finish(first.run, first.token, { outcome: "failed" }, now + 1);
  const changed = structuredClone(before);
  changed.rules[1].prompt = "regra alterada";
  hub.execute("rules", [changed], now + 2);
  const second = hub.claimNext("w2", "retried", now + 300001)!;
  assert.equal(second.run, first.run);
  const versions = hub.why(first.run).filter((f) => f.type === "rules");
  assert.equal(versions.length, 2);
  hub.execute("rules", [before], now + 300002);
});

test("revogar uma chave do titular fecha o seu stream ativo antes de enviar outro fato", async () => {
  const key = hub.addKey("owner", "temporary");
  const response = await call(`/v1/stream?after=${hub.getView().seq}`, key);
  const reader = response.body!.getReader();
  hub.removeKey("owner", "temporary");
  assert.equal((await reader.read()).done, true);
  await reader.cancel();
});

test("cancelar um stream desanexa o listener de aborto da requisição", async () => {
  const abort = new AbortController();
  const response = await runtime.handle(
    new Request(`http://local/v1/stream?after=${hub.getView().seq}`, {
      headers: { authorization: `Bearer ${owner}` },
      signal: abort.signal,
    }),
  );
  await response.body!.cancel();
  abort.abort();
  await new Promise((resolve) => setImmediate(resolve));
});

test("mudanças de cartão no heartbeat acordam consultas de canal pendentes", async () => {
  const channel = hub.addKey("channel", "chat");
  const id = hub.createCard({ key: "worker:w2:offline:test", kind: "notice", title: "Offline", text: "conteúdo" }).card;
  for (;;) {
    const card = hub.nextCard("chat");
    if (!card) break;
    hub.delivered("chat", card.id, card.version, `message-${card.id}`);
  }
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 200);
  try {
    const response = runtime.handle(
      new Request("http://local/v1/cards/next?wait=50", {
        headers: { authorization: `Bearer ${channel}` },
        signal: abort.signal,
      }),
    );
    hub.heartbeat("w2", []);
    const body = await (await response).json();
    assert.equal(body.card?.id, id);
    assert.equal(body.card?.state, "closed");
  } finally {
    clearTimeout(timeout);
    abort.abort();
  }
});

test("um assinante lento lê só o próximo fato, não o histórico inteiro", async () => {
  const before = hub.getView().seq;
  for (let n = 0; n < 100; n++) hub.ingest("app", { id: `stream-bounded-${n}`, type: "unmatched" });
  const prepare = hub.db.prepare.bind(hub.db);
  let read = 0;
  hub.db.prepare = ((sql: string) => {
    const stmt = prepare(sql);
    if (!/SELECT fact FROM facts/.test(sql)) return stmt;
    return new Proxy(stmt, {
      get(target, key) {
        if (key === "iterate")
          return function* (...args: any[]) {
            for (const row of target.iterate(...args)) {
              read++;
              yield row;
            }
          };
        if (key === "all")
          return (...args: any[]) => {
            const result = target.all(...args);
            read += result.length;
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof hub.db.prepare;
  let response: Response | undefined;
  try {
    response = await call(`/v1/stream?after=${before}`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(read <= 2, `bufferizou ${read} fatos antes de o assinante ler qualquer um`);
    const reader = response.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), new RegExp(`id: ${before + 1}\\n`));
    await reader.cancel();
  } finally {
    hub.db.prepare = prepare;
    if (response?.body && !response.body.locked) await response.body.cancel();
  }
});
