// Uma fonte pergunta, com a própria chave, o que aconteceu com um evento que ela enviou. Casos de falha: a chave de outra
// fonte, ou a do titular, a de um worker, a de um canal, nenhuma, o lê; o evento de outra fonte responde de forma diferente de
// um que não existe, então uma fonte consegue dizer quais números já estão tomados; uma rodada esperando para tentar de novo
// é lida como terminada, ou uma que não será tentada de novo, que foi parada pelo titular, ou que perdeu a regra não tem um fim
// para ler; uma rodada que também recebeu o evento de outra fonte entrega o resumo dela ou os eventos que o recibo enviou;
// eventos de outra rodada aparecem como sendo desta; o número que um reenvio recebeu de volta como duplicata não encontra nada;
// um evento que a central registrou sob uma fonte sem que aquela fonte o enviasse (o que um recibo enviou em nome dela, a
// execução manual do titular) é lido com a chave daquela fonte.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("event-outcome");
const fixture = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_RULES!, "utf8"));
const notes = fixture.rules.find((rule: { name: string }) => rule.name === "opiniões");
notes.emits = { source: "ops", types: ["note.*"] };
const rulesFile = join(home, "rules.json");
const writeRules = (rules: unknown) => writeFileSync(rulesFile, JSON.stringify(rules));
writeRules(fixture);
process.env.AGENT_AUTOLOOP_RULES = rulesFile;
const hub = await import("./hub.ts");
const { serve } = await import("../host/http.ts");
const { checkSchema } = await import("../protocol/schema.ts");

const keys = {
  app: hub.addKey("source", "app"),
  ops: hub.addKey("source", "ops"),
  owner: hub.addKey("owner", "owner"),
  worker: hub.addKey("worker", "w1"),
  channel: hub.addKey("channel", "chat"),
};
const server = serve(0, "127.0.0.1");
let base = "";
before(async () => {
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  for (const table of ["events", "runs", "run_events", "cards", "timers", "pauses"] as const) hub.fixtureClear(table);
});

async function outcome(event: number | string, key = keys.app) {
  const response = await fetch(`${base}/v1/events/${event}`, { headers: { authorization: `Bearer ${key}` } });
  const json = await response.json();
  if (response.status === 200) assert.deepEqual(checkSchema("eventOutcome", json), []);
  return { status: response.status, json };
}
const send = (source: string, id: string, subject = "#1", type = "feedback.new") =>
  hub.ingest(source, { id, type, subject });
const take = (now = Date.now()) => hub.claimNext("w1", `claim-${now}-${Math.random()}`, now)!;

test("só a fonte que o enviou o lê, e qualquer outra pessoa não encontra nada ali", async () => {
  const { event } = send("app", "f:1");
  for (const key of [keys.owner, keys.worker, keys.channel, "", "made-up"]) {
    assert.equal((await outcome(event, key)).status, 401);
  }
  const elsewhere = await outcome(event, keys.ops);
  const missing = await outcome(event + 1000, keys.ops);
  assert.equal(elsewhere.status, 404);
  assert.deepEqual(elsewhere, missing);
  for (const bad of ["0", "-1", "f:1", "1.5"]) assert.equal((await outcome(bad)).status, 404, bad);
});

test("de esperando, passando por uma tentativa que não passou, até concluída com os eventos do recibo", async () => {
  const sent = send("app", "f:2");
  const again = send("app", "f:2");
  assert.equal(again.event, sent.event);
  const queued = await outcome(again.event);
  assert.equal(queued.status, 200);
  assert.deepEqual(queued.json.routed, ["opiniões"]);
  const [run] = queued.json.runs;
  assert.deepEqual(
    [run.rule, run.state, run.attempts, run.error, run.finishedAt],
    ["opiniões", "queued", 0, null, null],
  );

  const first = take();
  assert.equal((await outcome(sent.event)).json.runs[0].state, "claimed");
  hub.finish(first.run, first.token, { outcome: "failed", error: "a rede caiu" });
  const retrying = (await outcome(sent.event)).json.runs[0];
  assert.deepEqual(
    [retrying.run, retrying.state, retrying.attempts, retrying.error],
    [first.run, "queued", 1, "a rede caiu"],
  );

  const second = take(Date.now() + 3600_000);
  const note = { id: "n:1", type: "note.made", subject: "#1", summary: "escrito", detail: "relatório", link: "" };
  hub.finish(second.run, second.token, { outcome: "done", summary: "organização concluída", events: [note] });
  const done = (await outcome(sent.event)).json.runs[0];
  assert.deepEqual([done.state, done.attempts, done.error, done.summary], ["done", 1, null, "organização concluída"]);
  assert.ok(done.finishedAt);
  assert.deepEqual(done.events, [
    { id: "n:1", type: "note.made", subject: "#1", summary: "escrito", detail: "relatório", link: "" },
  ]);
});

