// O próximo instante em que cada coisa precisa do relógio: agendamentos, reverificações, novas tentativas, reenvios de
// cartão, um worker que silenciou, um lease que expirou. O host mantém um timer só, o mais cedo deles: nada consulta.
import { rows, type Row, type View } from "./evolve.ts";
import { configuration, waitingOn, workers } from "./query.ts";

export const MINUTE = 60_000;
/** Um worker visto há tão pouco tempo está mesmo lá, então uma rodada que ele parou de mencionar silenciou mesmo. */
export const WORKER_FRESH = 2 * MINUTE;
/** Por quanto tempo uma rodada assumida pode ficar sem ser mencionada pelo seu worker antes de entrar em dúvida. */
export const RUN_LEASE = 5 * MINUTE;
/** Por quanto tempo o trabalho pode esperar por um worker que não aparece antes de o titular ficar sabendo. */
export const OFFLINE_AFTER = 10 * MINUTE;
/**
 * Com que frequência o "foi visto" entra no registro. Um worker pede a cada segundo com trabalho em mãos e um fato é
 * uma sincronização de disco, então uma marcação pode ficar atrás do último contato por até isso. Ela tem que ficar
 * abaixo do que a lê: com os 50 segundos entre consultas ociosas, abaixo de WORKER_FRESH; e abaixo de
 * RUN_LEASE - WORKER_FRESH, senão uma rodada pode parecer silenciada enquanto o worker dela ainda parece estar lá.
 */
export const SEEN_EVERY = MINUTE;

/**
 * O cartão sobre um worker que sumiu, e se ele já disse tudo o que havia para dizer: ainda está aberto, ou o titular
 * o fechou depois que tudo o que espera agora já chegou. O que é mais novo é novidade, senão um cartão fechado o
 * esconderia até o worker voltar.
 */
export function offlineCard(view: View, worker: string, waiting: Row[]) {
  const seen = view.get("seen", `worker:${worker}`);
  const key = `worker:${worker}:offline:${seen ? seen.seen_at : "never"}`;
  const card = rows(view, "cards", { key }, 1, true)[0];
  const told = card && (card.state === "open" || waiting.every((run) => run.created_at <= card.closed_at));
  return { key, told };
}

export function deadlines(view: View, now: number) {
  const due: Record<string, Row> = {};
  const add = (kind: string, key: string, at: number) => {
    due[`${kind}:${key}`] = { kind, key, at };
  };
  const scheduled = (rule: string) =>
    configuration(view).rules.some((known) => known.name === rule && "cron" in known.when);
  for (const schedule of rows(view, "schedules")) {
    if (scheduled(schedule.rule)) add("cron", schedule.rule, Date.parse(schedule.next_at));
  }
  for (const pause of rows(view, "pauses")) {
    if (pause.until !== null) add("pause", pause.name, Date.parse(pause.until));
  }
  for (const timer of rows(view, "timers", { event_id: null })) add("later", String(timer.id), Date.parse(timer.at));
  for (const run of rows(view, "runs", { state: "queued" })) {
    const notBefore = Date.parse(run.not_before);
    if (notBefore > now) add("retry", String(run.id), notBefore);
  }
  for (const delivery of rows(view, "deliveries", { given_up: 0, not_before: { not: null } })) {
    const notBefore = Date.parse(delivery.not_before);
    if (notBefore > now) add("delivery", `${delivery.card_id}:${delivery.channel}`, notBefore);
  }
  for (const worker of workers(view)) {
    const seen = view.get("seen", `worker:${worker}`);
    const waiting = waitingOn(view, worker, now);
    if (!waiting.length) continue;
    // A varredura age estritamente depois de cada limite, daí o milissegundo extra.
    if (!offlineCard(view, worker, waiting).told) {
      add("offline", worker, Math.max(now, Date.parse(seen?.seen_at ?? waiting[0].created_at) + OFFLINE_AFTER + 1));
    }
    if (!seen || now - Date.parse(seen.seen_at) > WORKER_FRESH) continue;
    for (const run of waiting.filter((run) => run.state === "claimed")) {
      const at = Math.max(now, Date.parse(run.seen_at) + RUN_LEASE + 1);
      if (at <= Date.parse(seen.seen_at) + WORKER_FRESH) add("lease", String(run.id), at);
    }
  }
  return due;
}
