// Webhooks do GitLab. Modos de falha: um token errado ou ausente é aceito; a action não entra no type do evento; uma
// entrega repetida conta duas vezes; um evento posterior sobre o mesmo merge request é descartado como duplicata de um
// anterior; comentários em issues ou merge requests diferentes desabam no mesmo subject de todo o repositório.
import assert from "node:assert/strict";
import { test } from "node:test";
import gitlab from "../plugins/gitlab/source.ts";

const secret = "test-secret";
const headers = (extra: Record<string, string | undefined> = {}) => ({
  "x-gitlab-token": secret,
  "idempotency-key": "evt-12345",
  ...extra,
});
const noKey = headers({ "idempotency-key": undefined });

const mergeRequest = (action: string) =>
  JSON.stringify({
    object_kind: "merge_request",
    object_attributes: {
      id: 98765,
      iid: 42,
      action,
      title: "Corrige o fluxo de login",
      url: "https://gitlab.com/org/proj/merge_requests/42",
      description: "Corrige o fluxo de login no celular.",
    },
    project: { path_with_namespace: "org/proj", web_url: "https://gitlab.com/org/proj" },
  });

test("gitlab: um evento de merge request carrega sua action, subject e texto", () => {
  const [event] = gitlab({ headers: headers(), body: mergeRequest("open"), secret });
  assert.equal(event.type, "merge_request.open");
  assert.equal(event.subject, "org/proj#42");
  assert.equal(event.summary, "Corrige o fluxo de login");
  assert.equal(event.detail, "Corrige o fluxo de login no celular.");
  assert.equal(event.link, "https://gitlab.com/org/proj/merge_requests/42");
  assert.equal(event.id, "evt-12345");
});

test("gitlab: um push não tem número no subject", () => {
  const body = JSON.stringify({
    object_kind: "push",
    commits: [{ message: "Adiciona uma coisa" }],
    project: { path_with_namespace: "org/proj", web_url: "https://gitlab.com/org/proj" },
  });
  const [event] = gitlab({ headers: headers(), body, secret });
  assert.equal(event.type, "push");
  assert.equal(event.subject, "org/proj");
  assert.equal(event.summary, "Adiciona uma coisa");
});

test("gitlab: comentários mantêm o subject da sua issue ou do seu merge request", () => {
  // https://docs.gitlab.com/user/project/integrations/webhook_events/#comment-events
  for (const target of ["issue", "merge_request"]) {
    for (const iid of [42, 43]) {
      const object = { id: 98765 + iid, iid, title: "Corrige o fluxo de login" };
      const project = { path_with_namespace: "org/proj" };
      const [opened] = gitlab({
        headers: noKey,
        body: JSON.stringify({ object_kind: target, project, object_attributes: { ...object, action: "open" } }),
        secret,
      });
      const [comment] = gitlab({
        headers: noKey,
        body: JSON.stringify({
          object_kind: "note",
          project,
          object_attributes: {
            id: 12345,
            note: "Verifique o login no celular",
            noteable_type: target === "issue" ? "Issue" : "MergeRequest",
            noteable_id: object.id,
            action: "create",
            url: `https://gitlab.com/org/proj/${target}s/${iid}#note_12345`,
          },
          [target]: object,
        }),
        secret,
      });
      assert.equal(comment.subject, `org/proj#${iid}`);
      assert.equal(comment.subject, opened.subject);
      assert.equal(comment.type, "note.create");
      assert.equal(comment.detail, "Verifique o login no celular");
      assert.equal(comment.link, `https://gitlab.com/org/proj/${target}s/${iid}#note_12345`);
    }
  }
});

test("gitlab: sem Idempotency-Key, uma nova tentativa mantém o id e um evento posterior ganha o seu", () => {
  const id = (body: string) => gitlab({ headers: noKey, body, secret })[0].id;
  assert.equal(id(mergeRequest("open")), id(mergeRequest("open")));
  assert.notEqual(id(mergeRequest("open")), id(mergeRequest("update")));
});

test("gitlab: um token errado ou ausente é recusado", () => {
  const body = mergeRequest("open");
  assert.throws(() => gitlab({ headers: { "x-gitlab-token": "wrong-secret" }, body, secret }), /signature/);
  assert.throws(() => gitlab({ headers: {}, body, secret }), /signature/);
  assert.throws(() => gitlab({ headers: headers(), body, secret: "" }), /signature/);
});
