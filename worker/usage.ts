// O total acumulado de uma sessão não é o que uma inicialização usou; é o quanto o total subiu durante ela. A inicialização
// guarda onde o total estava quando começou, porque um worker que para depois de avançar este arquivo lê aquela inicialização de novo.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HOME } from "../host/home.ts";
import type { Usage } from "./agents.ts";

const DIRECTORY = path.join(HOME, "worker", "usage");
const FIELDS = ["input", "output", "cached", "cost"] as const;

// O nome de uma sessão vem do programa do Agent, então não é usado como nome de arquivo.
const file = (adapter: string, session: string) => {
  const name = createHash("sha256")
    .update(JSON.stringify([adapter, session]))
    .digest("hex");
  return path.join(DIRECTORY, `${name}.json`);
};

export function loadUsage(adapter: string, session: string): Usage | undefined {
  try {
    return JSON.parse(readFileSync(file(adapter, session), "utf8"));
  } catch {
    return undefined;
  }
}

export function saveUsage(adapter: string, session: string, usage: Usage) {
  mkdirSync(DIRECTORY, { recursive: true, mode: 0o700 });
  const target = file(adapter, session);
  writeFileSync(`${target}.tmp`, JSON.stringify(usage), { mode: 0o600 });
  renameSync(`${target}.tmp`, target);
}

/** Sem saber onde um total começou, ou com um total que caiu, o que a inicialização usou é desconhecido: nem nada nem tudo. */
export function usageDelta(total: Usage, baseline: Usage | undefined): Usage | undefined {
  if (!baseline) return undefined;
  const rise: Usage = {};
  for (const field of FIELDS) {
    const now = total[field];
    const before = baseline[field];
    if (now === undefined || before === undefined) continue;
    if (now < before) return undefined;
    rise[field] = now - before;
  }
  return Object.keys(rise).length ? rise : undefined;
}
