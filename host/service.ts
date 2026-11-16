// Serviços de login: launchd no macOS, systemd no Linux, Task Scheduler no Windows. Cada um inicia a central no login e
// de novo se ela parar.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HOME } from "./home.ts";
import { stablePath } from "./node-path.ts";
import { powershell, processCommandSync, psQuote } from "./command.ts";

const PROGRAM = path.join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
/** Outra instalação nesta máquina (outro AGENT_AUTOLOOP_HOME) tem um serviço próprio. */
const label = () =>
  HOME === path.join(homedir(), ".agent-autoloop")
    ? "agent-autoloop"
    : `agent-autoloop-${createHash("sha256").update(HOME).digest("hex").slice(0, 8)}`;
const plistFile = () => path.join(homedir(), "Library/LaunchAgents", `${label()}.plist`);
const unitFile = () => path.join(homedir(), ".config/systemd/user", `${label()}.service`);
const BACKGROUND = path.join(import.meta.dirname, "background.ts");
const LAUNCHER = path.join(import.meta.dirname, "background.js");
const windowsArgument = (word: string) => `"${word.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
const task = () => `Get-ScheduledTask | Where-Object { $_.TaskName -eq ${psQuote(label())} -and $_.TaskPath -eq '\\' }`;

/** O que a tarefa de login inicia. Iniciado direto por ela, o node ganha uma janela de console no desktop, e a tarefa não
 * o inicia de novo quando ele sai. O wscript não tem console: o background.js inicia a central oculta e de novo quando ela para. */
export function windowsLauncher() {
  return {
    program: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe"),
    args: ["//B", "//Nologo", "//E:JScript"]
      .concat(
        [LAUNCHER, process.execPath, "--disable-warning=ExperimentalWarning", BACKGROUND, HOME].map(windowsArgument),
      )
      .join(" "),
    directory: HOME,
  };
}

/** PowerShell que coloca em `folder` (uma expressão PowerShell) um atalho que inicia a mesma coisa. */
export function startupShortcut(folder = "[Environment]::GetFolderPath('Startup')") {
  const { program, args, directory } = windowsLauncher();
  return (
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path (${folder}) ${psQuote(`${label()}.lnk`)})); ` +
    `$s.TargetPath = ${psQuote(program)}; $s.Arguments = ${psQuote(args)}; $s.WorkingDirectory = ${psQuote(directory)}; $s.Save()`
  );
}

/** Para uma conta que não pode, ou não deveria, ter a tarefa de login: o desktop a inicia, com os direitos do desktop. */
export const startupInstead = () =>
  'Dá para usar a pasta "Inicializar": rode a linha abaixo no PowerShell e, a cada login, o desktop iniciará a central com permissões comuns, ' +
  "reiniciando-a automaticamente quando ela sair. Faça logoff e login outra vez agora para ela começar a rodar. Uma central iniciada assim não conta como serviço do sistema: " +
  "o doctor dirá que o serviço não está em execução; ao rodar o instalador de novo para atualizar, acrescente --no-service, " +
  "senão ele vai criar outra tarefa de login; depois de atualizar, faça logoff e login outra vez para passar a usar a versão nova.\n\n" +
  startupShortcut();

function installWindowsService() {
  const { program, args, directory } = windowsLauncher();
  // Registrar com -Force substitui a tarefa no lugar, então a antiga e a central que ela roda ficam intactas até o
  // Windows assumir a nova: um registro que ele recusa não pode deixar a pessoa sem central.
  try {
    powershell(`
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $action = New-ScheduledTaskAction -Execute ${psQuote(program)} -Argument ${psQuote(args)} -WorkingDirectory ${psQuote(directory)}
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName ${psQuote(label())} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  `);
  } catch (error) {
    // O Administrator embutido, com UAC ligado, não consegue criar tarefa nenhuma sem elevar, seja como for que a tarefa esteja escrita.
    if (!String((error as { stderr?: string }).stderr ?? error).includes("0x80070005")) throw error;
    throw new Error(
      `O Windows não permite que esta conta crie uma tarefa de login (acesso negado). ${startupInstead()}`,
    );
  }
  // Parar a tarefa encerra o wscript, não a central que ele iniciou; esta, ou uma iniciada à mão, é parada em seguida.
  powershell(`$task = ${task()}; if ($task.State -eq 'Running') { $task | Stop-ScheduledTask }`);
  stopUp();
  powershell(`Start-ScheduledTask -TaskName ${psQuote(label())}`);
}

