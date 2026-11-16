#!/bin/sh
# De tempos em tempos dá uma olhada se há issues novos no GitHub e não gasta token quando não há nada novo.
# Funciona com a central em casa, mesmo sem acesso à internet pública.
#
#   "agents": { "watcher": { "name": "Polling", "worker": "my-mac", "use": "command", "command": ["/caminho/absoluto/watch-github-issues.sh", "owner/repo", "created:>=YYYY-MM-DDT00:00:00+08:00"] } }
#   "rules": [
#     { "name": "Ver novos issues", "when": { "cron": "*/5 * * * *" }, "to": "watcher", "cwd": "~/", "tell": "never", "emits": { "source": "github", "types": ["issues.opened"] } },
#     { "name": "Tratar issue", "when": { "source": "github", "types": ["issues.opened"] }, "to": "claude", "cwd": "~/code/app", "skill": "handle-issue", "parallel": 1 }
#   ]
#
# O segundo parâmetro é opcional e é uma condição de busca do GitHub: created:>=data vê apenas os issues abertos a partir
# desse dia (o GitHub calcula as datas em UTC; só com T00:00:00+08:00 o dia é o do fuso Asia/Shanghai, horário de Pequim),
# e label:agent vê apenas os que têm esse rótulo. Sem ele, todos os issues abertos.
# Nenhum cursor é mantido: cada execução lê os mais recentes, o id dos eventos é estável e a central registra as
# repetições uma única vez.
# Um exemplo pronto está em examples/recipes/github-issues.
set -e
REPO="$1"
SEARCH="${2:-}"
EVENTS=$(gh issue list --repo "$REPO" --state open --limit 30 ${SEARCH:+--search "$SEARCH"} --json number,title,url,body \
  --jq 'map({id: ("issue-" + (.number|tostring)), type: "issues.opened", subject: ("#" + (.number|tostring)), summary: .title[0:200], detail: .body[0:4000], link: .url})')
echo "Verifiquei os issues recentes de $REPO"
echo
echo '```agent-autoloop'
# Não use echo: o echo do /bin/sh transforma os \n e \\ dentro do JSON em caracteres reais.
printf '{"events":%s}\n' "$EVENTS"
echo '```'
