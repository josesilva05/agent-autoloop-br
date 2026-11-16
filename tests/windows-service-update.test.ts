// Atualizar a tarefa de login do Windows não pode derrubar uma central que funciona. Modo de falha: a tarefa antiga é
// removida e a central em execução é parada antes de a nova tarefa ser registrada, então um registro que o Windows
// recusa não deixa central nenhuma.
// Um PowerShell falso faz o papel do Windows; nada real é instalado.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("windows-service-update");
const root = join(home, "windows");
const calls = join(home, "calls.jsonl");
const refuse = join(home, "refuse");
mkdirSync(join(root, "System32", "WindowsPowerShell", "v1.0"), { recursive: true });
process.env.SystemRoot = root;
// Ele responde aos scripts pelo que eles fazem: a tarefa é nossa, o processo no up.pid é a central, e o registro falha
// enquanto `refuse` existir.
writeFileSync(
  join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  `#!${process.execPath}
const { appendFileSync, existsSync } = require("node:fs");
const script = Buffer.from(process.argv[process.argv.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(script) + "\\n");
if (script.includes("Register-ScheduledTask") && existsSync(${JSON.stringify(refuse)})) {
  process.stderr.write("Register-ScheduledTask : Parâmetro incorreto. (0x80070057)");
  process.exit(1);
}
if (script.includes("Unregister-ScheduledTask")) process.stdout.write("removed");
if (script.includes("Win32_Process")) process.stdout.write("node agent-autoloop.ts up");
`,
);
chmodSync(join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), 0o755);
Object.defineProperty(process, "platform", { value: "win32" });
const { installService } = await import("../host/service.ts");

/** Um processo no lugar da central em execução, com seu número deixado no up.pid como `up` o deixa. Não é filho deste,
 * então, uma vez parado, ele some em vez de ficar sem reaproveitamento. */
function runningHub() {
  const pid = Number(spawnSync("sh", ["-c", "sleep 60 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).stdout);
  writeFileSync(join(home, "up.pid"), String(pid));
  return pid;
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const scripts = (): string[] =>
  existsSync(calls)
    ? readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];

test("uma tarefa de login que o Windows não registra deixa a tarefa antiga e a central em execução intactas", () => {
  const hub = runningHub();
  rmSync(calls, { force: true });
  writeFileSync(refuse, "");
  try {
    assert.throws(() => installService(), /0x80070057/);
    assert.ok(alive(hub), "a central que estava funcionando foi parada");
    assert.ok(
      !scripts().some((script) => /Unregister-ScheduledTask|Stop-ScheduledTask/.test(script)),
      "a tarefa antiga foi removida",
    );
  } finally {
    rmSync(refuse, { force: true });
    if (alive(hub)) process.kill(hub);
  }
});

test("depois que a nova tarefa é registrada, a central antiga é parada e a tarefa é iniciada de novo", () => {
  const hub = runningHub();
  rmSync(calls, { force: true });
  try {
    installService();
    assert.equal(alive(hub), false, "a central antiga continuou rodando ao lado da nova");
    const done = scripts();
    const registered = done.findIndex((script) => script.includes("Register-ScheduledTask"));
    const started = done.findLastIndex((script) => script.includes("Start-ScheduledTask"));
    assert.ok(registered >= 0 && started >= registered, "a tarefa não foi iniciada depois de ser registrada");
  } finally {
    if (alive(hub)) process.kill(hub);
  }
});
