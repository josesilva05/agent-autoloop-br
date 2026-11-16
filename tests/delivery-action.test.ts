// Modos de falha do Ship: um commit posterior, só de documentos, suprime uma publicação de código já na fila; um endpoint
// fora de saúde autoriza pular a publicação; a action importa uma cópia mutável do motor feita pelo projeto ou aceita um alvo que não é um commit.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decideShip } from "../plugins/delivery/action.ts";
test("o Ship compara a versão em produção com o alvo, e só mudanças de runtime podem substituí-la", async () => {
  const calls: any[] = [];
  const required = (a: string, b: string) => {
    calls.push([a, b]);
    return a === "live" || b === "new-code";
  };
  assert.deepEqual(decideShip("target", "docs-after", { sha: "live", release: "live" }, required), {
    release: true,
    superseded: false,
  });
  assert.deepEqual(calls, [
    ["live", "target"],
    ["target", "docs-after"],
  ]);
  assert.deepEqual(decideShip("target", "new-code", { sha: "target", release: "target" }, required), {
    release: false,
    superseded: true,
  });
  assert.deepEqual(decideShip("target", "target", null, required), { release: true, superseded: false });
});
