// Modos de falha no Windows: um home escrito como nome curto 8.3 (um TEMP como C:\Users\ADMINI~1\Temp) derruba a central
// com uma asserção do libuv na primeira mudança na sua pasta de regras; uma central com mais direitos do que o desktop
// onde se fez login é tomada por uma sem eles, então uma tarefa de login que a executa elevada passa despercebida, ou
// uma com os direitos do próprio desktop (UAC desligado, um Administrator não filtrado, uma conta comum) é removida; o
// atalho de inicialização oferecido como alternativa inicia algo diferente do que a tarefa iniciaria.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { powershell, psQuote } from "../host/command.ts";

const windows = process.platform === "win32";
const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-windows-admin-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const short = windows
  ? powershell(`(New-Object -ComObject Scripting.FileSystemObject).GetFolder(${psQuote(scratch)}).ShortPath`)
  : scratch;
process.env.AGENT_AUTOLOOP_HOME = join(short, "home");
process.env.AGENT_AUTOLOOP_RULES = join(short, "home", "rules.json");
process.env.AGENT_AUTOLOOP_PUBLIC_URL = "https://hub.test";
mkdirSync(join(scratch, "home"));
copyFileSync(join(import.meta.dirname, "rules.fixture.json"), join(scratch, "home", "rules.json"));

test(
  "uma central cujo home é um nome curto 8.3 continua funcionando quando sua pasta de regras muda",
  { skip: !windows },
  async (t) => {
    if (short === scratch) return t.skip("este volume não tem nomes 8.3");
    const { serve } = await import("../host/http.ts");
    const server = serve(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const { db } = await import("../host/runtime.ts");
    t.after(() => {
      server.close();
      server.closeAllConnections();
      db.close();
    });
    writeFileSync(join(scratch, "home", "unrelated.txt"), "x");
    copyFileSync(join(import.meta.dirname, "rules.fixture.json"), join(scratch, "home", "rules.json"));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const port = (server.address() as AddressInfo).port;
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
  },
);

/** O número de um processo que uma tarefa de login inicia no `level` dado, na sessão onde se fez login; ele se encerra em até um minuto. */
function taskProcess(level: "Highest" | "Limited") {
  const output = join(scratch, `${level}.pid`);
  const name = `agent-autoloop-test-${level}-${process.pid}`;
  powershell(`
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${psQuote(`-NoProfile -NonInteractive -WindowStyle Hidden -Command "$PID | Set-Content -LiteralPath '${output.replaceAll("'", "''")}'; Start-Sleep 60"`)}
    Register-ScheduledTask -TaskName ${psQuote(name)} -Action $action -Principal (New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel ${level}) -Force | Out-Null
    Start-ScheduledTask -TaskName ${psQuote(name)}
    $end = (Get-Date).AddSeconds(30)
    while (!(Test-Path -LiteralPath ${psQuote(output)}) -and (Get-Date) -lt $end) { Start-Sleep -Milliseconds 200 }
    Unregister-ScheduledTask -TaskName ${psQuote(name)} -Confirm:$false
  `);
  return Number(readFileSync(output, "utf8").trim());
}

// Criar uma tarefa que roda no nível mais alto exige um administrador elevado e um desktop com sessão aberta, como na
// máquina de testes e não no CI.
test(
  "um processo com mais direitos do que o desktop é distinguido de um com os direitos do próprio desktop",
  { skip: !windows || !!process.env.CI },
  async () => {
    const { aboveDesktop } = await import("../host/service.ts");
    const higher = taskProcess("Highest");
    const same = taskProcess("Limited");
    try {
      assert.equal(aboveDesktop(higher), true);
      assert.equal(aboveDesktop(same), false);
      // Um processo elevado numa sessão sem desktop (SSH, um serviço) não tem nada com que comparar.
      assert.equal(aboveDesktop(process.pid), false);
    } finally {
      for (const pid of [higher, same]) spawnSync("taskkill", ["/F", "/PID", String(pid)], { windowsHide: true });
    }
  },
);

test("o atalho de inicialização executa exatamente o que a tarefa de login executa", { skip: !windows }, async () => {
  const { startupShortcut, windowsLauncher } = await import("../host/service.ts");
  // O WScript.Shell grava atalhos pela página de código do sistema; a conta de Administrator para a qual isto serve tem um caminho ASCII.
  const folder = join(scratch, "Start ' Menu");
  mkdirSync(folder);
  powershell(startupShortcut(psQuote(folder)));
  const shortcut = powershell(`$s = (New-Object -ComObject WScript.Shell).CreateShortcut(
    (Get-ChildItem -LiteralPath ${psQuote(folder)} -Filter *.lnk | Select-Object -First 1).FullName)
    @($s.TargetPath, $s.Arguments, $s.WorkingDirectory) -join [char]10`).split("\n");
  const task = windowsLauncher();
  // O atalho escreve C:\Windows com as maiúsculas da própria pasta, e o Windows não se importa com isso.
  assert.deepEqual(
    [shortcut[0].toLowerCase(), ...shortcut.slice(1)],
    [task.program.toLowerCase(), task.args, task.directory],
  );
});