/**
 * Se um processo detém o token completo de administrador enquanto o desktop da sua sessão não: mais do que a pessoa que
 * fez login tem. Com o UAC desligado, ou um Administrator que não é filtrado, o desktop também o tem, e a pasta
 * Inicializar não concede menos. Não saber (ele terminou, ou não é nosso para perguntar) conta como não.
 */
export function aboveDesktop(pid: number) {
  return (
    powershell(`Add-Type @"
using System; using System.Diagnostics; using System.Runtime.InteropServices;
public static class Token {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr token, int kind, out int value, int size, out int length);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static bool Elevated(int pid) {
    IntPtr process = OpenProcess(0x1000, false, pid), token;
    if (process == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    try {
      if (!OpenProcessToken(process, 0x8, out token)) throw new System.ComponentModel.Win32Exception();
      int value, length;
      try { if (!GetTokenInformation(token, 20, out value, 4, out length)) throw new System.ComponentModel.Win32Exception(); }
      finally { CloseHandle(token); }
      return value != 0;
    } finally { CloseHandle(process); }
  }
  public static bool AboveDesktop(int pid) {
    try {
      if (!Elevated(pid)) return false;
      int session = Process.GetProcessById(pid).SessionId;
      foreach (Process shell in Process.GetProcessesByName("explorer"))
        if (shell.SessionId == session) return !Elevated(shell.Id);
    } catch {}
    return false;
  }
}
"@
[Token]::AboveDesktop(${pid})`) === "True"
  );
}
const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export type UnitOptions = {
  home: string;
  executable: string;
  program: string;
};

const systemdItem = (text: string, escapeDollar = false) => {
  if (/[\u0000-\u001f\u007f]/u.test(text))
    throw new Error("o valor de uma unit do systemd não pode conter caracteres de controle");
  let escaped = text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  if (escapeDollar) escaped = escaped.replaceAll("$", () => "$$");
  return `"${escaped}"`;
};

export function plist() {
  const logs = path.join(HOME, "logs");
  const systemPaths = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const executable = stablePath(process.execPath);
  const searchPath = [path.dirname(executable), ...systemPaths].join(":");
  const program = [executable, "--disable-warning=ExperimentalWarning", PROGRAM, "up"];
  const programArguments = program.map((part) => `<string>${xml(part)}</string>`).join("");
  const homeEntry = `<key>AGENT_AUTOLOOP_HOME</key><string>${xml(HOME)}</string>`;
  const pathEntry = `<key>PATH</key><string>${xml(searchPath)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label()}</string>
  <key>ProgramArguments</key><array>${programArguments}</array>
  <key>EnvironmentVariables</key><dict>${homeEntry}${pathEntry}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(logs)}/up.log</string>
  <key>StandardErrorPath</key><string>${xml(logs)}/up.log</string>
</dict></plist>
`;
}

