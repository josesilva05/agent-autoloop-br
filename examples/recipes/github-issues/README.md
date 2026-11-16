# Acompanhar issues do GitHub

## Que problema resolve
A cada cinco minutos lê os issues novos, altera o código localmente e avisa você para conferir; não faz commit, não envia push e não responde ao issue.

## Como ativar
Copie o `SKILL.md` deste diretório para `~/.codex/skills/handle-issue/`; no Claude Code, use `~/.claude/skills/handle-issue/`.
Mescle os `sources`, `agents` e `rules` do `rules.json` em `~/.agent-autoloop/rules.json` e então verifique:
```bash
agent-autoloop check
```
O computador do worker precisa ter o `gh` já autenticado; o script de polling entrega o corpo do issue junto ao Agent.

## O que alterar
- Troque os dois `worker` pelo computador do worker; em `use`, escolha `codex` ou `claude`.
- Troque `owner/repo` pelo repositório e o `YYYY-MM-DD` de `created:>=YYYY-MM-DDT00:00:00+08:00` pela data de ativação; o GitHub calcula as datas em UTC e, sem o fuso, os issues abertos antes das 8h da manhã daquele dia no fuso Asia/Shanghai (horário de Pequim) seriam perdidos. Troque `cwd` por um diretório de projeto limpo.
- Permissão: `edit`. O Agent só lê dados e altera arquivos locais; o acesso à internet fica com o script de polling fixo, que não é limitado pelo `access`. Por padrão o Claude não libera comandos de teste arbitrários. Veja a [explicação de permissões](../../../docs/plugins.md#o-que-o-access-realmente-permite).
