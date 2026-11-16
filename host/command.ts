// O Node não consegue executar um shim .cmd do npm no Windows. Execute diretamente o que ele aponta (uma entrada
// JavaScript ou um programa nativo), para que argumentos multilinha nunca virem código-fonte de cmd.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** O Windows procura um nome de programa simples primeiro na sua pasta de trabalho, e um Agent pode escrever na pasta da rodada. */
export const POWERSHELL = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

/**
 * O arquivo que o Windows executa para `name` a partir do PATH, testando as extensões na ordem do PATHEXT. Não é o
 * where.exe: ele imprime na página de código do console, então uma pasta fora dela (um nome de usuário em chinês)
 * voltava como um caminho que não existe. A pasta atual não é procurada, então um projeto não consegue colocar um
 * programa próprio no lugar do instalado.
 */
export function findOnPath(name: string, extensions = [".exe", ".com", ".cmd", ".bat", ".ps1"]) {
  if (/[\\/]/.test(name)) return null;
  const listed = (process.env.PATHEXT ?? "").toLowerCase().split(";");
  const order = [
    ...listed.filter((ext) => extensions.includes(ext)),
    ...extensions.filter((ext) => !listed.includes(ext)),
  ];
  const names = [
    ...(extensions.includes(path.extname(name).toLowerCase()) ? [name] : []),
    ...order.map((ext) => name + ext),
  ];
  for (const entry of (process.env.PATH ?? "").split(";")) {
    const folder = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!folder) continue;
    for (const file of names.map((each) => path.join(folder, each))) if (existsSync(file)) return file;
  }
  return null;
}

/**
 * O npm.cmd e o npx.cmd do npm 10 em diante nomeiam seu script numa variável definida a partir de %~dp0 e então rodam
 * `"%NODE_EXE%" "%NPM_CLI_JS%" %*`. O npm executado é o que eles trazem: fica de fora o passo que poderia escolher um
 * npm mais novo instalado sob o prefixo global.
 */
function throughVariable(shim: string) {
  const run = /^"%\w+%"\s+"%(\w+)%"\s+%\*\s*$/im.exec(shim);
  if (!run) return null;
  return new RegExp(`^SET\\s+"${run[1]}=%~dp0\\\\?([^"\\r\\n]+\\.[cm]?js)"\\s*$`, "im").exec(shim);
}

export function commandLine(argv: string[]): [string, string[]] {
  if (process.platform !== "win32") return [argv[0], argv.slice(1)];
  let program = argv[0];
  if (!path.isAbsolute(program)) program = findOnPath(program) ?? program;
  if (/\.cmd$/i.test(program)) {
    const shim = readFileSync(program, "utf8");
    const entry = /"%(?:dp0%|~dp0)\\?([^"\r\n]+\.(?:[cm]?js|exe))"\s+%\*/i.exec(shim) ?? throughVariable(shim);
    if (!entry)
      throw new Error(
        `Não é possível executar ${program} diretamente: escreva um executável em command, ou rode o script com node.`,
      );
    // Um pacote cujo bin é um programa nativo (o Claude Code vindo do npm) recebe um shim que o executa sem o node na frente.
    if (/\.exe$/i.test(entry[1])) return [path.resolve(path.dirname(program), entry[1]), argv.slice(1)];
    const adjacentNode = path.join(path.dirname(program), "node.exe");
    return [
      existsSync(adjacentNode) ? adjacentNode : process.execPath,
      [path.resolve(path.dirname(program), entry[1]), ...argv.slice(1)],
    ];
  }
  if (/\.ps1$/i.test(program))
    return [POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", program, ...argv.slice(1)]];
  if (/\.bat$/i.test(program))
    throw new Error(
      `Não é possível executar ${program} diretamente: escreva um executável em command, ou rode o script com node.`,
    );
  return [program, argv.slice(1)];
}

const encoded = (script: string) => [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-EncodedCommand",
  Buffer.from(
    "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " + script,
    "utf16le",
  ).toString("base64"),
];

export function powershell(script: string) {
  return execFileSync(POWERSHELL, encoded(script), {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export const psQuote = (word: string) => `'${word.replaceAll("'", "''")}'`;

const commandOf = (pid: number): [string, string[]] =>
  process.platform === "win32"
    ? [POWERSHELL, encoded(`(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`)]
    : ["ps", ["-p", String(pid), "-o", "command="]];

export function processCommandSync(pid: number) {
  return execFileSync(...commandOf(pid), { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

/** Sem interromper o processo enquanto inspeciona: o worker compartilha um processo com a central, e o PowerShell leva mais de um segundo para iniciar. */
export async function processCommand(pid: number) {
  return (await execFileAsync(...commandOf(pid), { encoding: "utf8", windowsHide: true })).stdout;
}
