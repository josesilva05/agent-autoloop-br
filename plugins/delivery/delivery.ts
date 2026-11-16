// Um pull request do rótulo até a produção: revisão, check completo, merge, Ship, health. Cada passo relê o estado do
// GitHub em vez de confiar na própria última resposta, e uma falha é deixada para a nova tentativa da central retomar
// de onde parou.
import { settings, type Live, type Settings } from "./project.ts";
import type { Finding, Reviewed } from "./review.ts";

export type DeliveryIO = {
  api(path: string, body?: any, method?: string): Promise<any>;
  review(pr: any, config: Settings, main: string): Promise<Reviewed>;
  verifyReview?(pr: any, config: Settings, main: string): Promise<Reviewed>;
  merge(pr: any, config: Settings): Promise<void>;
  enableAuto?(pr: any): Promise<void>;
  disableAuto(number: number): Promise<void>;
  verifyTools?(head: string): Promise<string | null>;
  contains(base: string, head: string): Promise<boolean>;
  prepareShip?(): void | Promise<void>;
  releaseRequired(base: string, head: string, patterns: string[]): Promise<boolean>;
  live(config: Settings): Promise<Live | null>;
  wait(): Promise<void>;
  now?(): number;
  checkRecovery?: { head: string; after: number };
  reviewStatus?: string;
  report?: DeliveryReport;
};
export type DeliveryPhase =
  | "accepted"
  | "reviewing"
  | "checking"
  | "merging"
  | "shipping"
  | "live"
  | "merged"
  | "reviewed"
  | "returned"
  | "withdrawn"
  | "retrying"
  | "docs_only";
export type DeliveryReport = (
  phase: DeliveryPhase,
  head: string,
  metadata?: { merge?: string; ship?: number; detail?: string },
) => void | Promise<void>;
export type Delivered = { summary: string; merged?: string; reviewOnly?: boolean; findings?: Finding[]; head?: string };

export class DeliveryRefusal extends Error {
  readonly head?: string;

  constructor(message: string, head?: string) {
    super(message);
    this.head = head;
  }
}

export class DeliverySuperseded extends Error {}

const FINDINGS = "A revisão encontrou problemas; só é revisada de novo após um push com novos commits corrigidos";
const STALL = 10 * 60_000;
const labels = (pr: any) => new Set<string>((pr.labels ?? []).map((label: any) => label.name));
const newestFirst = (a: any, b: any) => b.id - a.id;

export const status = (io: DeliveryIO, head: string, context: string, state: string, description: string) =>
  io.api(`statuses/${head}`, { state, context, description: [...description].slice(0, 140).join("") }, "POST");

export async function disableAuto(number: number, io: DeliveryIO) {
  let cause: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await io.disableAuto(number);
    } catch (error) {
      /* Uma resposta de mutação perdida precisa ser relida, não presumida. */
      cause = error;
    }
    try {
      if (!(await io.api(`pulls/${number}`)).auto_merge) return;
    } catch (error) {
      /* Falha conhecida: uma releitura que falhou ainda precisa confirmar o cancelamento em três tentativas. */
      cause = error;
    }
    if (attempt < 2) await io.wait();
  }
  throw new Error("não foi possível confirmar que o merge automático foi encerrado", { cause });
}

async function newestCheck(head: string, config: Settings, io: DeliveryIO) {
  const query = `head_sha=${head}&event=pull_request&per_page=100`;
  const { workflow_runs: runs } = await io.api(`actions/workflows/${config.check.workflow}/runs?${query}`);
  return runs.filter((run: any) => run.head_sha === head && run.event === "pull_request").sort(newestFirst)[0];
}

