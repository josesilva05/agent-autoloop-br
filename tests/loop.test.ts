// O ciclo inteiro, sem nada falso além do Agent: um `agent-autoloop up` real em seu próprio processo, a partir do
// `init`, pelo protocolo como tudo mais o fala. Um evento chega; o Agent roda e pergunta; o titular responde pela linha
// de comando; o Agent segue em frente e termina. Casos de falha: o init deixa algo de fora; o `up` não inicia, ou inicia
// duas vezes; a rodada não é iniciada na sua pasta; a pergunta não chega ao titular; o `status` não mostra o que fazer
// sobre ela; a resposta não acorda o assunto; o resultado não é registrado; o `try` fica esperando uma resposta quando
// não há ninguém num terminal, como quando um Agent o executa; os Agents do usuário não recebem as instruções de
// configuração, ou algo do próprio usuário é sobrescrito ao fazê-lo, ou uma instalação de teste o faz; a pergunta não
// aparece no desktop, aparece de novo depois de respondida, ou uma execução de teste dispara uma notificação real.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "agent-autoloop-loop-"));
const bin = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
// O `init` liga o canal de desktop: estes fazem o papel dos comandos que realmente mostrariam algo.
const notifiers = join(home, "notifiers");
const notified = join(home, "notified.txt");
const notifications = () => (existsSync(notified) ? readFileSync(notified, "utf8").trim().split("\n") : []);
mkdirSync(notifiers);
writeFileSync(join(notifiers, "launchctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
for (const name of ["osascript", "notify-send"]) {
  const recordTitle = `while [ "$1" != "--" ]; do shift; done\nprintf '%s\\n' "$3" >> "${notified}"\n`;
  writeFileSync(join(notifiers, name), `#!/bin/sh\n${recordTitle}`);
  chmodSync(join(notifiers, name), 0o755);
}
const env: NodeJS.ProcessEnv = {
  ...process.env,
  AGENT_AUTOLOOP_HOME: home,
  DISPLAY: ":99",
  PATH: `${notifiers}:${process.env.PATH}`,
};
delete env.AGENT_AUTOLOOP_RULES;
delete env.AGENT_AUTOLOOP_PUBLIC_URL;
const cli = (...args: string[]) =>
  spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", bin, ...args], {
    env,
    encoding: "utf8",
    timeout: 30_000,
  });

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

const fence = "```";
const script = join(home, "agent.sh");
writeFileSync(
  script,
  `#!/bin/sh
# Na primeira vez ele pergunta; com uma resposta no arquivo de contexto, ele conclui. Quando se pede, ele só diz alguma coisa.
if grep -q 'card.answered' "$AGENT_AUTOLOOP_CONTEXT"; then
  echo "Você escolheu Verde, concluído"
elif grep -q 'hello.notice' "$AGENT_AUTOLOOP_CONTEXT"; then
  cat <<'END'
avisou

${fence}agent-autoloop
{"notice":[{"title":"fique atento","text":"o disco está quase cheio","key":"disk"}]}
${fence}
END
else
  pwd > "${home}/where.txt"
  cat <<'END'
fez uma pergunta

${fence}agent-autoloop
{"ask":[{"title":"Execução de teste: escolha uma cor","text":"tanto faz qual","options":["Azul","Verde"],"recommend":1,"key":"color"}]}
${fence}
END
fi
`,
);
chmodSync(script, 0o755);

let up: ReturnType<typeof spawn> | undefined;
after(async () => {
  if (up && up.exitCode === null && up.signalCode === null) {
    up.kill("SIGTERM");
    await new Promise((resolve) => up!.once("exit", resolve));
  }
  rmSync(home, { recursive: true, force: true });
});

