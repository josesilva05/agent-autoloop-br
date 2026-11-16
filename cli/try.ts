// O que serve de base ao `try`. Uma rodada só volta a ficar na fila por ter falhado, e ali permanece até a nova tentativa,
// absorvendo nesse intervalo qualquer evento novo da sua regra: por isso a mesma rodada pode ser a deste try, e só o número
// de tentativas distingue uma falha antiga de uma nova.
export type TryRun = { id: number; rule: string; state: string; attempts: number; error: string; notBefore: string };

const failed = (run: TryRun) => run.rule === "experimente" && run.state === "queued" && run.attempts > 0;

/** Uma rodada que ainda espera a nova tentativa quando este try começa. */
export const waitingRetry = (runs: TryRun[]) => runs.find(failed);

export const attemptsOf = (runs: TryRun[]) => new Map(runs.map((run) => [run.id, run.attempts]));

/** Uma rodada que falhou depois de aquelas tentativas terem sido contadas. */
export const newFailure = (runs: TryRun[], before: Map<number, number>) =>
  runs.find((run) => failed(run) && run.attempts > (before.get(run.id) ?? 0));
