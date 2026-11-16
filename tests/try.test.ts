// `try` contra uma central real, a partir do `init`. Casos de falha: uma falha de antes deste try é relatada como sendo deste
// try, ou não é dita de jeito nenhum e parece que nada está acontecendo; uma falha de uma rodada que já esperava não é
// relatada; uma pergunta ainda aberta de antes passa despercebida porque nenhum cartão novo chega para ela, então o try
// espera os seus cinco minutos inteiros.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { attemptsOf, newFailure } from "../cli/try.ts";

const bin = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
const fence = "```";
const ASKS = `#!/bin/sh
cat <<'END'
Fiz uma pergunta

${fence}agent-autoloop
{"ask":[{"title":"Execução de teste: escolha uma cor","text":"Esta é uma execução de teste; qualquer opção serve.","options":["Azul","Verde"],"key":"try-color"}]}
${fence}
END
`;
const FAILS = "#!/bin/sh\necho boom >&2\nexit 1\n";

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

/** Uma instalação descartável rodando `up`, com este script como Agent e substitutos para o que quer que mostre uma notificação. */
async function install(t: { after: (done: () => unknown) => void }, agent: string) {
  const home = mkdtempSync(join(tmpdir(), "agent-autoloop-try-"));
  const standIns = join(home, "stand-ins");
  mkdirSync(standIns);
  for (const name of ["launchctl", "osascript", "notify-send"]) {
    writeFileSync(join(standIns, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  const script = join(home, "agent.sh");
  writeFileSync(script, agent, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_AUTOLOOP_HOME: home,
    DISPLAY: ":99",
    PATH: `${standIns}:${process.env.PATH}`,
    SHELL: "/bin/sh",
  };
  delete env.AGENT_AUTOLOOP_RULES;
  delete env.AGENT_AUTOLOOP_PUBLIC_URL;
  const program = ["--disable-warning=ExperimentalWarning", bin];
  const port = await freePort();
  const init = spawnSync(
    process.execPath,
    [...program, "init", "--no-service", "--command", script, "--port", String(port)],
    { env, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(init.status, 0, init.stderr);
  const up = spawn(process.execPath, [...program, "up"], { env, stdio: "ignore" });
  t.after(async () => {
    up.kill("SIGTERM");
    await new Promise((resolve) => up.once("exit", resolve));
    rmSync(home, { recursive: true, force: true });
  });
  const { url } = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  for (let i = 0; i < 100; i++) {
    const ready = await fetch(`${url}/healthz`).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  /** Roda o `try` como um Agent rodaria, sem ninguém num terminal, e o interrompe no limite se ainda estiver em curso. */
  return (limit: number) =>
    new Promise<{ code: number | null; out: string; err: string; stillGoing: boolean }>((resolve) => {
      const child = spawn(process.execPath, [...program, "try"], { env, stdio: ["ignore", "pipe", "pipe"] });
      let [out, err, stillGoing] = ["", "", false];
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      const timer = setTimeout(() => {
        stillGoing = true;
        child.kill();
      }, limit);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ code, out, err, stillGoing });
      });
    });
}

test("um segundo try encontra a pergunta ainda aberta do primeiro", async (t) => {
  const runTry = await install(t, ASKS);
  const first = await runTry(20_000);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /#1 Execução de teste: escolha uma cor/);
  const second = await runTry(20_000);
  assert.equal(second.stillGoing, false, "ele deve encontrar o cartão aberto, não esperar os cinco minutos inteiros");
  assert.equal(second.code, 0, second.err);
  assert.match(second.out, /#1 Execução de teste: escolha uma cor/);
});

test("uma falha de antes não é deste try: ele diz quando é a nova tentativa e espera por ela", async (t) => {
  const runTry = await install(t, FAILS);
  const first = await runTry(20_000);
  assert.equal(first.code, 1);
  assert.match(first.err, /O Agent falhou: código de saída 1: boom/);
  const second = await runTry(4_000);
  assert.equal(second.stillGoing, true, `a falha antiga o encerrou: ${second.err}`);
  assert.doesNotMatch(second.out, /começou a trabalhar/);
  assert.match(
    second.out,
    /A tentativa anterior falhou \(código de saída 1: boom\); nova tentativa automática às \d\d:\d\d/,
  );
});

// A nova tentativa está a minutos de distância, tempo demais para esperar contra uma central real.
test("só conta uma falha ocorrida depois que este try começou", () => {
  const run = (id: number, attempts: number, fields = {}) => ({
    id,
    rule: "experimente",
    state: "queued",
    attempts,
    error: "boom",
    notBefore: "2026-11-04T10:00:00.000Z",
    ...fields,
  });
  const before = attemptsOf([run(1, 1)]);
  assert.equal(newFailure([run(1, 1)], before), undefined, "ainda esperando a nova tentativa");
  assert.equal(newFailure([run(1, 2)], before)?.id, 1, "ela falhou de novo");
  assert.equal(newFailure([run(2, 1)], before)?.id, 2, "uma rodada nova falhou");
  assert.equal(newFailure([run(3, 0)], before), undefined, "ainda não tentada");
  assert.equal(newFailure([run(4, 1, { state: "claimed" })], before), undefined, "em curso de novo");
  assert.equal(newFailure([run(5, 1, { rule: "outra" })], before), undefined, "outra regra");
});
