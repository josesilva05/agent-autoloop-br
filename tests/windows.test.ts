// Modos de falha: uma instalação nativa no Windows não consegue lançar um Agent; metacaracteres de shell alteram seus
// argumentos; reiniciar o worker perde uma rodada em execução ou a sua resposta; cancelar uma rodada deixa seus
// processos filhos rodando; um programa numa pasta cujo nome a página de código do console não consegue escrever (um
// nome de usuário em chinês) não é encontrado, então nada instala nem roda; um powershell.exe que um Agent deixou na
// pasta da rodada roda, fora do seu sandbox, no lugar do sistema; o npm.cmd e o npx.cmd que o npm 10 e posterior
// escrevem, que nomeiam seu script por uma variável, não conseguem ser executados; uma linha de comando mais longa do
// que o Windows aceita falha só com "spawn ENAMETOOLONG", que não diz o que está longo demais nem o que fazer.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { POWERSHELL, powershell, psQuote } from "../host/command.ts";

const windows = process.platform === "win32";
const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-windows-"));
process.env.AGENT_AUTOLOOP_HOME = join(scratch, "instalação ' & % diretório");
// O init liga seu manual nas pastas de Agents do usuário; os testes dão a ele um perfil só seu.
const person = join(scratch, "person");
mkdirSync(person);
after(() => rmSync(scratch, { recursive: true, force: true }));
const { createWorker } = await import("../worker/worker.ts");
const waiting: any[] = [];
const results = new Map<number, any>();
let cancel: number[] = [];
const hub = {
  work: async () => ({ job: waiting.shift() ?? null, cancel }),
  started: async () => ({}),
  result: async (run: number, _token: string, value: unknown) => {
    results.set(run, value);
    return {};
  },
};
const worker = () => createWorker({ name: "windows", hub: hub as any, wait: 0 });
function job(run: number, command: string[]) {
  return {
    run,
    token: "test",
    attempt: 1,
    session: null,
    askFirst: [],
    rule: { name: "Windows", cwd: scratch, prompt: "Read the input." },
    agent: { id: "a", name: "Agent", use: "command", access: "edit", command },
    context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  };
}
async function until(done: () => boolean, tick: () => Promise<unknown> = async () => {}) {
  const end = Date.now() + 30_000;
  while (!done() && Date.now() < end) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(done(), "o processo do Windows não chegou ao estado esperado");
}

test(
  "o Windows preserva argumentos literais e recupera uma rodada concluída depois de reiniciar o worker",
  { skip: !windows },
  async () => {
    const agent = join(scratch, "literal.mjs");
    const argument = 'acentuação \' "quoted" %PATH% & echo injected\nsecond line';
    writeFileSync(agent, "process.stdout.write(process.argv[2]);");
    waiting.push(job(1, [process.execPath, agent, argument]));
    await worker().tick();
    const resumed = worker();
    await until(
      () => results.has(1),
      () => resumed.tick(),
    );
    assert.equal(results.get(1).outcome, "done", JSON.stringify(results.get(1)));
    assert.equal(
      readFileSync(join(process.env.AGENT_AUTOLOOP_HOME!, "worker/runs/1-1/stdout-1.log"), "utf8"),
      argument,
    );
  },
);

