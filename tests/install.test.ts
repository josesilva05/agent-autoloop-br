// O install.sh, num home descartável com um PATH feito só de pastas temporárias. O programa que ele instala é uma cópia
// deste, e o `git` é um substituto que faz essa cópia, então nada precisa ser commitado e nenhuma pasta real pode ser
// escrita. Casos de falha: o comando vai para um lugar que não está no PATH, então `agent-autoloop` não é encontrado
// logo depois de instalar; um agent-autoloop de outra pessoa é sobrescrito; sem lugar para colocá-lo, ou com o de outra
// pessoa vindo antes, o próximo passo impresso não funciona; o próximo passo diz `try` quando nada foi iniciado; ele
// pede sudo; o conselho sobre o Node não pode ser seguido como está escrito, omitindo que o node@24 do Homebrew não fica
// no PATH; rodá-lo de novo refaz a configuração, ou instala um serviço depois de --no-service.
// Um umask normal ou um diretório já existente não pode expor o banco, o texto dos eventos nem a saída do worker a outros usuários.
// Um computador que só recebe trabalho não consegue entrar, porque o instalador montou antes uma central nele.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const repo = join(import.meta.dirname, "..");
const script = join(repo, "install.sh");
const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-autoloop-install-")));
const copy = join(dir, "the-program");
for (const part of ["bin", "cli", "host", "kernel", "plugins", "protocol", "skills", "worker", "package.json"]) {
  cpSync(join(repo, part), join(copy, part), { recursive: true });
}
const locked: string[] = [];
after(() => {
  for (const folder of locked) chmodSync(folder, 0o755);
  rmSync(dir, { recursive: true, force: true });
});

const system = (name: string) => ["/bin", "/usr/bin"].map((place) => join(place, name)).find(existsSync)!;
const executable = (file: string, body: string) => {
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
};