test("uma máquina, um comando: um evento, uma pergunta, uma resposta, o trabalho feito", async () => {
  const port = await freePort();
  const done = cli("init", "--no-service", "--command", script, "--port", String(port));
  assert.equal(done.status, 0, done.stderr);
  assert.equal(statSync(join(home, "config.json")).mode & 0o777, 0o600, "suas chaves são privadas");
  assert.equal(cli("init", "--no-service").status, 1, "um segundo init não sobrescreve o primeiro");
  assert.equal(cli("check").status, 0);
  // Aponte a regra inicial para algo que este teste controla.
  const rules = JSON.parse(readFileSync(join(home, "rules.json"), "utf8"));
  mkdirSync(join(home, "work"));
  rules.rules[0].cwd = join(home, "work");
  rules.rules[0].when.types = ["hello.*", "try.*"];
  writeFileSync(join(home, "rules.json"), JSON.stringify(rules));

  up = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", bin, "up"], { env, stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  // O `cli` trava este processo, então uma conexão mantida aberta pode expirar na central sem que se note, e a próxima
  // requisição nela é resetada. Cada requisição ganha a sua.
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${url}${path}`, { headers: { connection: "close", ...headers } });
  for (let i = 0; i < 100; i++) {
    if (
      await get("/healthz").then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await (await get("/healthz")).json()).ok, true);
  const second = cli("up");
  assert.equal(second.status, 1);
  assert.match(second.stderr, /já está em execução/);

  const emitted = cli("emit", "hello.world", "--subject", "x-1", "--summary", "olá");
  assert.equal(emitted.status, 0, emitted.stderr);
  assert.match(emitted.stdout, /Entregue a: experimente/);

  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  const state = async () => (await get("/v1/state", { authorization: `Bearer ${config.owner}` })).json();
  const until = async (done: (s: any) => boolean) => {
    for (let i = 0; i < 150; i++) {
      const now = await state();
      if (done(now)) return now;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`tempo esgotado: ${JSON.stringify((await state()).runs)}`);
  };
  const asking = await until((s) => s.cards.length === 1);
  const card = asking.cards[0];
  assert.equal(card.title, "Execução de teste: escolha uma cor");
  assert.ok(readFileSync(join(home, "where.txt"), "utf8").includes("work"));
  const waiting = cli("status");
  assert.match(waiting.stdout, /Aguardando você 1/);
  assert.match(waiting.stdout, new RegExp(`#${card.id} Execução de teste: escolha uma cor`));
  assert.match(waiting.stdout, /Fonte: experimente/);
  assert.match(waiting.stdout, /2\. Verde \(recomendado\)/);
  assert.match(waiting.stdout, new RegExp(`agent-autoloop answer ${card.id} `));

  // O notificador roda por conta própria, e um cartão respondido antes de ele chegar nem é mostrado.
  await until(() => notifications().length === 3);
  assert.equal(cli("answer", String(card.id), "7").status, 1, "não existe uma sétima opção");
  const answered = cli("answer", String(card.id), "2");
  assert.equal(answered.status, 0, answered.stderr);
  const finished = await until((s) =>
    s.runs.some((r: any) => r.summary === "Você escolheu Verde, concluído" && r.state === "done"),
  );
  assert.equal(finished.cards.length, 0);
  assert.equal(finished.recentCards[0].state, "done");
  assert.equal(finished.recentCards[0].result, "Você escolheu Verde, concluído");
  assert.equal(finished.recentCards[0].by, "o titular");
  assert.deepEqual(
    notifications(),
    ["Execução de teste: escolha uma cor", "Fonte: experimente", "Execute agent-autoloop status para ver"],
    "uma vez só, dizendo que regra perguntou, e nenhuma para a resposta",
  );
  assert.match(cli("answer", String(card.id), "1").stdout, /já foi tratado/);

  const status = cli("status");
  assert.match(status.stdout, /Aguardando você 0 · Em execução 0 · Na fila 0 · Concluídas hoje 2/);
  assert.match(status.stdout, /Você escolheu Verde, concluído/);
  const told = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", bin, "tell", "note-1"], {
    env,
    encoding: "utf8",
    input: "Só para avisar\n",
  });
  assert.match(told.stdout, /Comunicado/);
  assert.match(cli("status").stdout, /Só para avisar/);
  cli("emit", "hello.notice");
  const noticed = await until((s) => s.cards.some((c: any) => c.kind === "notice"));
  const notice = noticed.cards.find((c: any) => c.kind === "notice");
  assert.match(cli("status").stdout, new RegExp(`Resolvido: agent-autoloop answer ${notice.id}`));
  assert.match(cli("answer", String(notice.id)).stdout, /Encerrado/);

  // Ninguém num terminal, como quando um Agent está instalando: o `try` diz o que está sendo perguntado e como responder, e não espera.
  const tried = cli("try");
  assert.equal(tried.status, 0, tried.stderr);
  assert.match(tried.stdout, /Execução de teste: escolha uma cor/);
  const id = /agent-autoloop answer (\d+) /.exec(tried.stdout)![1];
  const resolved = cli("resolve", id, "desisti de testar");
  assert.match(resolved.stdout, /Encerrado/);
  assert.equal((await state()).recentCards.find((c: any) => c.id === Number(id)).result, "desisti de testar");
  assert.equal(cli("resolve", id).status, 1, "é preciso escrever um resultado");
  assert.equal((await get("/")).status, 404);
});

test("os Agents do usuário recebem as instruções de configuração, quando esta é a instalação no lugar de costume, e nada deles é tocado", () => {
  const person = mkdtempSync(join(tmpdir(), "agent-autoloop-person-"));
  mkdirSync(join(person, ".claude"));
  mkdirSync(join(person, ".codex", "skills", "agent-autoloop"), { recursive: true });
  writeFileSync(join(person, ".codex", "skills", "agent-autoloop", "SKILL.md"), "their own");
  const usual: NodeJS.ProcessEnv = { ...env, HOME: person };
  delete usual.AGENT_AUTOLOOP_HOME;
  const done = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", bin, "init", "--no-service", "--command", "true"],
    { env: usual, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(done.status, 0, done.stderr);
  assert.equal(
    realpathSync(join(person, ".claude", "skills", "agent-autoloop")),
    realpathSync(join(import.meta.dirname, "..", "skills", "agent-autoloop")),
  );
  assert.ok(lstatSync(join(person, ".claude", "skills", "agent-autoloop")).isSymbolicLink());
  assert.equal(readFileSync(join(person, ".codex", "skills", "agent-autoloop", "SKILL.md"), "utf8"), "their own");
  assert.ok(existsSync(join(person, ".agent-autoloop", "config.json")));
  rmSync(person, { recursive: true, force: true });
  assert.ok(!existsSync(join(home, ".claude")), "uma instalação em outro lugar deixa os Agents do usuário intactos");
});
