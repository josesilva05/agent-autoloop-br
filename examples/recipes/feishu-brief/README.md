# Relatório semanal e resumo de negócio do Feishu

Lê os relatórios com a permissão do titular, compara com as tabelas de projetos e organiza o progresso e os pontos que precisam de coordenação. Por padrão, às 18h de domingo no fuso Asia/Shanghai (horário de Pequim), lê os relatórios indicados dos últimos sete dias e o estado atual das tabelas indicadas; o Agent só é chamado depois de uma leitura completa, o texto integral fica salvo nesta máquina e o Feishu recebe apenas um resumo curto para o titular, sem detalhes sensíveis.

## Como ativar

1. Copie este diretório para `~/.agent-autoloop/work/feishu-brief/`, com permissão `0700`, fora de qualquer repositório Git. As duas regras usam o mesmo computador, o mesmo `cwd` e o mesmo `group`, de modo que leitura e organização acontecem em série.
2. Coloque o `SKILL.md` em `~/.codex/skills/feishu-brief/`; no Claude Code, em `~/.claude/skills/feishu-brief/`.
3. Instale um `lark-cli` já autenticado com a identidade do titular e leia antes `lark-cli api --help` e `lark-cli base +record-list --help` para confirmar que os comandos usados neste modelo são suportados. Use apenas as autorizações já existentes; não salve nem exporte access token no script.
4. Altere o `sources.json`: `reportRule` é o nome exato de uma regra de relatório já existente, `reportUsers` são os open_id das pessoas que devem ser reunidas e que o titular tem permissão de ver; em `tables`, preencha o token da sua tabela Base, o table ID, o link original e os nomes dos campos necessários. Se não precisar de tabelas, use um array vazio. Os identificadores reservados não funcionam como estão, e o modelo não cria tabelas nem amplia permissões.
5. Mescle os `sources`, `agents`, `channels` e `rules` das regras, trocando o computador do worker e os caminhos; use o fuso `Asia/Shanghai`. Permissão: `edit` — o Agent de resumo só precisa ler dados e escrever o texto local; a leitura pela internet é feita pelo script fixo, que só executa comandos de leitura.
6. Execute `agent-autoloop check`. Numa central de teste dedicada e com um CLI falso, verifique a coleta, o despacho do resumo e a pergunta e a continuação depois de uma falha de login antes de ativar as suas regras agendadas.

## O que é lido e o que é salvo

A interface de relatórios é `POST /open-apis/report/v1/tasks/query`, uma operação de consulta cuja permissão necessária é `report:task:readonly`. Toda leitura usa `--as user`, trazendo apenas os relatórios que o titular enviou ou recebeu, filtrados depois por pessoa, regra e período; nada muda para a identidade do bot para obter mais dados. A especificação da interface está em [Feishu — consultar tarefas de relatório](https://open.feishu.cn/document/server-docs/report-v1/task/query.md). Não ver o relatório de alguém não significa que essa pessoa não o enviou. Imagens em anexo não são baixadas.

As tabelas usam `base +record-list`, leem apenas os campos indicados e conferem a paginação por um arquivo NDJSON e um manifest. Só está completo ao chegar em `has_more=false`; mudança de versão entre páginas é um erro, e dados parciais não podem ser apresentados como um resumo completo. Nada é escrito de volta em tabelas, OKR ou relatórios. Os registros da tabela são o retrato do momento da leitura e não representam por si só o que foi acrescentado ou mudou nestes sete dias.

As exportações temporárias de tabela são limpas ao fim da leitura. Os dados completos do período ficam em `weekly-input.json` (permissão `0600`) e o resumo em `briefs/<número dos dados>`; são dados de negócio do titular — não faça commit, não publique e não anexe o texto integral em cartões do Feishu. Depois que dados novos substituem o arquivo de entrada, eventos antigos na fila não usam os dados novos por engano; o histórico completo de resumos é gerenciado pelo titular conforme o próprio prazo de retenção.

Quando o login ou a autorização do titular falha, é enviado um único cartão de pergunta, sem evento `brief.ready`, e o arquivo anterior não é apresentado como o resultado desta semana. Depois que o titular restabelece o acesso, ele clica em continuar e a leitura completa é refeita; se escolher "Pular este período", esta rodada se encerra e a leitura volta no próximo horário agendado; erros temporários de interface falham com sinceridade e ficam com os mecanismos existentes da central.

## Notificação pelo Feishu

As regras registram por padrão o canal `feishu`. Troque `ou_REPLACE_ME` pelo open_id do titular; no `channels.feishu` do `config.json` existente, configure o `user` dessa pessoa e a chave de canal já em uso. Reaproveite o canal Feishu que já está rodando, sem abrir outra escuta. Se ele ainda não estiver conectado, siga a [configuração de canais](../../../skills/agent-autoloop/SKILL.md#conectar-um-canal); quando a configuração envolver chaves ou permissões novas, obtenha antes a autorização do titular.

A leitura dos dados de negócio usa a identidade do titular; a notificação usa a identidade do bot. Por padrão envia-se apenas ao titular; uma central entrega os cartões a todos os canais que ela tem configurados, então regras com dados privados devem declarar `channels` para enviar somente ao canal de conversa privada do titular, sem se misturar com canais de grupo compartilhados. Não faça commit no repositório de chaves, open_id reais, tokens de tabela nem dados de negócio.
