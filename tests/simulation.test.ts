// Modos de falha: as falhas perdem eventos aceitos, duplicam execuções ou respostas, excedem limites de paralelismo,
// alteram recibos, divergem da reprodução ou deixam trabalho encalhado depois da recuperação; um enumerador pula em
// silêncio uma das ordens; as verificações de mutação não rodam.
import assert from "node:assert/strict";
import { test } from "node:test";
import { simulate } from "../sim/random.ts";
import { enumerate } from "../sim/enumerate.ts";
import { World } from "../sim/world.ts";
import { AuthError } from "../kernel/errors.ts";
import { empty, evolve } from "../kernel/evolve.ts";
import { invariants } from "../sim/invariants.ts";

test("200000 passos determinísticos de falha preservam a segurança e o trabalho recuperado termina", () => {
  const result = simulate(0x5eed, 200000);
  assert.equal(result.steps, 200000);
  for (const fault of ["lost", "duplicate", "restart", "offline", "channel", "clock"])
    assert.ok(result.faults[fault] > 0, fault);
  assert.ok(result.completed > 0);
  console.log(JSON.stringify(result));
});

test("ordens exaustivas limitadas usam dois workers, dois eventos e um cartão", () => {
  const result = enumerate();
  assert.equal(result.paths, 40320);
  assert.equal(result.actions, 8);
  assert.ok(result.transitions >= 40320 * 8);
  console.log(JSON.stringify(result));
});

test("o simulador rejeita uma central que recusa reproduções válidas de recibo", () => {
  const original = World.prototype.call;
  World.prototype.call = function (type: string, ...args: any[]) {
    const run = this.view.get("runs", args[0])!;
    if (type === "finish" && run?.last_issued && run.issued === null)
      throw new AuthError("recusa intencional de uma reprodução válida");
    return original.call(this, type, ...args);
  };
  try {
    assert.throws(() => simulate(24301, 2048), /semente/);
  } finally {
    World.prototype.call = original;
  }
});

test("as verificações de resposta rejeitam uma rodada no lane de outro assunto", () => {
  const w = new World();
  w.call("createCard", {
    key: "q",
    kind: "ask",
    title: "escolha",
    options: ["alfa", "beta"],
    rule: "one",
    lane: "#1",
    grp: "shared",
    source: "app",
  });
  w.call("answer", 1, { choice: 0 });
  const log = structuredClone(w.log);
  for (const f of log) for (const c of f.changes) if (c.table === "runs" && c.row) c.row.lane = "wrong-lane";
  assert.throws(() => invariants(evolve(new World().view, log.slice(1)), log), /assunto original/);
});

test("a simulação pega vencimentos omitidos que deixam trabalho adiado encalhado", () => {
  const original = World.prototype.act;
  World.prototype.act = function (input) {
    const value = original.call(this, input);
    this.log = this.log.map((f) => ({ ...f, changes: f.changes.filter((c) => c.table !== "due") }));
    this.view.close();
    this.view = evolve(empty(), this.log);
    return value;
  };
  try {
    assert.throws(() => simulate(24301, 2048));
  } finally {
    World.prototype.act = original;
  }
});