test(
  "o cancelamento no Windows encerra o Agent e seu filho antes de reportar cancelado",
  { skip: !windows },
  async () => {
    const pidFile = join(scratch, "child.pid");
    const agent = join(scratch, "parent.mjs");
    writeFileSync(
      agent,
      `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setInterval(() => {}, 1000);`,
    );
    waiting.push(job(2, [process.execPath, agent]));
    const running = worker();
    await running.tick();
    let pid = 0;
    try {
      await until(() => existsSync(pidFile));
      pid = Number(readFileSync(pidFile, "utf8"));
      const resumed = worker();
      await resumed.tick();
      assert.ok(!results.has(2), "um Agent em execução foi tratado como concluído");
      cancel = [2];
      await until(
        () => results.has(2),
        () => resumed.tick(),
      );
      assert.equal(results.get(2).outcome, "cancelled");
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally {
      cancel = [];
      if (pid) spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    }
  },
);

test("um shim de comando do npm preserva um prompt multilinha no Windows", { skip: !windows }, async () => {
  const agent = join(scratch, "npm-agent.cjs");
  const shim = join(scratch, "npm-agent.cmd");
  const argument = 'acentuação "quotes" %PATH% & echo injected\nsecond line';
  writeFileSync(agent, "process.stdout.write(process.argv[2]);");
  writeFileSync(shim, '@ECHO off\r\nSET "dp0=%~dp0"\r\nnode "%dp0%\\npm-agent.cjs" %*\r\n');
  waiting.push(job(3, [shim, argument]));
  const running = worker();
  await until(
    () => results.has(3),
    () => running.tick(),
  );
  assert.equal(results.get(3).outcome, "done", JSON.stringify(results.get(3)));
  assert.equal(readFileSync(join(process.env.AGENT_AUTOLOOP_HOME!, "worker/runs/3-1/stdout-1.log"), "utf8"), argument);
});

// O npm escreve este shim para um pacote cujo bin é um programa nativo; o Claude Code instalado com npm é um desses.
test("um shim de comando do npm para um programa nativo o executa no Windows", { skip: !windows }, async () => {
  const bin = join(scratch, "node_modules", "native-agent", "bin");
  mkdirSync(bin, { recursive: true });
  copyFileSync(process.execPath, join(bin, "native-agent.exe"));
  const agent = join(scratch, "native-agent.cjs");
  const shim = join(scratch, "native-agent.cmd");
  const argument = 'acentuação "quotes" %PATH% & echo injected\nsecond line';
  writeFileSync(agent, "process.stdout.write(process.argv[2]);");
  writeFileSync(
    shim,
    '@ECHO off\r\nSET "dp0=%~dp0"\r\n"%dp0%\\node_modules\\native-agent\\bin\\native-agent.exe"   %*\r\n',
  );
  waiting.push(job(9, [shim, agent, argument]));
  const running = worker();
  await until(
    () => results.has(9),
    () => running.tick(),
  );
  assert.equal(results.get(9).outcome, "done", JSON.stringify(results.get(9)));
  assert.equal(readFileSync(join(process.env.AGENT_AUTOLOOP_HOME!, "worker/runs/9-1/stdout-1.log"), "utf8"), argument);
});

// O npm.cmd e o npx.cmd do npm 10 em diante, como o Node 22 e posterior os trazem: um Agent ACP costuma ser iniciado com npx.
test(
  "o shim de comando do próprio npm, que nomeia seu script por uma variável, o executa no Windows",
  { skip: !windows },
  async () => {
    const bin = join(scratch, "node_modules", "npm", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "npm-cli.js"), "process.stdout.write('npm: ' + process.argv[2]);");
    writeFileSync(join(bin, "npm-prefix.js"), "process.stdout.write('');");
    const shim = join(scratch, "npm.cmd");
    writeFileSync(
      shim,
      [
        ":: Created by npm, please don't edit manually.",
        "@ECHO OFF",
        "",
        "SETLOCAL",
        "",
        'SET "NODE_EXE=%~dp0\\node.exe"',
        'IF NOT EXIST "%NODE_EXE%" (',
        '  SET "NODE_EXE=node"',
        ")",
        "",
        'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
        'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"',
        'FOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"\') DO (',
        '  SET "NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js"',
        ")",
        'IF EXIST "%NPM_PREFIX_NPM_CLI_JS%" (',
        '  SET "NPM_CLI_JS=%NPM_PREFIX_NPM_CLI_JS%"',
        ")",
        "",
        '"%NODE_EXE%" "%NPM_CLI_JS%" %*',
        "",
      ].join("\r\n"),
    );
    waiting.push(job(11, [shim, "parâmetros & echo injected"]));
    const running = worker();
    await until(
      () => results.has(11),
      () => running.tick(),
    );
    assert.equal(results.get(11).outcome, "done", JSON.stringify(results.get(11)));
    assert.equal(results.get(11).summary, "npm: parâmetros & echo injected");
  },
);

test("uma linha de comando longa demais para o Windows diz isso e o que fazer", { skip: !windows }, async () => {
  waiting.push(job(12, [process.execPath, "-e", "0", "x".repeat(40_000)]));
  const running = worker();
  await until(
    () => results.has(12),
    () => running.tick(),
  );
  assert.equal(results.get(12).outcome, "failed", JSON.stringify(results.get(12)));
  assert.match(results.get(12).error, /Linha de comando longa demais.*Skill/s);
});

