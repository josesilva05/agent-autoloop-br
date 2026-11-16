// As linhas de custo do `agent-autoloop status`, a partir dos totais por hora de conclusão do /v1/state. Os Agents relatam o
// próprio uso, ou não: um comando simples não diz nada, e alguns dão tokens mas nenhum preço. Por isso cada número diz quantas
// rodadas ficaram de fora.
import type { Spending } from "../host/state.ts";
const count = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });
/** Com duas casas, um dia num modelo barato não leria nada de nada. */
const dollars = (amount: number) => (amount > 0 && amount < 0.01 ? "<$0.01" : `$${amount.toFixed(2)}`);

function tally(label: string, { rounds, tokens, cached, cost, missingTokens, missingCost }: Spending) {
  if (!rounds) return `${label} 0 rodadas`;
  const notes = (...said: string[]) => (said.some(Boolean) ? ` (${said.filter(Boolean).join("; ")})` : "");
  const missing = (silent: number) => (silent ? `${silent} ${silent === 1 ? "rodada" : "rodadas"} sem relatório` : "");
  // Lido de um cache, um token custa uma fração do preço, então um total feito sobretudo deles exagera a conta.
  // Rodadas registradas antes de o input do Claude passar a incluir o cache podem dar uma parcela maior que o todo; essas não dizem nada.
  const fromCache = cached > 0 && cached <= tokens ? `${Math.round((cached / tokens) * 100)}% em cache` : "";
  const shownTokens =
    missingTokens === rounds
      ? "Tokens sem relatório"
      : `${count.format(tokens).replace(/\u00a0/g, " ")} Tokens${notes(fromCache, missing(missingTokens))}`;
  const shownCost = missingCost === rounds ? "Custo sem relatório" : `${dollars(cost)}${notes(missing(missingCost))}`;
  return `${label} ${rounds} ${rounds === 1 ? "rodada" : "rodadas"} · ${shownTokens} · ${shownCost}`;
}

/** Duas linhas, com os rótulos preenchidos até a mesma largura de terminal para os números ficarem alinhados. */
export function spendLines(spending: { today: Spending; week: Spending }) {
  return [tally("Hoje          ", spending.today), tally("Últimos 7 dias", spending.week)];
}
