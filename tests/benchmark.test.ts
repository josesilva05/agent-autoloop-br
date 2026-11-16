// Modos de falha: requisições concluídas ou de keep-alive se passando por long polls concorrentes; resposta com falha contada
// como sucesso; trabalho de cron reivindicado antes do evento medido, travando a espera de prontidão e invalidando a medição do
// despacho; um percentil deslocado em um, escondendo um outlier lento ou fazendo um p99 de poucas amostras parecer baixo; um caso
// lento sem nenhuma amostra, ou que roda além do orçamento e deixa expirar os polls de que depende.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { checkPolls, observe, dispatchLatency, percentile, timed } from "../scripts/metrics.ts";

test("mil requisições concluídas não podem substituir mil requisições aguardando", () => {
  assert.throws(() => checkPolls({ active: 0, peak: 1 }, 1000), /1000/);
  assert.throws(() => checkPolls({ active: 999, peak: 999 }, 1000), /1000/);
  assert.throws(() => checkPolls({ active: 1000, peak: 1000 }, 999), /1000/);
  checkPolls({ active: 1000, peak: 1000 }, 1000);
});

test("um percentil é a amostra até onde a parcela fica, e poucas amostras não escondem a mais lenta", () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1).reverse();
  assert.equal(percentile(hundred, 0.5), 50);
  assert.equal(percentile(hundred, 0.99), 99);
  assert.equal(percentile([3, 1, 2], 0.5), 2);
  assert.equal(percentile([3, 1, 2], 0.99), 3);
  assert.equal(percentile([7], 0.99), 7);
});

test("a medição para na contagem ou no orçamento, e sempre coleta uma amostra", async () => {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const seen: number[] = [];
  assert.equal((await timed(3, 60_000, async (i) => void seen.push(i))).length, 3);
  assert.deepEqual(seen, [0, 1, 2]);
  assert.equal((await timed(100, 0, () => pause(1))).length, 1);
  // Uma máquina ocupada pode esticar qualquer pausa além do orçamento inteiro, então quantas cabem não diz nada. Nenhuma pode começar depois dele.
  const slow = await timed(1000, 30, () => pause(10));
  assert.ok(slow.length < 1000, `${slow.length}`);
  const beforeTheLast = slow.slice(0, -1).reduce((total, ms) => total + ms, 0);
  assert.ok(beforeTheLast < 30, `${beforeTheLast}`);
  assert.ok(slow.every((ms) => ms >= 5));
});

test("uma rejeição antecipada de requisição continua observável até o lote ser consumido", async () => {
  const failure = new Error("a conexão caiu");
  const pending = observe(Promise.reject(failure));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await pending, { status: "rejected", reason: failure });
});

test("a latência de despacho inclui acordar um worker que já estava aguardando", async () => {
  let waiting = false;
  let finish: (value: unknown) => void = () => {};
  const request = async (path: string) => {
    if (path.startsWith("/v1/work")) {
      waiting = true;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    assert.equal(waiting, true);
    setTimeout(() => finish({ job: { run: 1 } }), 55);
    return {};
  };
  const measured = await dispatchLatency(request, async () => assert.equal(waiting, true), 1);
  assert.ok(measured.ms >= 40);
  assert.equal(measured.job.run, 1);
});

test("o servidor de benchmark não tem trabalho agendado concorrendo com os eventos medidos", async () => {
  const home = mkdtempSync(join(tmpdir(), "agent-autoloop-benchmark-setup-"));
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "../scripts/benchmark.ts"), "--server"],
    {
      env: {
        ...process.env,
        AGENT_AUTOLOOP_HOME: home,
        AGENT_AUTOLOOP_RULES: join(import.meta.dirname, "rules.fixture.json"),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  try {
    await once(child.stdout!, "data");
    const db = new DatabaseSync(join(home, "hub.db"), { readOnly: true });
    try {
      const row = db.prepare("SELECT count(*) AS count FROM projections WHERE collection='schedules'").get()!;
      assert.equal(row.count, 0, "um tick de cron pode concluir um work poll antes do evento medido");
    } finally {
      db.close();
    }
  } finally {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    rmSync(home, { recursive: true, force: true });
  }
});
