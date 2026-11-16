import assert from "node:assert/strict";
import type { Server } from "node:http";

// Anexe o manipulador de rejeição antes de iniciar o próximo lote; senão o Node encerra antes da limpeza.
export const observe = <T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> =>
  promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );

export function observePolls(server: Server) {
  const count = { active: 0, peak: 0 };
  server.prependListener("request", (req, res) => {
    if (!/^\/v1\/work\?wait=50?&/.test(req.url ?? "")) return;
    count.peak = Math.max(count.peak, ++count.active);
    res.once("close", () => count.active--);
  });
  return count;
}

export async function dispatchLatency(
  request: (path: string, key: string, body?: unknown) => Promise<any>,
  ready: () => Promise<void>,
  id: number,
) {
  const pending = observe(request(`/v1/work?wait=5&claim=claim${id}`, "worker"));
  await ready();
  const at = performance.now();
  await request("/v1/events", "source", { id: `claim:${id}`, type: "feedback.new", subject: `#${id}` });
  const result = await pending;
  if (result.status === "rejected") throw result.reason;
  assert.ok(result.value.job);
  return { job: result.value.job, ms: performance.now() - at };
}

/** O valor no qual, ou abaixo do qual, esta parcela das amostras fica; com amostras de menos, a mais próxima acima dele. */
export function percentile(values: number[], share: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * share) - 1)];
}

/** Executa uma ação até count vezes, ou até esgotar o tempo, e mede quanto cada uma levou. Nunca menos de uma vez. */
export async function timed(count: number, budgetMs: number, action: (index: number) => Promise<unknown>) {
  const took: number[] = [];
  const start = performance.now();
  while (took.length < count && (!took.length || performance.now() - start < budgetMs)) {
    const at = performance.now();
    await action(took.length);
    took.push(performance.now() - at);
  }
  return took;
}

export function checkPolls(count: { active: number; peak: number }, completed: number) {
  assert.equal(count.active, 1000, "precisa haver 1000 long polls aguardando ao mesmo tempo");
  assert.equal(completed, 1000, "precisa haver 1000 respostas bem-sucedidas");
}