test("o que a central registrou sob uma fonte, sem aquela fonte ter enviado, não é da fonte para ler", async () => {
  const { event } = send("app", "f:sent");
  const job = take();
  hub.finish(job.run, job.token, {
    outcome: "done",
    summary: "escrito",
    events: [{ id: "n:made", type: "note.made" }],
  });
  const [made] = (await outcome(event)).json.runs[0].events;
  // Enviar o mesmo número de novo devolve aquele que o recibo criou.
  const madeEvent = hub.ingest("ops", { id: made.id, type: "note.made" }).event;
  assert.equal(
    (await outcome(madeEvent, keys.ops)).status,
    404,
    "um evento de recibo lê como se fosse da própria fonte",
  );
  const manual = hub.execute("runRule", ["opiniões", "owner", { subject: "#9", reason: "dar uma olhada" }]) as {
    event: number;
  };
  assert.equal(
    (await outcome(manual.event)).status,
    404,
    "a execução manual do titular lê como se fosse da própria fonte",
  );
});

test("cada rodada mostra só o que o próprio recibo dela enviou", async () => {
  const one = send("app", "f:3", "#3");
  const two = send("app", "f:4", "#4");
  const [a, b] = [take(), take()];
  hub.finish(a.run, a.token, { outcome: "done", summary: "alfa", events: [{ id: "n:a", type: "note.a" }] });
  hub.finish(b.run, b.token, { outcome: "nothing", summary: "beta" });
  const [first, second] = [(await outcome(one.event)).json, (await outcome(two.event)).json];
  assert.deepEqual(
    first.runs.map((run: any) => [run.summary, run.events.map((event: any) => event.id)]),
    [["alfa", ["n:a"]]],
  );
  assert.deepEqual(
    second.runs.map((run: any) => [run.state, run.summary, run.events]),
    [["nothing", "beta", []]],
  );
});

test("um evento que o recibo envia de novo sob um número já tomado não é mostrado como o que ele enviou", async () => {
  hub.ingest("ops", { id: "n:taken", type: "note.ops", detail: "das próprias operações" });
  const mine = send("app", "f:9", "#9");
  const job = take();
  hub.finish(job.run, job.token, {
    outcome: "done",
    summary: "pronto",
    events: [{ id: "n:taken", type: "note.a", detail: "meu" }],
  });
  assert.deepEqual((await outcome(mine.event)).json.runs[0].events, []);
});

test("uma rodada que termina sem estar concluída ainda assim lê como terminada", async () => {
  const stopped = send("app", "f:5", "#5");
  const job = take();
  hub.cancel(job.run);
  hub.finish(job.run, job.token, { outcome: "cancelled" });
  const byOwner = (await outcome(stopped.event)).json.runs[0];
  assert.equal(byOwner.state, "cancelled");
  assert.ok(byOwner.finishedAt);

  const failing = send("app", "f:6", "#6");
  let now = Date.now();
  for (let tries = 0; tries < 10; tries++) {
    const next = take(now);
    hub.finish(next.run, next.token, { outcome: "failed", error: "login expirado" }, now);
    now += 2 * 3600_000;
  }
  const givenUp = (await outcome(failing.event)).json.runs[0];
  assert.deepEqual([givenUp.state, givenUp.attempts, givenUp.error], ["cancelled", 10, "login expirado"]);
  assert.match(givenUp.summary, /sem nova tentativa automática/);
  assert.ok(givenUp.finishedAt);

  const paused = await fetch(`${base}/v1/rules/${encodeURIComponent("opiniões")}/pause`, {
    method: "POST",
    headers: { authorization: `Bearer ${keys.owner}` },
    body: "{}",
  });
  assert.equal(paused.status, 200);
  const skipped = (await outcome(send("app", "f:7", "#7").event)).json;
  assert.deepEqual([skipped.routed, skipped.paused, skipped.runs], [[], ["opiniões"], []]);
});

test("uma rodada que também recebeu o evento de outra fonte guarda para si o resumo e os eventos dela", async () => {
  const mine = send("app", "f:8", "#8");
  // A regra agora recebe eventos de outra fonte, então o próximo evento do mesmo objeto entra na rodada já enfileirada.
  writeRules({
    ...fixture,
    rules: fixture.rules.map((rule: any) =>
      rule === notes ? { ...rule, when: { source: "ops", types: ["fix.*"] } } : rule,
    ),
  });
  hub.reloadRules(rulesFile);
  const theirs = send("ops", "a:8", "#8", "fix.made");
  writeRules(fixture);
  hub.reloadRules(rulesFile);
  const job = take();
  assert.equal(job.context.events.length, 2);
  hub.finish(job.run, job.token, {
    outcome: "done",
    summary: "os dois feitos juntos",
    events: [{ id: "n:8", type: "note.a" }],
  });
  for (const [event, key] of [
    [mine.event, keys.app],
    [theirs.event, keys.ops],
  ] as const) {
    const [run] = (await outcome(event, key)).json.runs;
    assert.deepEqual([run.run, run.state, run.summary, run.events], [job.run, "done", null, null]);
  }
});
