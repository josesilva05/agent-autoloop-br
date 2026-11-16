# Briefing matinal diário

## Que problema resolve
Toda manhã organiza as notas e os commits do diretório atual e os escreve em `briefs/YYYY-MM-DD.md`, sem precisar de internet.

## Como ativar
Copie o `SKILL.md` deste diretório para `~/.codex/skills/morning-brief/`; no Claude Code, use `~/.claude/skills/morning-brief/`.
Mescle os `agents` e as `rules` do `rules.json` em `~/.agent-autoloop/rules.json` e então verifique:
```bash
agent-autoloop check
```
As regras passam a valer em segundos; definir o cron temporariamente como `* * * * *` permite uma execução de teste em menos de um minuto.

## O que alterar
- Troque `worker` pelo computador do worker que aparece em `agent-autoloop status`; em `use`, escolha `codex` ou `claude`.
- Troque `cwd` por um diretório de notas já existente; `cron` é a hora local, por padrão às oito da manhã todos os dias.
- Permissão: `edit`. Os dois plugins conseguem ler os dados locais e escrever o briefing; não é preciso internet nem comandos shell arbitrários. Veja a [explicação de permissões](../../../docs/plugins.md#o-que-o-access-realmente-permite).
