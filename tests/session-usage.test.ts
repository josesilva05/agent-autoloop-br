// Evita contagem dupla em reinicialização/reexecução, uso negativo depois do reset de um contador, e uso ou preços zerados
// inventados quando uma sessão retomada não tem uma linha de base confiável; evita que o total de uma sessão salvo sob um
// adapter passe a ser de outro. Nenhum modelo, sessão de usuário ou central viva é usado.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setup } from "./helpers.ts";
setup("session-usage");
const { loadUsage, saveUsage, usageDelta } = await import("../worker/usage.ts");

const first = { input: 52968, output: 126, cached: 26240 };
const total = { input: 108943, output: 207, cached: 80384 };
const delta = { input: 55975, output: 81, cached: 54144 };

test("a linha de base persistida da inicialização sobrevive a avançar o checkpoint da sessão e a reexecutar", () => {
  saveUsage("codex", "session", first);
  const launch = JSON.parse(JSON.stringify({ baseline: loadUsage("codex", "session") }));
  saveUsage("codex", "session", total);
  assert.deepEqual(usageDelta(total, launch.baseline), delta);
  assert.deepEqual(usageDelta(total, launch.baseline), delta);
  assert.deepEqual(loadUsage("codex", "session"), total);
  assert.equal(loadUsage("other", "session"), undefined);
});

test("linhas de base desconhecidas e resets ficam ausentes, não viram uso acumulado nem zero", () => {
  assert.equal(usageDelta(total, undefined), undefined);
  assert.equal(usageDelta(first, total), undefined);
  assert.equal(usageDelta({ input: 5 }, { output: 2 }), undefined);
  assert.deepEqual(usageDelta({ input: 5 }, { input: 5 }), { input: 0 });
  assert.deepEqual(usageDelta(total, first), delta);
});

test("sessões novas e reescritas de recibo contribuem cada uma só com seu incremento", () => {
  assert.deepEqual(usageDelta(first, { input: 0, output: 0, cached: 0, cost: 0 }), first);
  const repaired = { input: total.input + 100, output: total.output + 10, cached: total.cached + 50 };
  assert.deepEqual(usageDelta(repaired, total), { input: 100, output: 10, cached: 50 });
});
