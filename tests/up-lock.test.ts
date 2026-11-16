// Quem detém o up.pid. Casos de falha: o número deixado para trás é o deste próprio processo (sempre é para o pid 1 num
// contêiner, e é possível depois de qualquer reinicialização), então ele diz que já está em execução e não consegue
// iniciar até alguém apagar o arquivo; um segundo inicia ao lado de um que realmente está rodando.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const bin = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
const program = ["--disable-warning=ExperimentalWarning", bin];

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

test("um número deixado no up.pid que agora é o dele próprio não o impede de iniciar; um segundo ainda não consegue", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "agent-autoloop-up-lock-"));
  const standIns = join(home, "stand-ins");
  mkdirSync(standIns);
  for (const name of ["launchctl", "osascript", "notify-send"]) {
    writeFileSync(join(standIns, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_AUTOLOOP_HOME: home,
    DISPLAY: ":99",
    PATH: `${standIns}:${process.env.PATH}`,
    SHELL: "/bin/sh",
  };
  delete env.AGENT_AUTOLOOP_RULES;
  delete env.AGENT_AUTOLOOP_PUBLIC_URL;
  const port = await freePort();
  const init = spawnSync(
    process.execPath,
    [...program, "init", "--no-service", "--command", "true {prompt}", "--port", String(port)],
    { env, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(init.status, 0, init.stderr);

  // O exec mantém o número do shell, então o arquivo nomeia o processo que está prestes a lê-lo, como faria uma
  // reinicialização que o tivesse sorteado.
  const wrote = 'printf %s "$$" > "$AGENT_AUTOLOOP_HOME/up.pid"; exec "$@"';
  const up = spawn("/bin/sh", ["-c", wrote, "sh", process.execPath, ...program, "up"], { env, stdio: "ignore" });
  const ended = new Promise((resolve) => up.once("exit", resolve));
  t.after(async () => {
    up.kill("SIGTERM");
    await ended;
    rmSync(home, { recursive: true, force: true });
  });

  const { url } = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  let ready = false;
  for (let i = 0; i < 100 && !ready && up.exitCode === null; i++) {
    ready = await fetch(`${url}/healthz`).then(
      (response) => response.ok,
      () => false,
    );
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, "ele iniciou");
  assert.equal(readFileSync(join(home, "up.pid"), "utf8"), String(up.pid));

  const second = spawnSync(process.execPath, [...program, "up"], { env, encoding: "utf8", timeout: 30_000 });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /já está em execução/);
});
