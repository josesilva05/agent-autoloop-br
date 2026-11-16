// Modos de falha: o worker não consegue rodar o ps de jeito nenhum (o sandbox proíbe, ou ele está ausente ou não é
// executável) e reporta uma rodada ainda em execução como concluída porque a consulta que falhou foi lida como "o
// processo se foi"; ou, sem conseguir olhar, segura para sempre uma rodada travada ou parada porque seu estouro de tempo
// e sua parada esperam uma observação que nunca chega; ou segura o resultado de uma rodada que terminou, parando um grupo
// de processos no qual não consegue ver nada que tenha sobrado; ou, sem conseguir ver um grupo que ele mesmo parou porque
// o turno acabou, joga fora a resposta que o turno deu e a central refaz o trabalho. Ou, esperando por uma consulta lenta
// (o PowerShell leva mais de um segundo para iniciar no Windows), segura a central que compartilha seu processo, de modo
// que o estado, o stream e as respostas aos cartões travam enquanto qualquer rodada estiver em execução.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-worker-look-"));
const home = join(scratch, "home");
const project = join(scratch, "project");
const bin = join(scratch, "bin");
mkdirSync(home, { recursive: true });
mkdirSync(project, { recursive: true });
mkdirSync(bin, { recursive: true });
process.env.AGENT_AUTOLOOP_HOME = home;
process.env.SHELL = "/bin/sh";
after(() => rmSync(scratch, { recursive: true, force: true }));
const { createWorker } = await import("../worker/worker.ts");

