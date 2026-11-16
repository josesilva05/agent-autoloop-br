// Um turno no Windows vive mais que o worker. O supervisor dele é dono da árvore de processos; este filho preserva a saída e o código de saída.
import { spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { commandLine, POWERSHELL } from "../host/command.ts";

if (process.argv[2] === "--supervise") {
  // O PowerShell não consegue rodar desacoplado; o Node consegue. Seu filho não desacoplado fica no job do Windows do Node, então matar
  // este supervisor fecha também o job do PowerShell e toda a sua árvore de Agent.
  const child = spawn(
    POWERSHELL,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(import.meta.dirname, "windows.ps1"),
      "-RunFile",
      process.argv[3],
      "-Marker",
      process.argv[4],
    ],
    { stdio: "inherit", windowsHide: true },
  );
  child.on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  const { argv, cwd, exit } = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const publish = (code: number) => {
    writeFileSync(`${exit}.tmp`, String(code), { mode: 0o600 });
    renameSync(`${exit}.tmp`, exit);
  };
  // A linha de comando que o Windows inicia tem um limite, e um prompt longo passado nela o atinge; o spawn pode lançar isso de imediato.
  const said = (error: NodeJS.ErrnoException) =>
    error.code === "ENAMETOOLONG"
      ? `Linha de comando longa demais: uns ${argv.join(" ").length} caracteres; o Windows aceita no máximo 32767.` +
        " Escreva as instruções longas da regra num Skill e deixe no prompt só uma linha para carregá-lo."
      : error.message;
  try {
    const [program, args] = commandLine(argv);
    const child = spawn(program, args, { cwd, stdio: "inherit", windowsHide: true });
    child.on("error", (error) => {
      console.error(said(error));
      publish(127);
    });
    child.on("exit", (code) => publish(code ?? 1));
  } catch (error) {
    console.error(said(error as NodeJS.ErrnoException));
    publish(127);
  }
}
