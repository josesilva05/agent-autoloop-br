// Modos de falha: um SIGKILL perde um commit confirmado, deixa meio recibo ou corrompe o SQLite; a reprodução diverge da
// projeção persistida; retransmitir depois de uma resposta incerta registra ou despacha um evento duas vezes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { crashCheck } from "./crash.ts";
test("1000 SIGKILL reais preservam logs e projeções já gravados", async () => {
  const result = await crashCheck(1000, 0xc0ffee);
  console.log(JSON.stringify(result));
  assert.equal(result.kills, 1000);
  assert.ok(result.acknowledged > 1000);
});