export async function fullCheck(
  head: string,
  config: Settings,
  io: DeliveryIO,
  after = 0,
): Promise<"passed" | "waiting" | "failed" | "stalled"> {
  const { job } = config.check;
  const run = await newestCheck(head, config, io);
  if (!run || run.id <= after) return "waiting";
  const { jobs } = await io.api(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
  if (
    !jobs.length &&
    ["queued", "waiting", "pending"].includes(run.status) &&
    (io.now?.() ?? Date.now()) - Date.parse(run.created_at) > STALL
  )
    return "stalled";
  const required = jobs.filter((candidate: any) => candidate.name === job || candidate.name.startsWith(`${job} (`));
  if (!required.length) return "waiting";
  if (run.status === "completed" && run.conclusion !== "success") return "failed";
  const finished = (item: any) => item.status === "completed" && item.conclusion === "success";
  return finished(run) && required.every(finished) ? "passed" : "waiting";
}

export async function waitLive(merged: string, config: Settings, io: DeliveryIO, head?: string) {
  if (!config.health) return;
  if (head) await io.report?.("shipping", head, { merge: merged });
  await io.prepareShip?.();
  const query = "branch=main&event=push&per_page=100";
  let ship: number | undefined;
  for (;;) {
    const { workflow_runs } = await io.api(`actions/workflows/${config.ship.workflow}/runs?${query}`);
    const runs = workflow_runs.sort(newestFirst);
    const covering = [];
    for (const run of runs) if (run.event === "push" && (await io.contains(merged, run.head_sha))) covering.push(run);
    const newest = covering[0];
    if (head && newest && newest.id !== ship) {
      ship = newest.id;
      await io.report?.("shipping", head, { merge: merged, ship });
    }
    const live = await io.live(config);
    if (live) {
      for (const run of covering) {
        if (run.status !== "completed" || run.conclusion !== "success") continue;
        const liveHasIt = await io.contains(run.head_sha, live.sha);
        if (liveHasIt) return { phase: "live" as const, ship: run.id as number, release: live.release };
        if (!(await io.releaseRequired(live.sha, run.head_sha, config.internal)))
          return { phase: "docs_only" as const, ship: run.id as number, release: live.release };
      }
    }
    if (newest?.status === "completed" && newest.conclusion !== "success") {
      throw new DeliveryRefusal(
        `O merge já foi feito, mas a publicação não passou: ${newest.html_url}. Corrija a publicação e reentregue a mesma mudança.`,
        head,
      );
    }
    await io.wait();
  }
}

async function clearLabels(number: number, pr: any, io: DeliveryIO) {
  // Uma nova tentativa se guia pelo que continuou marcado. Um PR com merge só segue para a publicação enquanto tiver
  // `deliver`; um aberto só com `deliver` é uma entrega completa, então um de só-revisão precisa perder
  // `deliver-review` por último, senão a nova tentativa faz o merge dele.
  const order = pr.merged_at ? ["deliver-review", "deliver"] : ["deliver", "deliver-review"];
  for (const label of ["deliver-attended", ...order]) {
    if (!labels(pr).has(label)) continue;
    try {
      await io.api(`issues/${number}/labels/${label}`, undefined, "DELETE");
    } catch (error) {
      // O GitHub devolveu 404 depois que um PR marcado e observado já concluiu o Ship; confira o estado desejado.
      if (labels(await io.api(`pulls/${number}`)).has(label)) throw error;
    }
  }
}

async function synced(number: number, head: string, base: string, io: DeliveryIO) {
  const until = Date.now() + 15 * 60_000;
  for (;;) {
    const pr = await io.api(`pulls/${number}`);
    if (pr.merged_at) return pr;
    if (pr.head.sha !== head && (await io.contains(base, pr.head.sha))) return pr;
    if (Date.now() > until)
      throw new Error(
        "A sincronização com a main foi solicitada, mas nenhum commit sincronizado apareceu em 15 minutos; tente de novo mais tarde",
      );
    await io.wait();
  }
}

export async function deliver(
  repo: string,
  number: number,
  io: DeliveryIO,
  testLocalHealth = false,
): Promise<Delivered> {
  const reviewOnly = async (pr: any): Promise<Delivered> => {
    const summary = "Revisão aprovada, sem merge nem publicação";
    await status(io, pr.head.sha, "delivery", "success", summary);
    await clearLabels(number, pr, io);
    await io.report?.("reviewed", pr.head.sha);
    return { summary, reviewOnly: true };
  };
  const withdrawn = async (head: string): Promise<Delivered> => {
    await status(io, head, "delivery", "success", "o rótulo de entrega foi retirado; sem merge nem publicação");
    await io.report?.("withdrawn", head);
    return { summary: "o rótulo de entrega foi retirado" };
  };
  let pr = await io.api(`pulls/${number}`);
  if (!labels(pr).has("deliver") || (!pr.merged_at && pr.state !== "open"))
    return { summary: "não há rótulo de entrega pendente" };
  if (pr.head.repo?.full_name !== repo || pr.base.ref !== "main")
    throw new DeliveryRefusal("Só são tratados pull requests de branches deste repositório para a main", pr.head.sha);
  if (pr.auto_merge) await disableAuto(number, io);
  let head: string = pr.head.sha;
  const accept = async () => {
    await status(io, head, "delivery", "pending", "Revisando, verificando os checks e confirmando a publicação");
    await io.report?.("accepted", head);
  };
  if (io.verifyReview) await accept();
  const settingsAt = async (commit: string) => {
    const file = await io.api(`contents/ops/delivery.json?ref=${commit}`);
    const read = settings(JSON.parse(Buffer.from(file.content, "base64").toString("utf8")), testLocalHealth);
    if (read.repo !== repo) throw new Error("O repo configurado na main não é o mesmo do repositório de entrega");
    if (io.reviewStatus) read.review.status = io.reviewStatus;
    return read;
  };
  let config = await settingsAt((await io.api("git/ref/heads/main")).object.sha);
  if (!pr.merged_at && !io.verifyReview) {
    // O rótulo continua depois dos problemas encontrados, então outro evento cai aqui: uma segunda revisão que não
    // os visse faria o merge do commit.
    // O status de revisão guarda o registro, já que uma rodada que falhou escreve o erro por cima de `delivery`.
    const { statuses } = await io.api(`commits/${head}/status?per_page=100`);
    if (statuses.some((item: any) => item.context === config.review.status && item.state === "failure"))
      return {
        summary:
          "A revisão deste commit já encontrou problemas; só é revisado de novo após um push com novos commits corrigidos",
      };
  }
  if (!io.verifyReview) await accept();
  // Sincronizar dentro da execução: uma sincronização lançada como erro espera passar o backoff crescente de novas
  // tentativas da central enquanto a main continua avançando.
  rounds: for (let round = 1; !pr.merged_at; round++) {
    if (pr.mergeable === false || pr.mergeable_state === "dirty")
      throw new DeliveryRefusal("A mudança tem conflito de merge com a main; resolva primeiro e reentregue.", head);
    let base = (await io.api("git/ref/heads/main")).object.sha;
    if (!(await io.contains(base, head))) {
      try {
        await io.api(`pulls/${number}/update-branch`, { expected_head_sha: head }, "PUT");
      } catch (error) {
        const live = await io.api(`pulls/${number}`);
        if (!live.merged_at && live.head.sha === head) throw error;
      }
      pr = await synced(number, head, base, io);
      if (pr.merged_at) break;
      if (!(await io.contains(head, pr.head.sha)))
        throw new DeliverySuperseded(
          "O branch sincronizado não contém mais o commit original; aguardando nova entrega",
        );
      head = pr.head.sha;
      await status(
        io,
        head,
        "delivery",
        "pending",
        "Main sincronizada; revisando, verificando os checks e confirmando a publicação",
      );
      // O GitHub sincroniza com a main como ela estiver naquele momento, que pode ser mais nova do que a lida acima:
      // contra a mais antiga, aqueles commits seriam revisados como se fossem do próprio branch.
      base = (await io.api("git/ref/heads/main")).object.sha;
      if (!(await io.contains(base, head))) {
        if (round < 3) continue;
        throw new Error("A main avançou; sincronize e verifique de novo mais tarde");
      }
    }
    // As configurações da main contra a qual esta rodada corre: uma mais nova pode acrescentar o health check que a
    // publicação dela precisa aprovar.
    config = await settingsAt(base);
    const reviewed = await io.review(pr, config, base);
    const exempt = !Array.isArray(reviewed) && "exempt" in reviewed ? reviewed.exempt : null;
    const findings = Array.isArray(reviewed) ? reviewed : [];
    const current = await io.api(`pulls/${number}`);
    if (current.merged_at) {
      pr = current;
      break;
    }
    if (current.head.sha !== head)
      throw new DeliverySuperseded("O commit mudou durante a revisão; aguardando nova entrega");
    if (!Array.isArray(reviewed) && "blocked" in reviewed) {
      await status(io, head, config.review.status, "failure", reviewed.blocked);
      throw new DeliveryRefusal(reviewed.blocked, head);
    }
    if (!Array.isArray(reviewed) && "changed" in reviewed) {
      pr = current;
      continue;
    }
    if (findings.length) {
      await status(io, head, "delivery", "failure", FINDINGS);
      // Por último: depois disto registrado, nada mais revisa o commit, então uma escrita que falhe não pode impedir
      // que os problemas encontrados sejam publicados.
      await status(io, head, config.review.status, "failure", FINDINGS);
      return { summary: "a revisão encontrou problemas; merge ainda não feito", findings, head };
    }
    if (labels(current).has("deliver-review")) {
      if (!exempt) return reviewOnly(current);
      // Pedida depois que esta rodada deixou a mudança passar sem revisão: a próxima rodada a revisa.
      pr = current;
      continue;
    }
    await io.report?.("checking", head);
    let after = io.checkRecovery?.head === head ? io.checkRecovery.after : 0;
    if (current.draft) {
      // Logo depois de sair de draft, a execução mais nova ainda é uma do tempo de draft: só uma execução iniciada
      // pela mudança pode aprovar.
      after = (await newestCheck(head, config, io))?.id ?? 0;
      if (io.checkRecovery?.head === head) io.checkRecovery.after = after;
      await io.api(`pulls/${number}/ready`, {}, "POST");
    }
    let merging = false;
    let autoRequested = false;
    const stopAuto = async () => {
      if (pr.auto_merge || autoRequested) {
        await disableAuto(number, io);
        pr.auto_merge = null;
        autoRequested = false;
      }
    };
    try {
      for (;;) {
        const state = await fullCheck(head, config, io, after);
        pr = await io.api(`pulls/${number}`);
        if (pr.merged_at) break rounds;
        if (pr.head.sha !== head) {
          throw new DeliverySuperseded("O commit mudou durante os checks; aguardando nova entrega");
        }
        if (pr.base.ref !== "main" || pr.state !== "open") {
          throw new DeliveryRefusal(
            "a mudança foi fechada ou o branch de destino mudou; o merge é só para o main.",
            head,
          );
        }
        if (pr.mergeable === false || pr.mergeable_state === "dirty") {
          throw new DeliveryRefusal("A mudança tem conflito de merge com a main; resolva primeiro e reentregue.", head);
        }
        if (!labels(pr).has("deliver")) {
          await stopAuto();
          return withdrawn(head);
        }
        if (labels(pr).has("deliver-review")) {
          await stopAuto();
          if (!exempt && !io.verifyReview) return reviewOnly(pr);
          continue rounds;
        }
        if (state === "stalled") {
          if (io.checkRecovery?.head === head)
            throw new DeliveryRefusal(
              "O GitHub aceitou o check, mas ele nunca começou (provável incidente); já foi reacionado e segue parado. Reentregue quando o GitHub voltar.",
              head,
            );
          await stopAuto();
          await io.api(`pulls/${number}/draft`, {}, "POST");
          io.checkRecovery = { head, after };
          // Converter para draft pode iniciar outra execução. Só uma execução criada depois de sair de draft pode
          // autorizar o merge.
          after = (await newestCheck(head, config, io))?.id ?? 0;
          io.checkRecovery.after = after;
          await io.api(`pulls/${number}/ready`, {}, "POST");
          continue;
        }
        if (state === "failed") {
          throw new DeliveryRefusal(
            `O check completo não passou. Veja https://github.com/${repo}/pull/${number}/checks`,
            head,
          );
        }
        if (state === "passed" || pr.auto_merge) {
          if ((await io.api("git/ref/heads/main")).object.sha !== base) {
            await stopAuto();
            if (round < 3) continue rounds;
            throw new Error("A main avançou; sincronize e verifique de novo mais tarde");
          }
          const behind = await io.verifyTools?.(head);
          if (behind) throw new DeliveryRefusal(behind, head);
          const verified = await io.verifyReview?.(pr, config, base);
          if (verified) {
            if (!Array.isArray(verified) && "blocked" in verified) {
              await stopAuto();
              await status(io, head, config.review.status, "failure", verified.blocked);
              throw new DeliveryRefusal(verified.blocked, head);
            }
            const recheckedExempt = !Array.isArray(verified) && "exempt" in verified ? verified.exempt : null;
            if ((!Array.isArray(verified) && "changed" in verified) || recheckedExempt !== exempt) {
              await stopAuto();
              continue rounds;
            }
          }
          if (state === "passed" && !pr.auto_merge) {
            const checked = pr;
            pr = await io.api(`pulls/${number}`);
            if (pr.merged_at) break rounds;
            if (pr.head.sha !== head)
              throw new DeliverySuperseded("O commit a ser mesclado mudou; aguardando nova entrega");
            if (pr.base.ref !== "main" || pr.state !== "open")
              throw new DeliveryRefusal(
                "a mudança foi fechada ou o branch de destino mudou; o merge é só para o main.",
                head,
              );
            if (!labels(pr).has("deliver")) {
              await stopAuto();
              return withdrawn(head);
            }
            if (pr.body !== checked.body || labels(pr).has("deliver-review") || pr.auto_merge) {
              await stopAuto();
              continue rounds;
            }
            const passed = exempt
              ? `Mudança escrita por ${exempt}, dispensada de revisão pela política`
              : !Array.isArray(reviewed) && "docsOnly" in reviewed
                ? "Só documentos internos alterados, dispensado de revisão pela política"
                : "Revisão deste commit aprovada";
            await status(io, head, config.review.status, "success", `${passed}, check completo aprovado`);
            if (!merging) await io.report?.("merging", head);
            merging = true;
            const auto = io.enableAuto && !config.admin_merge.includes(pr.user.login) ? io.enableAuto : undefined;
            try {
              if (auto) {
                autoRequested = true;
                await auto(pr);
              } else await io.merge(pr, config);
            } catch (error) {
              // A requisição pode ser aceita antes de a resposta dela se perder. Releia antes de qualquer nova
              // tentativa.
              pr = await io.api(`pulls/${number}`);
              if (!pr.merged_at && !(auto && pr.auto_merge)) throw error;
            }
            pr = await io.api(`pulls/${number}`);
            if (pr.merged_at) break rounds;
            if (!auto || !pr.auto_merge)
              throw new Error("Merge ainda não confirmado; continue a verificação mais tarde");
          }
        }
        await io.wait();
      }
    } catch (error) {
      await stopAuto();
      throw error;
    }
  }
  const merge = pr.merge_commit_sha;
  const shipped = await waitLive(merge, config, io, pr.head.sha);
  const summary = !shipped
    ? "Merge feito; o projeto não tem serviço em produção"
    : shipped.phase === "docs_only"
      ? `Apenas documentos internos mudaram, merge feito, sem publicação necessária. Versão em produção confirmada: ${shipped.release}`
      : `Publicado, com a versão em produção confirmada: ${shipped.release}`;
  await status(io, pr.head.sha, "delivery", "success", summary);
  await clearLabels(number, pr, io);
  await io.report?.(shipped?.phase ?? "merged", pr.head.sha, { merge, ship: shipped?.ship });
  return { summary, merged: merge };
}