// O where.exe imprime na página de código do console; um nome de pasta em chinês voltava como um caminho que não existe.
test(
  "um Agent no PATH sob uma pasta que a página de código do console não consegue escrever é encontrado e roda",
  { skip: !windows },
  async () => {
    const folder = join(scratch, "ferramentas do Fulano");
    mkdirSync(folder);
    writeFileSync(join(folder, "cjk-agent.js"), "process.stdout.write('ran: ' + process.argv[2]);");
    writeFileSync(join(folder, "cjk-agent.cmd"), '@ECHO off\r\nnode "%~dp0\\cjk-agent.js" %*\r\n');
    const path = process.env.PATH;
    process.env.PATH = `${folder};${path}`;
    try {
      const { findProgram } = await import("../worker/agents.ts");
      const found = findProgram("cjk-agent");
      assert.ok(found && existsSync(found), `encontrou ${found}`);
      waiting.push(job(5, ["cjk-agent", "parâmetros"]));
      const running = worker();
      await until(
        () => results.has(5),
        () => running.tick(),
      );
      assert.equal(results.get(5).outcome, "done", JSON.stringify(results.get(5)));
      assert.equal(results.get(5).summary, "ran: parâmetros");
    } finally {
      process.env.PATH = path;
    }
  },
);

test(
  "o init termina quando o PATH tem um agent-autoloop sob uma pasta que a página de código do console não consegue escrever",
  { skip: !windows },
  () => {
    const folder = join(scratch, "comandos do Beltrano");
    mkdirSync(folder);
    writeFileSync(join(folder, "agent-autoloop.cmd"), "@ECHO off\r\n");
    const home = join(scratch, "cjk init home");
    const initialized = spawnSync(
      process.execPath,
      [join(import.meta.dirname, "../bin/agent-autoloop.ts"), "init", "--no-service", "--command", "node"],
      {
        env: { ...process.env, AGENT_AUTOLOOP_HOME: home, USERPROFILE: person, PATH: `${folder};${process.env.PATH}` },
        encoding: "utf8",
      },
    );
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.match(initialized.stdout, /Rode primeiro/);
  },
);

// O Windows procura um nome de programa simples primeiro na sua pasta de trabalho, e um Agent pode escrever na pasta da rodada.
test("um powershell.exe deixado na pasta da rodada não roda no lugar do sistema", { skip: !windows }, async () => {
  const folder = join(scratch, "planted");
  mkdirSync(folder);
  copyFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"), join(folder, "powershell.exe"));
  const agent = join(scratch, "planted-agent.mjs");
  writeFileSync(agent, "process.stdout.write('ran');");
  const input = job(6, [process.execPath, agent]);
  input.rule.cwd = folder;
  waiting.push(input);
  const running = worker();
  await until(
    () => results.has(6),
    () => running.tick(),
  );
  assert.equal(results.get(6).outcome, "done", JSON.stringify(results.get(6)));
});

test("o acesso de edição ACP no Windows rejeita uma pasta irmã", { skip: !windows }, async () => {
  const { permission } = await import("../plugins/acp/bridge.ts");
  const answer = permission(
    { access: "edit", cwd: scratch },
    {
      toolCall: { kind: "edit", locations: [{ path: join(scratch, "..", "outside.txt") }] },
      options: [
        { kind: "allow_once", optionId: "yes" },
        { kind: "reject_once", optionId: "no" },
      ],
    },
  );
  assert.equal(answer.optionId, "no");
});

