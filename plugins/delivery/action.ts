// A pergunta do passo Ship, como uma GitHub Action: este commit precisa ser publicado, e a main já passou dele?
// Roda a partir de uma cópia dentro do projeto, então não importa nada além do project.ts desta pasta.
import { appendFileSync } from "node:fs";
import { git, liveRelease, readMainSettings, releaseRequired, type Live } from "./project.ts";

export function decideShip(
  target: string,
  main: string,
  live: Live | null,
  required: (base: string, head: string) => boolean,
) {
  return { release: !live || required(live.sha, target), superseded: main !== target && required(target, main) };
}

if (import.meta.main) {
  const root = process.cwd();
  const target = process.env.INPUT_TARGET || process.env.GITHUB_SHA;
  if (!target || !/^[a-f0-9]{40}$/.test(target)) throw new Error("O alvo da publicação deve ser um hash completo");
  git(root, "fetch", "origin", "main");
  const main = git(root, "rev-parse", "origin/main");
  const config = readMainSettings(root, process.env.INPUT_TEST_LOCAL_HEALTH === "true", target);
  const live = await liveRelease(config);
  const decision = decideShip(target, main, live, (base, head) => releaseRequired(root, base, head, config.internal));
  const output = Object.entries(decision)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  else process.stdout.write(output);
}
