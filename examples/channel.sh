#!/bin/sh
# A saída padrão é o destino da entrega. Uma integração de chat substitui esta impressão pelo próprio envio HTTP.
set -eu
: "${AGENT_AUTOLOOP_URL:?}" "${AGENT_AUTOLOOP_KEY:?}"
while :; do
  packet=$(curl -fsS --max-time 65 -H "Authorization: Bearer $AGENT_AUTOLOOP_KEY" "$AGENT_AUTOLOOP_URL/v1/cards/next?wait=50")
  card=$(printf '%s' "$packet" | jq -c '.card')
  if [ "$card" != null ]; then
    printf '%s\n' "$card"
    id=$(printf '%s' "$card" | jq -r '.id')
    ack=$(printf '%s' "$card" | jq -c '{version,ref:(.ref // ("curl-"+(.id|tostring)))}')
    curl -fsS -H "Authorization: Bearer $AGENT_AUTOLOOP_KEY" -H 'Content-Type: application/json' -d "$ack" "$AGENT_AUTOLOOP_URL/v1/cards/$id/delivered" >/dev/null
  fi
  [ "${AGENT_AUTOLOOP_ONCE:-0}" != 1 ] || break
done