test("o Windows mantém uma rodada depois que o processo do worker sai", { skip: !windows }, async () => {
  const agent = join(scratch, "outlive.mjs");
  writeFileSync(agent, 'setTimeout(() => console.log("survived"), 1000);');
  const input = job(4, [process.execPath, agent]);
  const module = pathToFileURL(join(import.meta.dirname, "../worker/worker.ts")).href;
  const launched = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    const { createWorker } = await import(${JSON.stringify(module)});
    const worker = createWorker({ name: 'child', hub: {
      work: async () => ({job: ${JSON.stringify(input)}, cancel: []}),
      started: async () => ({}), result: async () => ({})
    }});
    await worker.tick();
    process.exit(0);
  `,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(launched.status, 0, launched.stderr);
  const resumed = worker();
  await until(
    () => results.has(4),
    () => resumed.tick(),
  );
  assert.equal(results.get(4).summary, "survived", JSON.stringify(results.get(4)));
});

test("o init no Windows imprime um comando nativo que funciona", { skip: !windows }, () => {
  const home = join(scratch, "init home");
  const cli = join(import.meta.dirname, "../bin/agent-autoloop.ts");
  const initialized = spawnSync(process.execPath, [cli, "init", "--no-service", "--command", "node"], {
    env: { ...process.env, AGENT_AUTOLOOP_HOME: home, USERPROFILE: person },
    encoding: "utf8",
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.ok(existsSync(join(home, "config.json")));
  assert.match(initialized.stdout, /Rode primeiro/);
});

// A descoberta de Agents monta um comando antes de qualquer rodada, então não tem arquivo de contexto para compartilhar com o sandbox do Codex.
test("o init no Windows descobre o Codex antes de uma tarefa ter arquivo de contexto", { skip: !windows }, (t) => {
  if (spawnSync("where.exe", ["codex"], { windowsHide: true }).status !== 0) return t.skip("Codex is not installed");
  const home = join(scratch, "codex init");
  const initialized = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "../bin/agent-autoloop.ts"), "init", "--no-service", "--agent", "codex"],
    { env: { ...process.env, AGENT_AUTOLOOP_HOME: home, USERPROFILE: person }, encoding: "utf8" },
  );
  assert.equal(initialized.status, 0, initialized.stderr);
  const rules = JSON.parse(readFileSync(join(home, "rules.json"), "utf8"));
  assert.equal(rules.agents.codex.use, "codex");
});

test(
  "o init no Windows mantém suas chaves privadas mesmo dentro de um diretório compartilhado",
  { skip: !windows },
  () => {
    const parent = join(scratch, "shared");
    const home = join(parent, "private");
    mkdirSync(parent);
    const granted = spawnSync("icacls.exe", [parent, "/grant", "*S-1-1-0:(OI)(CI)F"], { encoding: "utf8" });
    assert.equal(granted.status, 0, granted.stderr);
    const initialized = spawnSync(
      process.execPath,
      [join(import.meta.dirname, "../bin/agent-autoloop.ts"), "init", "--no-service", "--command", "node"],
      {
        env: { ...process.env, AGENT_AUTOLOOP_HOME: home, USERPROFILE: person },
        encoding: "utf8",
      },
    );
    assert.equal(initialized.status, 0, initialized.stderr);
    const sids = powershell(
      `[IO.File]::GetAccessControl(${psQuote(join(home, "master.key"))}).Access.IdentityReference | ForEach-Object { $_.Translate([Security.Principal.SecurityIdentifier]).Value }`,
    );
    assert.ok(!sids.includes("S-1-1-0"), "Everyone consegue ler a chave mestra da instalação");
  },
);

test("o texto de notificação do Windows permanece dado no PowerShell", { skip: !windows }, async () => {
  const { notifyCommand } = await import("../plugins/desktop/channel.ts");
  const title = "acentuação '; throw 'injected' & <tag> %PATH%\nsecond line";
  const [program, args] = notifyCommand(title, "win32");
  assert.equal(program, POWERSHELL);
  const script = Buffer.from(args.at(-1)!, "base64")
    .toString("utf16le")
    .replace("$icon.Visible = $true", "$icon.Visible = $false")
    .replace("$icon.ShowBalloonTip(5000)", "$words | ConvertTo-Json -Compress")
    .replace("Start-Sleep -Seconds 5", "");
  const result = spawnSync(program, [...args.slice(0, -1), Buffer.from(script, "utf16le").toString("base64")], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    title: "O Agent fez uma pergunta a você",
    body: `${title}\nExecute agent-autoloop status para ver`,
  });
});

// O sandbox elevado do Codex usa outra conta do Windows, que por padrão não consegue ler o arquivo de contexto de uma central privada.
test(
  "o Codex no Windows expõe seu contexto ao sandbox, sem expor a chave mestra",
  { skip: !windows || !!process.env.CI },
  async (t) => {
    const sid = powershell(
      `try { ([Security.Principal.NTAccount]::new($env:COMPUTERNAME, 'CodexSandboxUsers')).Translate([Security.Principal.SecurityIdentifier]).Value } catch [System.Security.Principal.IdentityNotMappedException] { }`,
    );
    if (!sid) return t.skip("Codex elevated sandbox is not installed");
    const home = join(scratch, "sandbox-data");
    const { privateDirectory } = await import("../host/files.ts");
    privateDirectory(home);
    const contextFile = join(home, "context.json");
    const key = join(home, "master.key");
    writeFileSync(contextFile, '{"answers":[]}');
    writeFileSync(key, "private");
    const { default: codex } = await import("../plugins/codex/agent.ts");
    codex.command({
      contextFile,
      folder: home,
      cwd: scratch,
      prompt: "Read the context.",
      access: "read",
      session: "",
      resume: null,
    });
    const rights = (file: string) =>
      powershell(
        `[IO.File]::GetAccessControl(${psQuote(file)}).Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq ${psQuote(sid)} } | ForEach-Object { [int]$_.FileSystemRights }`,
      );
    const contextRights = Number(rights(contextFile));
    assert.ok(contextRights & 1, "o sandbox não consegue ler seu contexto");
    assert.equal(contextRights & 2, 0, "o sandbox consegue sobrescrever seu contexto");
    assert.equal(rights(key), "", "o sandbox recebeu a chave mestra");
  },
);
