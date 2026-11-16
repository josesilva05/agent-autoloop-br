// Listar rodadas anteriores com `agent-autoloop runs`. Modos de falha: só a página mais nova é lida, então as rodadas de ontem
// de uma regra nunca aparecem e o `why` não recebe o número delas; uma rodada ainda em curso, ou uma antiga ainda não assentada
// que a central acrescenta à primeira página, é listada duas vezes ou fora de ordem; a próxima página pula ou repete uma rodada;
// um número de página que não é um chega à central como um endereço inválido em vez de dizer como se usa o comando.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { findRuns, runsText } from "../cli/runs.ts";

const now = "2026-11-10T02:00:00.000Z";
const run = (id: number, rule: string, state = "done") => ({
  id,
  rule,
  state,
  attempts: 0,
  claimedAt: now,
  finishedAt: state === "claimed" || state === "queued" ? null : now,
  notBefore: null,
  summary: `Resultado da rodada ${id}`,
  error: "",
  events: [],
});
const ids = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, i) => from - i);

/** Uma central com `total` rodadas, das mais novas para as mais antigas, em páginas de 60 do jeito que /v1/state as dá; cada sétima é da regra B. */
function hub(total: number, active: ReturnType<typeof run>[] = []) {
  const asked: (number | undefined)[] = [];
  const all = ids(total, 1).map((id) => run(id, id % 7 === 0 ? "B" : "A"));
  const page = async (before?: number) => {
    asked.push(before);
    const older = all.filter((one) => before === undefined || one.id < before);
    const shown = older.slice(0, 60);
    const hasMore = older.length > 60;
    const extra = before === undefined ? active.filter((one) => !shown.some((s) => s.id === one.id)) : [];
    const runs = [...shown.map((one) => active.find((a) => a.id === one.id) ?? one), ...extra].sort(
      (a, b) => b.id - a.id,
    );
    return { now, timezone: "Asia/Shanghai", runs, hasMore, nextBefore: hasMore ? shown[59].id : null };
  };
  return { page, asked };
}

test("as rodadas de uma regra anteriores à primeira página são encontradas, e a página seguinte começa depois da última mostrada", async () => {
  const { page } = hub(300);
  const found = await findRuns(page, { rule: "B" });
  assert.deepEqual(
    found.runs.map((one) => one.id),
    ids(300, 1)
      .filter((id) => id % 7 === 0)
      .slice(0, 20),
  );
  assert.equal(found.more, found.runs.at(-1)!.id);
  const next = await findRuns(page, { rule: "B", before: found.more! });
  assert.deepEqual(
    next.runs.map((one) => one.id),
    ids(found.more! - 1, 1)
      .filter((id) => id % 7 === 0)
      .slice(0, 20),
  );
  const last = await findRuns(page, { rule: "B", before: next.more! });
  assert.deepEqual(
    last.runs.map((one) => one.id),
    [14, 7],
  );
  assert.equal(last.more, null);
});

test("--before começa a lista naquele ponto", async () => {
  const { page, asked } = hub(100);
  const found = await findRuns(page, { before: 50 });
  assert.equal(asked[0], 50);
  assert.deepEqual(
    found.runs.map((one) => one.id),
    ids(49, 30),
  );
});

test("rodadas ainda em curso ficam com o status, e uma antiga não assentada que a primeira página acrescenta é listada uma vez, em ordem", async () => {
  const { page } = hub(130, [run(130, "A", "claimed"), run(129, "A", "queued"), run(5, "B", "unknown")]);
  const found = await findRuns(page, { rule: "B", want: 100 });
  const shown = found.runs.map((one) => one.id);
  assert.deepEqual(shown, [...ids(130, 1).filter((id) => id % 7 === 0), 5]);
  assert.equal(new Set(shown).size, shown.length);
  const all = await findRuns(page, { want: 3 });
  assert.deepEqual(
    all.runs.map((one) => one.id),
    [128, 127, 126],
  );
});

test("cada rodada é uma entrada com o número, como terminou e a regra; more diz como continuar", async () => {
  const { page } = hub(30);
  const text = runsText(await findRuns(page, { rule: "A", want: 2 }), { rule: "A", color: false, columns: 100 });
  assert.match(text, /#30 +Concluído +A\n +Resultado da rodada 30/);
  assert.match(text, /#29 +Concluído +A/);
  assert.match(text, /agent-autoloop runs A --before 29/);
  const none = runsText(await findRuns(page, { rule: "C" }), { rule: "C", color: false, columns: 100 });
  assert.match(none, /"C" não tem rodadas concluídas/);
});

const program = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-runs-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("um --before que não é um número de rodada diz como se usa em vez de perguntar à central", async () => {
  for (const before of ["x", "0", "1.5"]) {
    const ran = await promisify(execFile)(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", program, "runs", "--before", before],
      { env: { ...process.env, AGENT_AUTOLOOP_HOME: join(dir, "home") } },
    ).then(
      () => ({ code: 0, stderr: "" }),
      (error) => error as { code: number; stderr: string },
    );
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /Uso: agent-autoloop runs/);
  }
});
