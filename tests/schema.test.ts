// Modos de falha: schemas publicados aceitam uma fonte que se passa por outra, recibos malformados ou credenciais nos
// dados do evento; o contrato de protocolo se distancia dos validadores, e a conformidade aceita um servidor que abre
// a porta errada. A estrutura obrigatória do job e nomes herdados de objetos não podem escapar das verificações de
// schema; os limites Unicode contam pontos de código. Um notice fyi deve aceitar só um booleano opcional, sem afrouxar
// os limites do notice nem mudar os recibos de pergunta.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSchema } from "../protocol/schema.ts";
import { parseEvent, parseResult } from "../protocol/validate.ts";

test("recibos de notice aceitam um booleano opcional fyi e mantêm todos os outros limites", () => {
  const notice = { title: "Já configurado", text: "verificar todos os dias às nove", key: "daily-check" };
  for (const item of [notice, { ...notice, fyi: true }, { ...notice, fyi: false }]) {
    const result = { outcome: "done", notice: [item] };
    assert.deepEqual(parseResult(result), result);
    assert.deepEqual(checkSchema("result", result), []);
  }
  for (const item of [
    ...[null, 0, 1, "true", [], {}].map((fyi) => ({ ...notice, fyi })),
    { ...notice, fyi: true, title: "" },
    { ...notice, fyi: true, title: "x".repeat(201) },
    { ...notice, fyi: true, text: " " },
    { ...notice, fyi: true, text: "x".repeat(4001) },
    { ...notice, fyi: true, key: "x".repeat(101) },
    { ...notice, fyi: true, unknown: true },
  ]) {
    const result = { outcome: "done", notice: [item] };
    assert.throws(() => parseResult(result), /notice/);
    assert.ok(checkSchema("result", result).length);
  }
  const tooMany = { outcome: "done", notice: Array(11).fill({ ...notice, fyi: true }) };
  assert.throws(() => parseResult(tooMany), /notice/);
  assert.ok(checkSchema("result", tooMany).length);
  const ask = { outcome: "done", ask: [{ ...notice, options: ["continuar", "pausar"], fyi: true }] };
  assert.throws(() => parseResult(ask), /ask/);
  assert.ok(checkSchema("result", ask).length);
});

test("os schemas de protocolo concordam com os limites de eventos e recibos", () => {
  for (const input of [
    { id: "one", type: "app.changed" },
    { id: " ", type: "app.changed", summary: null },
    { id: "one", type: "app.changed", source: "other" },
    { id: 7, type: "invalid" },
    { id: "one", type: "bad type" },
  ]) {
    let accepted = true;
    try {
      parseEvent(input);
    } catch {
      accepted = false;
    }
    assert.equal(checkSchema("event", input).length === 0, accepted);
  }
  for (const input of [
    { outcome: "done" },
    { outcome: "done", events: [{ id: "x", type: "app.changed" }] },
    { outcome: "unknown" },
    { outcome: "done", ask: [{ title: "escolha", text: "conteúdo", options: ["um"] }] },
    { outcome: "done", ask: [{ title: "escolha", text: "conteúdo", options: ["um", "dois"], recommend: 2 }] },
    { outcome: "done", later: [{ key: "k", at: "badZ", about: "depois" }] },
  ]) {
    let accepted = true;
    try {
      parseResult(input);
    } catch {
      accepted = false;
    }
    assert.equal(checkSchema("result", input).length === 0, accepted);
  }
});

test("as verificações de schema rejeitam nomes herdados e jobs ou cartões de pergunta incompletos", () => {
  assert.ok(checkSchema("event", { id: "x", type: "one", constructor: "unexpected" }).length);
  assert.ok(checkSchema("job", { run: 1, token: "t", rule: {}, agent: {}, context: {} }).length);
  assert.ok(
    checkSchema("card", {
      id: 1,
      version: 1,
      kind: "ask",
      state: "open",
      title: "escolha",
      text: "conteúdo",
      options: [],
    }).length,
  );
  assert.throws(() => checkSchema("constructor", {}));
});

test("os limites de texto publicados contam caracteres Unicode, incluindo pontos de código astrais", () => {
  const event = { id: "x", type: "one", summary: "😀".repeat(200) };
  assert.deepEqual(checkSchema("event", event), []);
  assert.equal(parseEvent(event).summary, event.summary);
  assert.deepEqual(checkSchema("tell-source", { key: "unicode", text: "😀".repeat(20000) }), []);
  const receipt = { outcome: "done", summary: "😀".repeat(500) };
  assert.deepEqual(checkSchema("result", receipt), []);
  assert.equal(parseResult(receipt).summary, receipt.summary);
});

test("usage deve ser um objeto de valores finitos e não negativos", () => {
  for (const usage of [[1], { cost: -1 }, { cost: Infinity }, { input: NaN }]) {
    assert.throws(() => parseResult({ outcome: "done", usage }));
    assert.ok(checkSchema("result", { outcome: "done", usage }).length);
  }
});

test("os horários dos timers são datas de calendário reais no formato ISO documentado", () => {
  for (const at of ["2000Z", "2026-02-30T10:00:00Z", "2026-01-01T25:00:00Z"]) {
    const result = { outcome: "done", later: [{ key: "later", at, about: "reverificar" }] };
    assert.throws(() => parseResult(result));
    assert.ok(checkSchema("result", result).length);
  }
  const result = { outcome: "done", later: [{ key: "later", at: "2028-02-29T10:00:00+08:00", about: "reverificar" }] };
  assert.doesNotThrow(() => parseResult(result));
  assert.deepEqual(checkSchema("result", result), []);
});
