import { createHash } from "node:crypto";
import { AGENT, REPO, type Reviewer, type Settings } from "./project.ts";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
export type NamedReviewer = Reviewer & { name: string };
export type SharedPolicy = {
  trusted_submitters: number[];
  reviewers: Record<string, Required<Pick<Reviewer, "model" | "effort">>>;
  default: string[];
  agents: Record<string, string[]>;
};

const isObject = (value: any) => value && typeof value === "object" && !Array.isArray(value);

export function sharedPolicy(value: any): SharedPolicy {
  const bad = () => {
    throw new Error(
      "A política de revisão compartilhada está incorreta: verifique revisores, profundidade, contas confiáveis e a lista de revisão padrão não vazia",
    );
  };
  if (!isObject(value) || Object.keys(value).sort().join() !== "agents,default,reviewers,trusted_submitters") bad();
  const { trusted_submitters, reviewers, agents, default: fallback } = value;
  if (!Array.isArray(trusted_submitters) || !trusted_submitters.every((id) => Number.isSafeInteger(id) && id > 0))
    bad();
  if (!isObject(reviewers) || !isObject(agents)) bad();
  const validPlan = (plan: any) =>
    Array.isArray(plan) && plan.every((name) => typeof name === "string" && Object.hasOwn(reviewers, name));
  if (!validPlan(fallback) || !fallback.length) bad();
  for (const [agent, plan] of Object.entries(agents)) if (!AGENT.test(agent) || !validPlan(plan)) bad();
  const normalized = Object.fromEntries(
    Object.entries(reviewers).map(([name, raw]) => {
      const reviewer: any = typeof raw === "string" ? { model: raw, effort: "high" } : raw;
      if (
        !AGENT.test(name) ||
        !isObject(reviewer) ||
        Object.keys(reviewer).sort().join() !== "effort,model" ||
        typeof reviewer.model !== "string" ||
        !MODEL.test(reviewer.model) ||
        !EFFORTS.includes(reviewer.effort)
      )
        bad();
      return [name, reviewer];
    }),
  );
  return { trusted_submitters, reviewers: normalized, agents, default: fallback };
}

export async function readSharedPolicy(spec: string, apiFor: (repo: string) => (path: string) => Promise<any>) {
  const [repo, path, ...rest] = spec.split(":");
  if (
    !REPO.test(repo) ||
    !path ||
    rest.length ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(
      "A política de revisão compartilhada deve ser escrita como owner/repo:caminho dentro do repositório",
    );
  const { content } = await apiFor(repo)(`contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=main`);
  return sharedPolicy(JSON.parse(Buffer.from(content, "base64").toString("utf8")));
}

export function selectReview(
  config: Settings,
  agent: string | null,
  required: boolean,
  policy?: SharedPolicy,
): NamedReviewer[] {
  if (policy) {
    const selected = agent && Object.hasOwn(policy.agents, agent) ? policy.agents[agent] : policy.default;
    return (required && !selected.length ? policy.default : selected).map((name) => ({
      name,
      ...policy.reviewers[name],
    }));
  }
  const listed = agent !== null && Object.hasOwn(config.review.agents, agent) ? config.review.agents[agent] : undefined;
  const reviewer = listed === undefined || (listed === null && required) ? { command: config.review.command } : listed;
  return reviewer ? [{ name: "codex", ...reviewer }] : [];
}

export function reviewSignature(reviewers: NamedReviewer[]) {
  const model = "gpt-6.1-sol";
  if (reviewers.length === 1) {
    const [reviewer] = reviewers;
    // Usa o mesmo nome que as rodadas mais antigas registravam para o plano padrão.
    if (
      reviewer.name === "codex" &&
      (reviewer.model ?? model) === model &&
      (reviewer.effort ?? "high") === "high" &&
      !reviewer.command
    )
      return model;
  }
  return reviewers
    .map(({ name, model: selected = model, effort = "high", command }) => {
      if (command) return `command/${createHash("sha256").update(JSON.stringify(command)).digest("hex")}`;
      return `${name}/${selected}${effort === "high" ? "" : `@${effort}`}`;
    })
    .join(" + ");
}
