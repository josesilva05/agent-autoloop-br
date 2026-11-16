// O que um worker guarda das rodadas concluídas. Casos de falha: saída antiga fica por todo o tempo em que o worker roda,
// porque só é limpa quando ele inicia, ou fica para sempre num loop próprio que move o worker volta a volta; a pasta de uma
// rodada ainda em mãos, ou uma que ainda não é velha o bastante, vai embora; uma pasta que não pode ser limpa
// para o worker ou o resto da limpeza.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("worker-tidy");
const { createWorker } = await import("../worker/worker.ts");

const runs = join(home, "worker", "runs");
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 3600_000);
const age = (path: string, days: number) => utimesSync(path, daysAgo(days), daysAgo(days));

/** A pasta de uma rodada concluída, tantos dias depois de ela ter terminado. */
function finished(name: string, days: number) {
  const dir = join(runs, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "stdout-1.log"), "O que ele disse");
  age(dir, days);
  return dir;
}

const quiet = () => ({
  asked: 0,
  async work() {
    this.asked += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { job: null, cancel: [] };
  },
  async started() {
    return { ok: true };
  },
  async result() {
    return { rejected: [] };
  },
});

async function until(done: () => boolean) {
  const end = Date.now() + 15_000;
  while (!done()) {
    if (Date.now() > end) assert.fail("tempo esgotado esperando");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a saída antiga vai embora enquanto o worker continua rodando, não só quando ele inicia", async () => {
  const hub = quiet();
  let clock = Date.now();
  const worker = createWorker({ hub: hub as any, name: "w1", wait: 0, now: () => clock });
  const stop = new AbortController();
  const running = worker.run(stop.signal);
  await until(() => hub.asked > 0);
  const old = finished("1-1", 15);
  const asked = hub.asked;
  await until(() => hub.asked > asked + 2);
  assert.equal(existsSync(old), true, "limpa no início, então não de novo imediatamente");
  clock += 60 * 60_000 + 1;
  await until(() => !existsSync(old));
  stop.abort();
  await running;
});

test("um loop próprio, andando volta a volta, também faz a limpeza", async () => {
  let clock = Date.now();
  const worker = createWorker({ hub: quiet() as any, name: "w1", wait: 0, now: () => clock });
  await worker.tick();
  const old = finished("7-1", 15);
  await worker.tick();
  assert.equal(existsSync(old), true, "limpa na primeira volta, então não de novo imediatamente");
  clock += 60 * 60_000 + 1;
  await worker.tick();
  assert.equal(existsSync(old), false);
});

test("só vão embora as pastas de rodadas concluídas velhas o bastante", () => {
  const worker = createWorker({ hub: quiet() as any, name: "w1", wait: 0 });
  const old = finished("2-1", 15);
  const recent = finished("3-1", 13);
  const inHand = finished("4-1", 15);
  writeFileSync(join(inHand, "entry.json"), "{}");
  age(inHand, 15);
  worker.tidy();
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(recent), true);
  assert.equal(existsSync(inHand), true);
  rmSync(inHand, { recursive: true });
});

test("uma pasta que não pode ser limpa é dita e deixa as outras irem embora", { skip: process.getuid!() === 0 }, () => {
  const lines: string[] = [];
  const worker = createWorker({ hub: quiet() as any, name: "w1", wait: 0, log: (line) => lines.push(line) });
  const stuck = finished("5-1", 15);
  const locked = join(stuck, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  age(stuck, 15);
  const other = finished("6-1", 15);
  try {
    assert.doesNotThrow(() => worker.tidy());
    assert.equal(existsSync(other), false);
    assert.equal(existsSync(stuck), true);
    assert.ok(lines.some((line) => line.includes("5-1")));
  } finally {
    chmodSync(locked, 0o700);
    rmSync(stuck, { recursive: true });
  }
});