/** Coloca um ps na frente do real que responde à pergunta do jeito que um processo que se foi responde. */
function psSaysGone() {
  writeFileSync(join(bin, "ps"), `#!/bin/sh\nexit 1\n`, { mode: 0o755 });
  chmodSync(join(bin, "ps"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
}

/**
 * Coloca um ps na frente do real que falha do jeito que um que não consegue rodar falha. Um arquivo sem o bit de execução
 * não serviria: a consulta o pula e encontra o ps real mais adiante no PATH, então fora de um sandbox o teste não verificaria nada.
 */
function psCannotRun() {
  writeFileSync(join(bin, "ps"), `#!/bin/sh\nexit 126\n`, { mode: 0o755 });
  chmodSync(join(bin, "ps"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
}

function workerThatReports(results: any[], job: any, now: () => number = Date.now) {
  let claimed = false;
  return createWorker({
    name: "test",
    wait: 0,
    now,
    hub: {
      work: async () => {
        const next = claimed ? null : job;
        claimed = true;
        return { job: next, cancel: [] };
      },
      started: async () => ({}),
      result: async (_run: number, _token: string, body: unknown) => {
        results.push(body);
        return {};
      },
    } as any,
  });
}

/** Cada rodada recebe seu próprio número para que o arquivo de saída de uma nunca seja lido como o de outra. */
function jobFor(run: number, seconds: number, timeout?: number) {
  return {
    run,
    token: "test-token",
    attempt: 1,
    session: null,
    askFirst: [],
    rule: { name: "lookup", cwd: project, prompt: "Leia a entrada." },
    agent: {
      id: "a",
      name: "Agent",
      use: "command",
      access: "edit",
      timeout,
      command: ["/bin/sh", "-c", `sleep ${seconds}`],
    },
    context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  };
}

test("olhar o processo de uma rodada não segura nada mais no processo", async () => {
  writeFileSync(join(bin, "ps"), `#!/bin/sh\nsleep 0.5\nexit 1\n`, { mode: 0o755 });
  chmodSync(join(bin, "ps"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  const results: any[] = [];
  const worker = workerThatReports(results, jobFor(18, 2));
  await worker.tick();
  let beats = 0;
  const beat = setInterval(() => beats++, 20);
  try {
    await worker.tick();
  } finally {
    clearInterval(beat);
  }
  assert.ok(beats >= 10, `o processo ficou seguro enquanto olhava: ${beats} batidas em meio segundo`);
});

test("uma rodada cujo processo se foi é reportada como concluída", async () => {
  psSaysGone();
  const results: any[] = [];
  const worker = workerThatReports(results, jobFor(12, 0));
  for (let i = 0; i < 100 && !results.length; i++) {
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(results.length, 1, "a rodada concluída nunca foi reportada");
});

test("uma rodada que se foi sem saída, e um grupo que não pode ser consultado, é reportada sem esperar", async () => {
  // Ainda está realmente em execução, então não há arquivo de saída seja qual for a velocidade da máquina: só a consulta diz que se foi.
  psSaysGone();
  const results: any[] = [];
  const worker = workerThatReports(results, jobFor(16, 1));
  for (let i = 0; i < 100 && !results.length; i++) {
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(results.length, 1, "ela ficou segurada");
});

test("uma rodada que falhou, e um grupo que não pode ser consultado, é reportada sem esperar", async () => {
  psCannotRun();
  const results: any[] = [];
  const job = jobFor(17, 0);
  job.agent.command = ["/bin/sh", "-c", "echo boom >&2; exit 3"];
  const worker = workerThatReports(results, job);
  for (let i = 0; i < 100 && !results.length; i++) {
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(results.length, 1, "ela ficou segurada");
  assert.match(results[0].error, /código de saída 3: boom/);
});

test("uma rodada que não pode ser consultada não é reportada como concluída", async () => {
  psCannotRun();
  const results: any[] = [];
  const worker = workerThatReports(results, jobFor(11, 30));
  for (let i = 0; i < 60 && !results.length; i++) {
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(results.length, 0, "a rodada foi reportada antes de terminar");
  process.kill(-JSON.parse(readFileSync(join(home, "worker", "runs", "11-1", "entry.json"), "utf8")).pid, "SIGKILL");
});

test("uma rodada travada que não pode ser consultada ainda estoura o tempo e é reportada", async () => {
  psCannotRun();
  const results: any[] = [];
  let moment = Date.now();
  const worker = workerThatReports(results, jobFor(15, 30, 1), () => moment);
  await worker.tick();
  await worker.tick();
  assert.equal(results.length, 0, "a rodada foi reportada antes do seu estouro de tempo");
  moment += 61_000;
  await worker.tick();
  moment += 11_000;
  for (let i = 0; i < 20 && !results.length; i++) {
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(results.length, 1, "a rodada que estourou o tempo nunca foi reportada");
});

test("uma rodada que não pode ser consultada é reportada assim que seu arquivo de saída aparece", async () => {
  psCannotRun();
  const results: any[] = [];
  const worker = workerThatReports(results, jobFor(14, 0));
  for (let i = 0; i < 100 && !results.length; i++) {
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(results.length, 1, "a rodada concluída nunca foi reportada");
});

const runs = join(home, "worker", "runs");

/** Um filho num grupo de processos só dele, do jeito que o shell de uma rodada é iniciado. */
function ownGroup() {
  const child = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
  const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.unref();
  const pid = child.pid!;
  return {
    pid,
    gone,
    kill: () => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    },
  };
}

/** Uma rodada que já foi parada, de modo que só falta confirmar que seu grupo se foi. */
function stoppedRun(run: number, pid: number, how: object = { why: "cancel" }) {
  const dir = join(runs, `${run}-1`);
  mkdirSync(dir, { recursive: true });
  const entry = {
    run,
    token: "test-token",
    attempt: 1,
    job: jobFor(run, 30),
    dir,
    prompt: "p",
    turn: 1,
    session: "s",
    resume: null,
    repairs: 0,
    triedFresh: false,
    pid,
    launchedAt: Date.now() - 60_000,
    stopping: Date.now() - 20_000,
    ...how,
  };
  writeFileSync(join(dir, "entry.json"), JSON.stringify(entry));
  return () => rmSync(dir, { recursive: true, force: true });
}

/** Não pega nada: estes testes são sobre rodadas que já estão em mãos. */
function idleWorker(results: any[]) {
  return createWorker({
    name: "test",
    wait: 0,
    hub: {
      work: async () => ({ job: null, cancel: [] }),
      started: async () => ({}),
      result: async (_run: number, _token: string, body: unknown) => {
        results.push(body);
        return {};
      },
    } as any,
  });
}

test("uma rodada parada cujo grupo não pode ser visto é reportada como falha, nunca como cancelada", async () => {
  psCannotRun();
  const group = ownGroup();
  const clean = stoppedRun(18, group.pid);
  const results: any[] = [];
  const originalKill = process.kill;
  try {
    process.kill = ((target: number, signal?: string | number) => {
      if (target === -group.pid) {
        const error = new Error("operation not permitted") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return originalKill(target, signal as NodeJS.Signals);
    }) as typeof process.kill;
    await idleWorker(results).tick();
  } finally {
    process.kill = originalKill;
    group.kill();
    clean();
  }
  assert.equal(results.length, 1, "a rodada nunca foi entregue");
  assert.equal(
    results[0].outcome,
    "failed",
    "cancelled liberaria o assunto enquanto um processo ainda pode estar rodando nele",
  );
  assert.match(String(results[0].error), /não confirmei o fim do grupo/, "o motivo tem de dizer o que não foi visto");
});

test("uma rodada parada cujo grupo se foi é cancelada mesmo quando o ps não consegue rodar", async () => {
  psCannotRun();
  const group = ownGroup();
  group.kill();
  await group.gone;
  const clean = stoppedRun(19, group.pid);
  const results: any[] = [];
  try {
    await idleWorker(results).tick();
  } finally {
    clean();
  }
  assert.equal(results[0]?.outcome, "cancelled", "um grupo que se foi é uma parada que pode ser confirmada");
});

test("uma rodada parada cujo grupo ainda está lá não é entregue até ele se ir", async () => {
  psCannotRun();
  const group = ownGroup();
  const clean = stoppedRun(20, group.pid);
  const results: any[] = [];
  const worker = idleWorker(results);
  try {
    await worker.tick();
    assert.equal(results.length, 0, "reportada antes de o grupo ser visto como ido");
    await group.gone;
    await worker.tick();
  } finally {
    clean();
    group.kill();
  }
  assert.equal(results[0]?.outcome, "cancelled", "a parada foi confirmada assim que o grupo se foi");
});

test("uma rodada parada porque seu turno acabou mantém sua resposta quando seu grupo não pode ser visto", async () => {
  psCannotRun();
  const group = ownGroup();
  const clean = stoppedRun(21, group.pid, { why: "finished", finishedAt: Date.now() - 30_000 });
  writeFileSync(join(runs, "21-1", "stdout-1.log"), "Concluído");
  const results: any[] = [];
  const originalKill = process.kill;
  try {
    process.kill = ((target: number, signal?: string | number) => {
      if (target === -group.pid) {
        const error = new Error("operation not permitted") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return originalKill(target, signal as NodeJS.Signals);
    }) as typeof process.kill;
    await idleWorker(results).tick();
  } finally {
    process.kill = originalKill;
    group.kill();
    clean();
  }
  assert.equal(results.length, 1, "a rodada nunca foi entregue");
  assert.notEqual(results[0].outcome, "failed", "uma falha é tentada de novo e o trabalho seria feito duas vezes");
  assert.match(String(results[0].summary), /Concluído/);
});
