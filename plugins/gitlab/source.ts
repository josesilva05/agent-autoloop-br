// Webhooks do GitLab, conferidos contra o token de segredo do projeto e convertidos em eventos: `merge_request.open`,
// `issue.close`, `push`, `note` e assim por diante, com o número do objeto como subject. No rules.json:
//   "sources": { "gitlab": { "name": "GitLab", "adapter": "gitlab" } }, e AGENT_AUTOLOOP_SECRET_GITLAB no secrets.env.
import { createHash, timingSafeEqual } from "node:crypto";

type Input = { headers: Record<string, string | string[] | undefined>; body: string; secret: string };

export default function gitlab({ headers, body, secret }: Input) {
  const given = String(headers["x-gitlab-token"] ?? "");
  const signed = secret && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!signed) throw new Error("signature");
  const payload = JSON.parse(body);
  const kind = String(payload.object_kind ?? headers["x-gitlab-event"] ?? "");
  const attributes = payload.object_attributes ?? {};
  const type = (attributes.action ? `${kind}.${attributes.action}` : kind).toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  const project = payload.project ?? {};
  const repo = String(project.path_with_namespace ?? project.name ?? "");
  const object = kind === "note" ? (payload.merge_request ?? payload.issue ?? attributes) : attributes;
  const number = object.iid ? `#${object.iid}` : "";
  return [
    {
      // O GitLab anterior ao 17.4 não tem este cabeçalho. O corpo é o mesmo numa nova tentativa e difere entre eventos.
      id: String(headers["idempotency-key"] ?? createHash("sha256").update(body).digest("hex")),
      type,
      subject: `${repo}${number}`.replace(/[^A-Za-z0-9#._:/@-]/g, "-").slice(0, 100),
      summary: String(attributes.title ?? payload.commits?.[0]?.message ?? "").slice(0, 200),
      detail: String(attributes.description ?? attributes.note ?? "").slice(0, 4000),
      link: encodeURI(String(attributes.url ?? project.web_url ?? "")).slice(0, 500),
    },
  ];
}
