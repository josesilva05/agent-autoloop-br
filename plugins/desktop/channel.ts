// O canal com que uma instalação nova começa: uma notificação neste computador de que há algo para olhar. Ele não
// recebe resposta; `agent-autoloop status` mostra o cartão e `agent-autoloop answer` o responde.
//   "channels": { "desktop": { "key": "…" } } no config.json
//   "channels": { "desktop": { "name": "notificação de desktop" } } no rules.json
import { execFile, spawnSync } from "node:child_process";
import type { Card, ChannelContext } from "../../host/channels.ts";
import { POWERSHELL, powershell } from "../../host/command.ts";

const WORDS = "Execute agent-autoloop status para ver";
const TITLE = "O Agent fez uma pergunta a você";
const APPLESCRIPT = ["on run argv", "display notification (item 2 of argv) with title (item 1 of argv)", "end run"];

/**
 * O título de um cartão é o que um Agent escreveu, então ele é sempre só um argumento, nunca parte de um script. O `--`
 * é o que o mantém assim quando começa com um traço: sem ele, o osascript lê um título `-e` como mais script a executar.
 */
export function notifyCommand(title: string, platform: string = process.platform): [string, string[]] {
  const body = `${title}\n${WORDS}`;
  if (platform === "win32") {
    const data = Buffer.from(JSON.stringify({ title: TITLE, body })).toString("base64");
    const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
      $words = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json
      Add-Type -AssemblyName System.Windows.Forms, System.Drawing
      $icon = [Windows.Forms.NotifyIcon]::new()
      try {
        $icon.Icon = [Drawing.SystemIcons]::Information
        $icon.BalloonTipTitle = $words.title
        $icon.BalloonTipText = $words.body
        $icon.Visible = $true
        $icon.ShowBalloonTip(5000)
        [Windows.Forms.Application]::DoEvents()
        Start-Sleep -Seconds 5
      } finally { $icon.Dispose() }`;
    return [
      POWERSHELL,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
    ];
  }
  if (platform === "darwin") return ["osascript", [...APPLESCRIPT.flatMap((line) => ["-e", line]), "--", TITLE, body]];
  return ["notify-send", ["--", TITLE, body]];
}

function hasDesktop() {
  if (process.platform === "win32") {
    return (
      powershell(
        "$session=(Get-Process -Id $PID).SessionId; [string][bool](@(Get-Process explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $session }).Count)",
      ) === "True"
    );
  }
  if (process.platform === "darwin") {
    return spawnSync("launchctl", ["print", `gui/${process.getuid!()}`], { stdio: "ignore" }).status === 0;
  }
  return process.platform === "linux" && Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/**
 * Não é a chamada síncrona com que os outros canais se safam: isto roda no processo da própria central e pode ficar
 * esperando num diálogo.
 */
function show(title: string) {
  const [program, args] = notifyCommand(title);
  return new Promise<void>((resolve, reject) => {
    execFile(program, args, { timeout: 30_000 }, (error) => (error ? reject(error) : resolve()));
  });
}

export default async function desktop({ hub, log, signal }: ChannelContext) {
  const available = hasDesktop();
  while (!signal.aborted) {
    let card: Card | null;
    try {
      ({ card } = await hub.nextCard(50));
    } catch (error) {
      log(`não foi possível alcançar a central: ${error}`);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      continue;
    }
    if (!card) continue;
    // Uma notificação some assim que é exibida: uma atualização não tem nada a fazer.
    if (card.ref) {
      await hub.delivered(card.id, card.version, card.ref);
      continue;
    }
    if (!available) {
      await hub.delivered(card.id, card.version, `skipped-${card.id}`);
      continue;
    }
    try {
      await show(card.rule && card.rule !== card.title ? `${card.title}\nFonte: ${card.rule}` : card.title);
      await hub.delivered(card.id, card.version, `shown-${card.id}`);
    } catch (error) {
      log(`a notificação de desktop do cartão ${card.id} não foi exibida: ${error}`);
      await hub.failed(card.id, card.version, String(error)).catch(() => {});
    }
  }
}
