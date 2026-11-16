// Modos de falha: loops emitidos zeram a própria profundidade; respostas e trabalho adiado descartam a cadeia; um evento
// bloqueado desaparece ou é despachado mesmo assim; profundidade malformada atravessa a fronteira de entrada.
import assert from "node:assert/strict";
import { test } from "node:test";
import { World, rules } from "../sim/world.ts";
import { rows } from "../kernel/evolve.ts";
import { parseEvent } from "../protocol/validate.ts";
import { checkSchema } from "../protocol/schema.ts";
test("o schema de eventos publicado aceita a mesma profundidade que o runtime", () => {
  assert.deepEqual(checkSchema("event", { id: "one", type: "one", hops: 8 }), []);
  assert.notDeepEqual(checkSchema("event", { id: "one", type: "one", hops: -1 }), []);
  // Mais fundo que o corte de despacho ainda é um evento válido — ele é registrado e não despachado — então um schema
  // limitado ao corte recusaria o que o runtime aceita.
  assert.equal(parseEvent({ id: "one", type: "one", hops: 9 }).hops, 9);
  assert.deepEqual(checkSchema("event", { id: "one", type: "one", hops: 9 }), []);
});
test("eventos de recibo não podem forjar saltos; acima de oito é registrado sem despacho", () => {
  const w = new World();
  const r = structuredClone(rules);
  r.rules[0].emits = { source: "app", types: ["one"] };
  w.call("rules", r);
  w.call("ingest", "app", { id: "loop", type: "one", hops: 8 });
  const job = w.call("claimNext", "w1", "c");
  assert.equal(job.context.events[0].hops, 8);
  w.call("finish", job.run, job.token, { outcome: "done", events: [{ id: "next", type: "one", hops: 0 }] });
  const e = rows(w.view, "events").find((e) => e.key === "next")!;
  assert.equal(e.hops, 9);
  assert.equal(e.routed, "[]");
  assert.equal(w.call("claimNext", "w1", "d"), null);
  assert.ok(rows(w.view, "cards").some((c) => c.text.includes("8")));
});
test("respostas e timers herdam a profundidade original da cadeia", () => {
  const w = new World();
  w.call("ingest", "app", { id: "depth", type: "one", subject: "depth", hops: 7 });
  const job = w.call("claimNext", "w1", "c");
  w.call("finish", job.run, job.token, {
    outcome: "done",
    ask: [{ key: "q", title: "escolha", text: "escolha", options: ["alfa", "beta"] }],
    later: [{ key: "t", at: "1970-01-01T00:01:00Z", about: "verificar" }],
  });
  w.call("answer", 1, { choice: 0 });
  w.advance(60000);
  assert.deepEqual(
    rows(w.view, "events").map((e) => e.hops),
    [7, 7, 7],
  );
});
test("a profundidade vem como zero por padrão e recusa números negativos, fracionários ou sem limite", () => {
  assert.equal(parseEvent({ id: "a", type: "one" }).hops, 0);
  for (const hops of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"])
    assert.throws(() => parseEvent({ id: "a", type: "one", hops }));
});
