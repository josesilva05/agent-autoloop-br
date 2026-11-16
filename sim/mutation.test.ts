// Modos de falha: os testes de segurança passam depois que uma guarda de autorização, deduplicação, fila, recibo,
// vencimento, reprodução ou transação é removida; o relatório de mutação conta erros de sintaxe como detecções ou omite em
// silêncio as mutações que sobreviveram; uma mudança em outro lugar deixa uma mutação não quebrar nada que importe, e um
// índice abaixo de 100 por cento deixa isso passar despercebido.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mutate } from "./mutate.ts";
test("toda mutação executável do kernel é detectada", () => {
  const result = mutate();
  console.log(JSON.stringify(result));
  assert.equal(result.invalid.length, 0);
  assert.deepEqual(result.survived, []);
});