let people = 0;
/** O computador de alguém: um home, e uma pasta com os comandos de que o script precisa e na qual não se pode escrever. */
function computer({ node = "real" }: { node?: "real" | "old" | "none" } = {}) {
  const person = join(dir, `person-${++people}`);
  const tools = join(person, "tools");
  mkdirSync(tools, { recursive: true });
  for (const name of ["mkdir", "ln", "cat", "cp", "chmod", "sed", "sort", "tail"])
    symlinkSync(system(name), join(tools, name));
  const called = join(person, "called");
  executable(
    join(tools, "git"),
    `echo "git $*" >> "${called}"
case " $* " in *" clone "*) for target; do :; done; cp -R "${copy}" "$target"; mkdir "$target/.git" ;; esac
[ "$3" != config ] || echo https://github.com/josesilva05/agent-autoloop-br.git`,
  );
  // `launchctl print` falhando diz que nada está carregado, e é isso que deixa um primeiro carregamento seguir de imediato.
  executable(join(tools, "launchctl"), `echo "launchctl $*" >> "${called}"\n[ "$1" != print ]`);
  executable(join(tools, "systemctl"), `echo "systemctl $*" >> "${called}"`);
  if (node === "real") symlinkSync(process.execPath, join(tools, "node"));
  if (node === "old") executable(join(tools, "node"), `[ "$1" = -v ] && echo v22.1.0 || exit 1`);
  chmodSync(tools, 0o555);
  locked.push(tools);
  const hub = join(person, ".agent-autoloop");
  const program = join(hub, "app", "bin", "agent-autoloop.ts");
  const local = join(person, ".local", "bin");
  const run = (path: string[], args = ["--no-service", "--command", "true", "--port", "3999"], shell = "/bin/sh") => {
    const env: NodeJS.ProcessEnv = { HOME: person, PATH: [...path, tools].join(":") };
    return spawnSync(shell, [script, ...args], {
      env,
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  };
  return { person, tools, hub, program, local, called, run, folder: (name: string) => join(person, name) };
}
const made = (place: string) => {
  mkdirSync(place, { recursive: true });
  return place;
};
const isLink = (file: string) => lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() === true;

test("a instalação mantém os dados privados mesmo quando sua raiz já existe com o modo 0755", () => {
  const it = computer();
  mkdirSync(it.hub, { mode: 0o755 });
  chmodSync(it.hub, 0o755);
  const done = it.run([it.local]);
  assert.equal(done.status, 0, done.stderr + done.stdout);
  assert.equal(statSync(it.hub).mode & 0o777, 0o700);
});

test("um computador que só recebe trabalho entra pelo instalador, sem nada de uma central montado nele", () => {
  const it = computer();
  const done = it.run([it.local], ["join", "https://hub.test", "--worker", "mac", "--key", "k", "--no-service"]);
  assert.equal(done.status, 0, done.stderr + done.stdout);
  assert.deepEqual(JSON.parse(readFileSync(join(it.hub, "config.json"), "utf8")), {
    url: "https://hub.test",
    worker: { name: "mac", key: "k" },
  });
  assert.match(done.stdout, /executar trabalho/);
  assert.equal(readlinkSync(join(it.local, "agent-autoloop")), it.program);
  // Uma segunda tentativa, com a chave corrigida, deve dizer que não fez nada em vez de dizer que atualizou.
  const again = it.run([it.local], ["join", "https://hub.test", "--worker", "mac", "--key", "other", "--no-service"]);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /Já está configurado/);
  assert.equal(JSON.parse(readFileSync(join(it.hub, "config.json"), "utf8")).worker.key, "k");
});

test("o comando vai para ~/.local/bin quando isso está no PATH, mesmo atrás de outro lugar onde poderia ir", () => {
  const it = computer();
  const other = made(it.folder("other"));
  const done = it.run([other, it.local]);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(readlinkSync(join(it.local, "agent-autoloop")), it.program);
  assert.ok(!isLink(join(other, "agent-autoloop")));
  assert.match(
    done.stdout,
    /Rode primeiro agent-autoloop up para iniciar a central e depois, em outro terminal, agent-autoloop try/,
  );
  assert.doesNotMatch(done.stdout, /alias/);
});

test("o mesmo vale para o dash, que é o que o sh é no Ubuntu", { skip: !existsSync("/bin/dash") }, () => {
  const it = computer();
  const done = it.run([it.local], undefined, "/bin/dash");
  assert.equal(done.status, 0, done.stderr);
  assert.ok(isLink(join(it.local, "agent-autoloop")));
  assert.doesNotMatch(done.stdout, /alias/);
});

test("com ~/.local/bin fora do PATH ele vai para o primeiro lugar que está, e deixa ~/.local/bin intacto", () => {
  const it = computer();
  const first = made(it.folder("first"));
  const second = made(it.folder("second"));
  const done = it.run(["relative/bin", ".", it.folder("not-there"), first, second]);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(readlinkSync(join(first, "agent-autoloop")), it.program);
  assert.ok(!existsSync(it.local));
  assert.ok(!isLink(join(second, "agent-autoloop")));
  assert.match(done.stdout, /agent-autoloop try/);
  assert.doesNotMatch(done.stdout, /alias/);
});

test("o agent-autoloop de outra pessoa fica como estava, e o próximo passo não a manda para ele", () => {
  const it = computer();
  const theirs = made(it.local);
  executable(join(theirs, "agent-autoloop"), "echo their own");
  const after = made(it.folder("after"));
  const done = it.run([theirs, after]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(readFileSync(join(theirs, "agent-autoloop"), "utf8"), /echo their own/);
  assert.equal(readlinkSync(join(after, "agent-autoloop")), it.program);
  assert.match(done.stdout, new RegExp(`Rode primeiro ${it.program} up`));
  assert.match(done.stdout, new RegExp(`alias agent-autoloop='${it.program}'`));

  const linked = computer();
  const place = made(linked.local);
  symlinkSync(join(place, "somewhere-else"), join(place, "agent-autoloop"));
  assert.equal(linked.run([place]).status, 0);
  assert.equal(readlinkSync(join(place, "agent-autoloop")), join(place, "somewhere-else"));
});

test(
  "sem nenhum lugar no PATH para colocá-lo, o próximo passo dá o caminho completo e nenhum link é deixado em lugar algum",
  { skip: process.getuid?.() === 0 },
  () => {
    const it = computer();
    const done = it.run([]);
    assert.equal(done.status, 0, done.stderr);
    assert.ok(!existsSync(it.local));
    assert.match(
      done.stdout,
      new RegExp(
        `Rode primeiro ${it.program} up para iniciar a central e depois, em outro terminal, ${it.program} try`,
      ),
    );
    assert.match(done.stdout, new RegExp(`alias agent-autoloop='${it.program}'`));
    assert.doesNotMatch(readFileSync(script, "utf8"), /sudo/);
  },
);

test("o próximo passo é só o try quando um serviço foi iniciado", () => {
  const it = computer();
  const done = it.run([it.local], ["--command", "true", "--port", "3999"]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /Rode agent-autoloop try para percorrer o fluxo completo/);
  assert.doesNotMatch(done.stdout, /agent-autoloop up/);
});

for (const [node, words] of [
  ["old", /É preciso ter o Node\.js 24 ou mais novo; a versão atual é v22\.1\.0/],
  ["none", /É preciso ter o Node\.js 24 ou mais novo; não encontrei nenhum neste computador/],
] as const) {
  test(`com o Node ${node === "old" ? "velho demais" : "ausente"} ele diz o que rodar, e essas linhas funcionam como estão escritas`, () => {
    const it = computer({ node });
    const done = it.run([]);
    assert.equal(done.status, 1);
    assert.match(done.stdout, words);
    assert.match(done.stdout, /^ +brew install node@24$/m);
    assert.match(done.stdout, /^ +nvm install 24$/m);
    assert.ok(!existsSync(it.hub), "nada é configurado");
    // A linha sobre o PATH, como é impressa, executada onde `brew --prefix` responde como o Homebrew responde.
    const shell = made(it.folder("shell"));
    executable(join(shell, "brew"), `[ "$*" = "--prefix node@24" ] && echo /homebrew/opt/node@24`);
    const line = done.stdout.split("\n").find((printed) => printed.includes("brew --prefix"))!;
    const pasted = spawnSync("/bin/sh", ["-c", line.trim()], {
      env: { HOME: shell, PATH: shell },
      encoding: "utf8",
    });
    assert.equal(pasted.status, 0, pasted.stderr);
    assert.equal(readFileSync(join(shell, ".zshrc"), "utf8"), 'export PATH="/homebrew/opt/node@24/bin:$PATH"\n');
  });
}

test("rodá-lo de novo atualiza e não configura nada por cima do que já existe", () => {
  const it = computer();
  assert.equal(it.run([it.local]).status, 0);
  writeFileSync(join(it.hub, "rules.json"), "my rules");
  const config = readFileSync(join(it.hub, "config.json"), "utf8");
  rmSync(it.called);
  const kept = it.run([it.local]);
  assert.equal(kept.status, 0, kept.stderr);
  assert.match(kept.stdout, /Atualização concluída/);
  assert.equal(readFileSync(join(it.hub, "rules.json"), "utf8"), "my rules");
  assert.equal(readFileSync(join(it.hub, "config.json"), "utf8"), config);
  assert.equal(readlinkSync(join(it.local, "agent-autoloop")), it.program);
  // Este substituto não lista Release nenhum. O que acontece com alguns está em releases.test.ts, com o git real.
  assert.deepEqual(readFileSync(it.called, "utf8").trim().split("\n"), [
    `git -C ${join(it.hub, "app")} config --get remote.origin.url`,
    "git ls-remote --refs --tags https://github.com/josesilva05/agent-autoloop-br.git v*",
    `git -C ${join(it.hub, "app")} pull --ff-only --quiet`,
  ]);

  rmSync(it.called);
  assert.equal(it.run([it.local], []).status, 0);
  const service = process.platform === "darwin" ? /^launchctl bootstrap /m : /^systemctl --user enable --now /m;
  assert.match(readFileSync(it.called, "utf8"), service, "sem --no-service, uma atualização reinicia o serviço");
});
