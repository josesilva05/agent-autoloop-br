// `agent-autoloop runs`: as rodadas concluídas anteriores às poucas que o `status` mostra, para que o `why` possa receber um
// número. Percorre /v1/state em páginas como qualquer cliente do titular pode fazer; a seleção de uma regra é feita aqui, para
// que o protocolo continue como está.
import { finished, runRows } from "./status.ts";

type Page = (before?: number) => Promise<any>;

/**
 * Até `want` rodadas concluídas, das mais novas para as mais antigas, anteriores a `before` e da regra `rule`, quando dada.
 * `more` é onde a próxima lista começa, ou null quando não há nada mais antigo.
 */
export async function findRuns(
  page: Page,
  { rule, before, want = 20 }: { rule?: string; before?: number; want?: number },
) {
  const runs: any[] = [];
  let cursor = before;
  let first: any;
  for (;;) {
    const state = await page(cursor);
    first ??= state;
    // A página mais nova também traz toda rodada ainda não assentada, por mais antiga que seja; cada uma delas é lida na
    // sua própria página.
    const own = state.runs.filter((run: any) => state.nextBefore === null || run.id >= state.nextBefore);
    const matching = own.filter((run: any) => finished(run) && (rule === undefined || run.rule === rule));
    for (const run of matching) {
      if (runs.length === want) return { state: first, runs, more: runs.at(-1).id as number };
      runs.push(run);
    }
    if (!state.hasMore) return { state: first, runs, more: null };
    if (runs.length === want) return { state: first, runs, more: runs.at(-1).id as number };
    cursor = state.nextBefore;
  }
}

export function runsText(
  found: Awaited<ReturnType<typeof findRuns>>,
  { rule, color, columns }: { rule?: string; color: boolean; columns?: number },
) {
  if (!found.runs.length)
    return rule === undefined ? "Ainda não há rodadas concluídas." : `A regra "${rule}" não tem rodadas concluídas.`;
  const lines = runRows(found.state, found.runs, { color, columns });
  lines.push("", "Detalhes: agent-autoloop why <nº da rodada>");
  if (found.more !== null) {
    const named = rule === undefined ? "" : ` ${/^[^\s"'\\$`]+$/.test(rule) ? rule : JSON.stringify(rule)}`;
    lines.push(`Mais antigas: agent-autoloop runs${named} --before ${found.more}`);
  }
  return lines.join("\n");
}
