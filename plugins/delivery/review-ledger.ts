import { createHash } from "node:crypto";
import type { Finding } from "./review.ts";

const SECTION = "## Revisão do Codex";
const ROUND = /^Rodada (\d+) \(([^)\n]+), ([a-z]+(?: \+ [a-z]+)*), revisado até ([0-9a-f]{7,40})\):/gm;
const ITEM = /^(\d+)\. /;
export const REVIEW_ROUNDS = 3;

function section(body: string) {
  return /^## Revisão do Codex\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(body);
}

export function ledger(description: string | null | undefined) {
  const body = (description ?? "").replaceAll("\r\n", "\n");
  const match = section(body);
  const record = match?.[1] ?? "";
  const matches = [...record.matchAll(ROUND)];
  const rounds = matches.map(([, number, signature, effort, head], index) => ({
    number: Number(number),
    signature,
    effort,
    head,
    // Vincula também todas as rodadas anteriores. Remover um finding antigo precisa invalidar a comprovação mais recente.
    digest: createHash("sha256")
      .update(
        record
          .slice(0, matches[index + 1]?.index)
          .replace(/^   Tratamento:[^\n]*$/gm, "   Tratamento:")
          .trim(),
      )
      .digest("hex"),
  }));
  const waiting = new Map<number, boolean>();
  let current: number | undefined;
  for (const line of record.split("\n")) {
    const item = ITEM.exec(line);
    if (item) {
      current = Number(item[1]);
      waiting.set(current, true);
    } else if (line.startsWith("Rodada ") && line.includes(" (")) {
      current = undefined;
    } else if (current !== undefined) {
      const handled = /^ +Tratamento:(.*)$/.exec(line);
      if (handled) waiting.set(current, !handled[1].trim());
    }
  }
  return {
    body,
    record: record.trim(),
    rounds,
    author: match ? (body.slice(0, match.index) + body.slice(match.index + match[0].length)).trim() : body.trim(),
    unhandled: [...waiting].filter(([, pending]) => pending).map(([item]) => item),
    numbered: Math.max(0, ...waiting.keys()),
    append(text: string) {
      if (!match) return `${body.trimEnd()}${body.trim() ? "\n\n" : ""}${SECTION}\n\n${text}\n`;
      const end = match.index + match[0].length;
      const rest = body.slice(end);
      return `${body.slice(0, end).trimEnd()}\n\n${text}\n${rest ? `\n${rest}` : ""}`;
    },
  };
}

export function renderRound(
  current: ReturnType<typeof ledger>,
  signature: string,
  effort: string[],
  head: string,
  findings: Finding[],
) {
  const header = `Rodada ${current.rounds.length + 1} (${signature}, ${effort.join(" + ")}, revisado até ${head}):`;
  if (!findings.length) return `${header}Nenhum problema encontrado.`;
  return [
    `${header}Foram encontrados ${findings.length} problema(s).`,
    ...findings.map(({ title, text }, index) => {
      const body = text
        .replaceAll("\r\n", "\n")
        .split("\n")
        .map((line) => (line ? `   ${line}` : ""))
        .join("\n");
      return `\n${current.numbered + index + 1}. **${title.replace(/\s+/g, " ").trim()}**\n\n${body}\n\n   Tratamento:`;
    }),
  ].join("\n");
}
