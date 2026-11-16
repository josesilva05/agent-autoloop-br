// Modos de falha: o verificador de morte súbita em processo real deixa passar divergência entre log e projeção, ou deixa
// processos mortos e bancos de dados para trás.
import assert from "node:assert/strict";
import { test } from "node:test";
import { crashCheck } from "../sim/crash.ts";
test("três mortes súbitas com semente em processo real exercitam a recuperação nas verificações rápidas", async () => {
  assert.equal((await crashCheck(3, 0xc0ffee)).kills, 3);
});