export function unit(options: UnitOptions = { home: HOME, executable: process.execPath, program: PROGRAM }) {
  const environment = systemdItem(`AGENT_AUTOLOOP_HOME=${options.home}`);
  const command = [options.executable, "--disable-warning=ExperimentalWarning", options.program, "up"]
    .map((part) => systemdItem(part, true))
    .join(" ");
  return `[Unit]
Description=Central de automação de Agents

[Service]
Environment=${environment}
ExecStart=${command}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
}

const domain = () => `gui/${process.getuid!()}`;
const launchdHasIt = () =>
  spawnSync("launchctl", ["print", `${domain()}/${label()}`], { stdio: "ignore" }).status === 0;
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function installService() {
  mkdirSync(path.join(HOME, "logs"), { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return installWindowsService();
  if (process.platform === "darwin") {
    mkdirSync(path.dirname(plistFile()), { recursive: true });
    writeFileSync(plistFile(), plist());
    // O launchd se recusa a carregar um plist que outros podem escrever, com um inútil "Bootstrap failed: 5"; e
    // reescrever um que uma instalação com umask 0 deixou gravável por todos mantém o modo dele, então o modo é
    // definido a cada instalação.
    chmodSync(plistFile(), 0o644);
    spawnSync("launchctl", ["bootout", `${domain()}/${label()}`], { stdio: "ignore" });
    // O bootout retorna antes de o antigo sumir; carregar antes disso falha e não deixa nenhum.
    for (let tries = 0; tries < 100 && launchdHasIt(); tries++) pause(100);
    execFileSync("launchctl", ["bootstrap", domain(), plistFile()]);
  } else {
    mkdirSync(path.dirname(unitFile()), { recursive: true });
    writeFileSync(unitFile(), unit());
    execFileSync("systemctl", ["--user", "daemon-reload"]);
    execFileSync("systemctl", ["--user", "enable", "--now", label()]);
    execFileSync("systemctl", ["--user", "restart", label()]);
  }
}

export function removeService() {
  if (process.platform === "win32") {
    const removed =
      powershell(`$task = ${task()}; if ($task -and $task.Actions.Arguments.Contains(${psQuote(windowsArgument(BACKGROUND))})) {
      $task | Stop-ScheduledTask
      $task | Unregister-ScheduledTask -Confirm:$false
      'removed'
    }`);
    // Parar a tarefa encerra o wscript, não a central que ele iniciou, e nada a inicia de novo agora.
    if (removed === "removed") stopUp();
    return;
  }
  const file = process.platform === "darwin" ? plistFile() : unitFile();
  if (!existsSync(file)) return;
  const service = readFileSync(file, "utf8");
  const ownsService =
    process.platform === "darwin"
      ? service.includes(xml(PROGRAM))
      : service.includes(systemdItem(PROGRAM, true)) || service.includes(PROGRAM);
  if (!ownsService) return;
  if (process.platform === "darwin") {
    spawnSync("launchctl", ["bootout", `${domain()}/${label()}`], { stdio: "ignore" });
    rmSync(plistFile(), { force: true });
  } else {
    spawnSync("systemctl", ["--user", "disable", "--now", label()], { stdio: "ignore" });
    rmSync(unitFile(), { force: true });
  }
}

/** O processo que deixou seu número em up.pid, se ele ainda é aquele processo: o número pode já ser de outro agora. */
export function runningUp() {
  const file = path.join(HOME, "up.pid");
  if (!existsSync(file)) return null;
  const pid = readFileSync(file, "utf8").trim();
  let command = "";
  try {
    command = processCommandSync(Number(pid));
  } catch {}
  return /agent-autoloop(\.ts)?"? up\b/.test(command) ? Number(pid) : null;
}

/** Parar um serviço retorna antes de o processo dele sumir, e um iniciado à mão não tem serviço que o pare. */
export function stopUp() {
  const pid = runningUp();
  if (pid === null) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  for (let tries = 0; tries < 50 && runningUp() !== null; tries++) pause(100);
}

/** O serviço que este programa instala e consegue reiniciar. */
export function serviceRunning() {
  if (process.platform === "win32")
    return powershell(`$task = ${task()}; [string]($task -and $task.State -eq 'Running')`) === "True";
  if (process.platform === "darwin") return existsSync(plistFile()) && launchdHasIt();
  return spawnSync("systemctl", ["--user", "is-active", "--quiet", label()], { stdio: "ignore" }).status === 0;
}

/** Se o gerenciador dele tem o serviço em execução ou em partida: um parado à mão, ou a ausência total de gerenciador, não é esperado. */
function serviceStarting() {
  if (process.platform !== "linux") return serviceRunning();
  const state = spawnSync("systemctl", ["--user", "is-active", label()], { encoding: "utf8" }).stdout?.trim();
  return state === "active" || state === "activating" || state === "reloading";
}

/**
 * Um gerenciador diz que iniciou a central antes de a central conseguir responder, e o que rodar em seguida não encontra
 * nada ali. Espera por ela enquanto o gerenciador a tiver: true assim que ela responde, false se não responder a tempo,
 * null quando não há nada para esperar.
 */
export async function untilAnswering(url: string, patience = 20_000) {
  if (!serviceStarting()) return null;
  const end = Date.now() + patience;
  for (;;) {
    const answered = await fetch(`${url.replace(/\/$/, "")}/healthz`, { signal: AbortSignal.timeout(2_000) }).then(
      (response) => response.ok,
      () => false,
    );
    if (answered) return true;
    if (Date.now() > end) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Para onde vai a saída do próprio serviço. */
export const serviceLogs = () =>
  process.platform === "linux" ? `journalctl --user -u ${label()}` : path.join(HOME, "logs", "up.log");

/** O nome de uma unit em nível de sistema que executa isto, como um servidor rodado por root poderia ter. Cabe ao dono dela reiniciá-la. */
export function systemUnit() {
  if (process.platform === "win32") return null;
  if (process.platform === "darwin") return null;
  return spawnSync("systemctl", ["is-active", "--quiet", label()], { stdio: "ignore" }).status === 0 ? label() : null;
}

/** O código novo conta uma vez só quando o que está rodando reinicia. O que não pode ser reiniciado daqui é dito de volta, para o titular. */
export function restartService() {
  if (serviceRunning()) return void installService();
  const name = systemUnit();
  return name
    ? `Este computador usa um serviço em nível de sistema; rode systemctl restart ${name} para passar a usar a versão nova.`
    : undefined;
}
