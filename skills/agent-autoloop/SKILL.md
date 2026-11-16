---
name: agent-autoloop
description: "Configurar a central de automação de Agents: adicionar regras, conectar novos plugins de eventos, conectar novos Agents, conectar novos canais (Feishu, QQ, DingTalk, WeCom…), escrever manuais de tratamento, implantar em servidor, usar vários computadores. Usar quando o usuário disser “deixe o Agent resolver sozinho quando acontecer algo”, “todo dia a tal hora o Agent faz tal coisa”, “conecta o GitHub / os alertas / algum sistema”, “troca o modelo”, “quero aprovar pelo Feishu”, “adiciona um computador”."
---

# Central de automação de Agents

O protocolo completo está em `docs/protocol.md`; aqui é o como fazer. O programa fica em `~/.agent-autoloop/app`, as regras em `~/.agent-autoloop/rules.json`, e a configuração e as chaves em `~/.agent-autoloop/config.json`.

## Acompanhar e responder

`agent-autoloop status` lista quem está online, o que espera do usuário, o que está fazendo, o que já fez, além das rodadas, Tokens e custos de hoje e dos últimos 7 dias, contados por horário de conclusão (os Tokens incluem cache, com a parcela de cache discriminada; o uso já informado de novas tentativas da mesma rodada é somado, e rodadas sem relatório são escritas). No terminal ele vem colorido; ao ser passado por pipe, chamado por um Agent ou com `NO_COLOR` definido, é texto puro. `agent-autoloop status --json` imprime a estrutura bruta de `/v1/state`, para scripts e painéis. `agent-autoloop answer <cartão> <número>` responde, `agent-autoloop resolve <cartão> <resultado>` encerra o caso, e `agent-autoloop stop <nº da rodada>` interrompe uma rodada, só reportando como parada depois que todo o grupo de processos sai.

Continuações de sessão também contam apenas o uso novo desta vez. `~/.agent-autoloop/worker/usage/` guarda os valores acumulados usados na subtração; uma continuação sem registro (por exemplo, se esse diretório foi apagado) não reporta os Tokens do Codex nem o custo do Claude Code desta vez, e volta ao normal na próxima. O uso gasto quando o titular abre o link e continua a conversa na mesma sessão entra na conta da próxima continuação. Recibos antigos não são recalculados.

Aqui não existe página web. Se o usuário quiser uma página para ver o todo, escreva uma para ele: leia `GET /v1/state`, a chave é `owner` do `config.json` e, para acompanhar as mudanças, emende `GET /v1/stream?after=<seq>` a partir do `seq` do estado; as requisições estão na seção “O titular” de `docs/protocol.md`.

## Editar regras

Edite `rules.json` e rode `agent-autoloop check`. Vale em poucos segundos; se algo estiver errado, as regras antigas continuam rodando e um cartão é enviado dizendo onde está o erro. `agent-autoloop rules explain [arquivo]` lista como as regras valem e o próximo agendamento, e `agent-autoloop emit <tipo> --dry-run` ensaia para quem um evento seria despachado; os dois olham apenas os arquivos locais (`rules explain` olha `rules.json` quando nenhum arquivo é informado) e não se conectam à central. Tarefas ainda não reivindicadas atualizam Agent, diretório e permissões juntos no momento da reivindicação; a configuração do Job e o worker de tarefas já reivindicadas são mantidos até o fim daquela execução.

Cada regra responde a cinco perguntas: que evento (`when`), para quem (`to`), onde (`cwd`), seguindo o quê (`skill`, `prompt`), e se deve contar ao usuário (`tell`; por padrão só quando há cartões).

```json
{ "name": "Tratar issue", "when": { "source": "github", "types": ["issues.opened"] }, "to": "claude", "cwd": "~/code/app", "skill": "handle-issue", "parallel": 3 }
{ "name": "Briefing matinal", "when": { "cron": "0 9 * * *" }, "to": "codex", "cwd": "~/notes", "prompt": "Escreva o briefing matinal de hoje." }
```

- Se os eventos do mesmo objeto devem ser tratados em separado, sem esperar um pelo outro, escreva `parallel`. Quantas rodadas um mesmo worker executa ao mesmo tempo ainda é limitado por `worker.capacity` no `config.json`, padrão 2; para rodar mais, aumente os dois juntos.
- Trabalho que exige resposta imediata, como conversas, que não deve ficar na fila atrás de tarefas longas de lote: escreva todas as regras de lote no mesmo `group`, com `parallel` menor que `worker.capacity`; as vagas que sobram não podem ser ocupadas pelas tarefas longas, e a conversa é reivindicada assim que chega. Por exemplo, com `capacity` 4, escreva `"group": "batch", "parallel": 3` para o grupo de lote. Regras do mesmo grupo recebem o mesmo `parallel`.
- Quando o grupo roda três rodadas em paralelo no total, mas uma única regra deve rodar só uma rodada por vez, acrescente `"maxActive": 1` na regra. Cada objeto continua com fila própria. Em `agents` também é possível dar `maxActive` a um Agent individual, limitando quantas rodadas ele executa ao mesmo tempo entre regras.
- Se um novo evento do mesmo objeto deve continuar a sessão da rodada anterior (por exemplo, mensagens seguintes da mesma conversa), escreva `"resume": true`; por padrão cada evento abre uma sessão nova. Abre-se uma nova quando a rodada anterior foi interrompida, pode ainda estar rodando ou o Agent mudou. Sem `parallel`, todos os eventos da regra compartilham a mesma sessão.
- Quando cada rodada de um assunto abre uma sessão e os nomes de sessão no cliente são todos iguais, sem como distinguir, escreva `"title": "tapd-{id}-teste"` na regra: ele ocupa sozinho a primeira linha do prompt, `{subject}` é trocado pelo objeto do evento e `{id}` pelo último segmento do objeto separado por `/ # :`. Deve ser uma palavra só, começando com letra ou número e sem espaços.
- Para parar uma regra, use `agent-autoloop pause <regra> --reason …` (acrescente `--until` para retomar automaticamente num horário); retome com `resume <regra>` e rode uma rodada agora com `run <regra>`; não é preciso mexer em `rules.json` só para parar uma regra. Eventos que chegam durante a pausa não são aceitos nem enfileirados por essa regra; `resume` lista os eventos pulados pela pausa e, se houver algum, conte ao usuário com franqueza; se o usuário mandar repor, rode o `agent-autoloop replay <regra> --since <tempo>` que ele apresenta, que repõe tudo de uma vez, cada evento uma única vez, sem precisar repor um a um com `run`.
- Antes de mudar as regras, você pode escrevê-las como rascunho e validar com `agent-autoloop check <rascunho>`, sem afetar a central em execução.
- A lista padrão de perguntar antes é `askFirst`; é aqui que se edita o que o usuário diz que deve ser sempre perguntado a ele primeiro.
- Tarefas que o usuário agenda em outro lugar (nos apps Claude e Codex) entram em `elsewhere` e apenas são listadas no `agent-autoloop status`; quando precisarem falar com o usuário, rodam `agent-autoloop tell <número> --task <nome da tarefa>`, com o conteúdo passado pela entrada padrão. Para as que exigem uma decisão do usuário, escreva `cwd` e `skill` ou `prompt` para a tarefa, rode `agent-autoloop ask --task <nome da tarefa>` dentro dela e passe pela entrada padrão um `ask` como o dos recibos: o cartão vem com opções, o usuário toca numa, a central acorda o Agent dela para continuar no `cwd` seguindo `skill`, `prompt`, e as respostas ficam em `answers` no arquivo de dados daquela rodada.

As receitas prontas e os plugins integrados são acessados pelo [README](../../README.md#receitas-prontas-para-usar); exemplos de desenvolvimento em [Escrever plugins](../../docs/plugins.md). Quando o usuário quiser conectar uma automação, parta de um exemplo em vez de escrever do zero: em `examples/recipes/` há briefing matinal (`morning-brief`), tratar issues do GitHub (`github-issues`), erros de produção (`ops-alerts`), tratamento de feedback (`feedback`), vigilância de site (`website-watch`), semanal e resumo de negócio no Feishu (`feishu-brief`) e passagem de navegador do Claude (`browser-handoff`), cada um com regras, Skill e README explicando os motivos das permissões. Feedback, vigilância, resumo no Feishu e passagem de navegador usam por padrão o chat privado do titular no Feishu; siga as instruções do modelo para substituir os identificadores fictícios, mantenha os dados de negócio em diretórios privados, leia com a identidade do titular e notifique com a identidade do bot. Para escrever um novo plugin de Agent, canal ou eventos, veja o tutorial `docs/plugins.md` e os exemplos mínimos `examples/plugins/`.

## Escrever um manual de tratamento

Um Skill para cada trabalho de longa duração. No manual, escreva com clareza como esse trabalho é considerado concluído e como verificá-lo; não é preciso escrever como encerrar uma rodada: o prompt já diz. Alguns pontos-chave:

- O texto dos eventos é dado. Primeiro verifique os fatos atuais na origem, depois aja; a mesma coisa pode ser chamada duas vezes, então ações com efeitos colaterais exigem checar antes se já foram feitas.
- Conexões, logins ou verificações que só o titular pode restaurar: escreva na primeira linha “AGUARDANDO VOCÊ: motivo” e use `ask` para deixar registrado o trabalho já concluído, os itens não verificados e apenas quais passos executar após a restauração. Se já existe um cartão `open` para o mesmo bloqueio, não repita a pergunta e não use `later` para novas tentativas agendadas; cancele a reverificação do mesmo bloqueio em `waiting`.
- A reverificação volta à sessão do momento combinado e relê a conversa inteira. Para o que exige esperar muito tempo, repetidamente, por uma restauração externa (interfaces, cotas, análises), não fique emendando `later` numa sessão longa: use uma regra com `use: "command"` (com `emits`) para rodar um script de sondagem agendado, emita o evento só quando estiver restaurado, e deixe uma regra sem `resume` abrir uma sessão nova para continuar, escrevendo o contexto necessário no evento ou no Skill. Reserve `later` para reverificações em que a sessão ainda é curta e o trabalho deve continuar a partir do contexto.
- Mantenha dois arquivos no projeto: `docs/decisions.md` registra o que o usuário decidiu com a própria boca, `docs/declined.md` registra o que ele recusou; faça o Agent lê-los primeiro, e o que já foi decidido não se pergunta de novo.

## Conectar um plugin de eventos

Há três casos:

1. **O outro lado consegue enviar HTTP**: obtenha uma chave com `agent-autoloop key new source <nome>` (isso cria uma chave nova — pergunte ao usuário antes), registre em `sources` no `rules.json`, e o outro lado faz `POST /v1/events`. Se o outro lado precisar saber se o trabalho foi concluído depois e qual foi a conclusão, ele usa a mesma chave em `GET /v1/events/<event da resposta>`; não é preciso dar a ele a chave do titular.
2. **O outro lado tem um formato próprio de Webhook**: escreva uma função em `~/.agent-autoloop/plugins/<nome>/source.ts` que valida a assinatura e traduz o payload em eventos (veja `plugins/github/source.ts`); a fonte leva `"adapter": "<nome>"`, o endereço é `/v1/in/<fonte>` e o segredo vai em `~/.agent-autoloop/secrets.env` como `AGENT_AUTOLOOP_SECRET_<fonte>` (nome da fonte em maiúsculas, `-` trocado por `_`); depois de mudar, reinicie a central (`agent-autoloop service install`). O outro lado precisa alcançar a central, então ela deve estar num servidor, ou use um túnel.
3. **O outro lado não consegue enviar, ou a central fica em casa**: rode um script de sondagem por agendamento, veja `examples/watch-github-issues.sh`. A regra usa um Agent com `use: "command"` e escreve `emits`. Sem nada novo, nenhum Token é gasto.

## Conectar um Agent

Qualquer comando que consiga imprimir sua última mensagem: escreva uma linha em `agents` no `rules.json`:

```json
"hermes": { "name": "Hermes", "worker": "my-mac", "use": "command", "command": ["hermes", "chat", "-Q", "-q", "{prompt}"] }
```

Código de saída diferente de 0 conta como falha (`FALHOU:`). Para continuação de sessão, link para abrir a sessão e estatísticas de uso, escreva um plugin em `~/.agent-autoloop/plugins/<nome>/agent.ts` (seguindo `plugins/codex/agent.ts`): `command` fornece a linha de comando, `read` lê da saída a última mensagem e a sessão, inclua `started: true` assim que o Agent receber o prompt (senão, se quebrar no meio do trabalho, abre uma sessão nova e refaz), e `link` fornece o link.

`access` é `edit` por padrão, que plugins dedicados traduzem nas permissões do CLI correspondente; `command` apenas passa argumentos e não restringe permissões de programas arbitrários — configure isso conforme a documentação do próprio CLI. Para permissão total, sem aprovações, escreva `full` e deixe isso claro para o usuário antes.

Para usar Claude Code, Codex ou DeepSeek Harness integrados através de um gateway ou proxy de terceiros, ou com variáveis de ambiente definidas antes de iniciar: escreva um script pequeno que define as variáveis e então `exec claude "$@"` (para Codex e DSH, troque por `codex`, `dsh`), e escreva `"program": "/caminho/absoluto/do/script"` no Agent. O plugin continua analisando a saída, continuando sessões e contabilizando o uso — apenas inicia esse script; não é preciso mudar para `use: "command"`. Os tokens ficam num arquivo lido pelo script, não escritos em `rules.json`. Antes de iniciar o Agent, o worker remove as variáveis `CLAUDE_CODE_*` herdadas; escreva no script as que precisar. `agent-autoloop doctor` também usa esse script para conferir o login. O script consegue ler `AGENT_AUTOLOOP_RUN` (nº da rodada) e `AGENT_AUTOLOOP_CONTEXT` (arquivo de dados) — por exemplo, para preparar um diretório de trabalho por rodada e então entrar nele com `cd`.

```json
"deepseek": { "name": "Claude Code (DeepSeek)", "worker": "my-mac", "use": "claude", "program": "/Users/me/.agent-autoloop/bin/claude-deepseek.sh" }
```

Um repositório de terceiros com `agent.ts`, `channel.ts` ou `source.ts` na raiz é instalado com `agent-autoloop add <endereço git>` em `~/.agent-autoloop/plugins/<nome do repositório>`. O nome do repositório em minúsculas é o nome do plugin, e é ele que vai no `use` da regra; só pode usar letras minúsculas, números e `-`, e `add` recusa nomes fora disso. Um plugin local de mesmo nome tem precedência sobre os plugins integrados e não é atualizado automaticamente. Plugins são código confiável — leia antes de instalar.

No Windows, `cwd` pode ser `C:/code/project`, `C:\\code\\project` com escape de JSON, um caminho UNC ou `~/code/project`, valendo o computador do worker. `command` aceita executáveis, scripts PowerShell e wrappers `.cmd` gerados pelo npm (execute diretamente a entrada JS ou o `.exe` deles); para outros `.bat`/`.cmd`, troque por um executável ou `node script.js`. O Windows encontra programas pelo PATH e não carrega um shell de login Unix.

O máximo que uma rodada pode rodar é escrito em `timeout`, em minutos, padrão 180.

ACP usa `use: "acp"` e `command: ["<programa de serviço ACP>"]` — por exemplo, Gemini CLI é `["gemini", "--acp"]` e OpenCode é `["opencode", "acp"]` — com suporte à criação e retomada de sessão, texto e pedidos de permissão pontuais da v1; faça login antes no CLI do próprio Agent. `access` só cobre as operações que o Agent pergunta por conta própria; a especificação permite que ele execute sem perguntar, então, para restringir, use o modo dele próprio (por exemplo, escreva `env INITIAL_AGENT_MODE=read-only …` em `command`); `model`, `effort` e `tier` não têm efeito e devem ser configurados no lado do próprio Agent. A conexão por comando genérico e a faixa de suporte testada estão no README.

DeepSeek Harness usa `use: "dsh"` e exige 0.2.2 ou mais novo (`npm install -g @deepseek-ai/dsh@next --allow-scripts=koffi,node-pty,@deepseek-ai/dsh-subprocess-local` — sem liberar os scripts de instalação desses três pacotes, ele falha assim que roda depois de instalado). Consegue continuar a sessão original e reportar Tokens (não reporta custo); ao reportar `MISSING_CREDENTIAL`, coloque a chave numa variável de ambiente; `access` corresponde às suas faixas de permissão; versões antigas usam a conexão por comando genérico do README. Não há link de desktop para abrir.

ZCode usa `use: "zcode"` e roda o CLI instalado junto com a versão de desktop; no Windows, `"program"` aponta para o `zcode.cjs` dele e o plugin o inicia com node. Consegue continuar a sessão original e reportar Tokens (não reporta custo); `access` corresponde aos seus modos (`read` é `plan`, `edit` é `edit`, `full` é `yolo`); `model` e `effort` usam as configurações do próprio ZCode. Rode antes `zcode -p "hi"` uma vez; se retornar vazio, troque no ZCode para um provedor de modelos que funcione. Não há link de desktop para abrir.

Quando a tarefa principal do Claude precisa delegar ao Codex a operação de páginas web, configure a partir de `examples/recipes/browser-handoff/` a entrada já verificada, os alvos e as operações permitidas, guardando o número da subsessão do Codex retornado; se houver bloqueio, a tarefa principal entrega um `ask` e, após a restauração, só os passos de web são retomados. O modelo de chamada da entrada não fornece conexão com o navegador nem modifica o app de desktop ou autorizações.

Tarefas web usam as ferramentas de navegador já configuradas do Agent. Quando for necessária uma entrada dedicada, escreva no `prompt` ou `skill` da regra o comando existente e o modo de continuação de sessão, entregue apenas os passos de web, e o negócio e o recibo continuam por conta da tarefa principal. Não se pode presumir que o CLI em segundo plano esteja conectado ao navegador de desktop; verifique páginas e continuações pelo mesmo modo em segundo plano — veja “Acesso ao navegador” em `docs/plugins.md`.

## Conectar um canal

A configuração fica em dois lugares: registre em `channels` no `rules.json` (`answerers` é quem pode responder; sem isso, qualquer pessoa do canal pode responder, e o `doctor` avisa), e escreva chaves e opções em `channels` no `config.json`. Obtenha a chave com `agent-autoloop key new channel <nome>` (pergunte ao usuário antes). Depois de mudar o `config.json`, reinicie com `agent-autoloop service install`. Por padrão cada cartão é enviado a todos os canais; se os cartões de uma regra só devem ir para alguns canais, escreva `"channels": ["feishu"]` nessa regra; com muitos canais, cartões que não pertencem a nenhuma regra — `tell`, os próprios alertas da central — seriam enviados uma vez por canal, então escreva `"defaultChannels": ["feishu"]` no nível superior do `rules.json`, e tudo que não tiver `channels` próprio só é enviado para aqueles.

**Notificações de desktop**: uma central recém-instalada vem com elas ligadas por padrão (`plugins/desktop/channel.ts`), com um `desktop` em cada um dos dois lugares. No primeiro envio de um cartão, uma notificação aparece: macOS usa `osascript`, Linux usa `notify-send`, Windows usa a notificação da bandeja do sistema via PowerShell, com o título “O Agent tem uma pergunta para você”, o corpo sendo o título do cartão, “Fonte: <nome da regra>” (quando o cartão traz uma regra e o título não é o nome dela) e “Execute agent-autoloop status para ver”; não dá para responder pela notificação. Sem uma sessão gráfica, ela é pulada em silêncio e a pergunta continua lá; se o comando de notificação falhar, a falha é reportada sem derrubar a central. Com outros canais conectados, você pode mantê-la; se não a quiser, apague o `desktop` dos dois lugares e reinicie. Centrais instaladas antes não a recebem automaticamente.

**Feishu**: usa o `lark-cli` oficial. `npm i -g @larksuite/cli`, crie um app com `lark-cli config init --new` (o usuário lê o QR code), ative no console de desenvolvedor a capacidade de bot para o app e assine as interações de callback de cartão (conexão longa). Depois:

```json
// rules.json
"channels": { "feishu": { "name": "Feishu", "answerers": ["ou_<open_id do usuário>"] } }
// config.json
"channels": { "feishu": { "key": "…", "user": "ou_<open_id do usuário>" } }
```

Cliques em cartões do mesmo app do Feishu só podem ter um ouvinte; rode em um único computador.

**Canais que só enviam texto (bots de grupo do DingTalk e WeCom, Webhooks do Slack e Discord)**: use `plugins/webhook/channel.ts`; no item do canal em `config.json` escreva `"use": "webhook"`, `"platform": "dingtalk"` e `"url": "<endereço do Webhook existente>"`; `platform` também pode ser `wecom`, `slack` ou `discord`. Qualquer outra plataforma que receba POST JSON também conecta: não escreva `platform`, escreva `url` e um `body` com `{text}` — por exemplo, para Telegram escreva `"url": "https://api.telegram.org/bot<token do bot>/sendMessage"`, `"body": { "chat_id": "…", "text": "{text}" }`. Escrevendo `"links": true` no `rules.json`, o próprio link do cartão já permite responder; `hub.publicUrl` no `config.json` deve ser um endereço que o celular ou o computador consiga abrir.

**Novo canal com botões**: escreva um em `~/.agent-autoloop/plugins/<nome>/channel.ts`, seguindo `plugins/feishu/channel.ts`: em ciclo, reivindique cartões, envie ou atualize, reporte; ao receber um clique, encaminhe para `hub.answer`. O protocolo está em `docs/protocol.md`; pode ser escrito em outra linguagem, desde que saiba enviar HTTP.

## Pipeline de entrega

É preciso que este computador do worker já tenha login no `gh` e um programa de revisão. O processo `delivery` só executa plugins locais e o comando de revisão indicado na main; o PR não é feito checkout e nenhum código roda nesta máquina. Primeiro coloque na main o `ops/delivery.json` do projeto e os pontos de revisão:

```json
{
  "repo": "owner/app",
  "internal": ["docs/**/*.md"],
  "check": { "workflow": "check.yml", "job": "check" },
  "ship": { "workflow": "ship.yml" },
  "review": { "points": "AGENTS.md", "status": "agent-review", "xhigh": ["src/auth/*"] },
  "health": {
    "url": "https://app.example/health",
    "field": "commit",
    "pattern": "(?P<sha>[0-9a-f]{40})",
    "require": { "ok": true }
  }
}
```

Quando vários projetos compartilham as regras, acrescente `--review-policy owner/config:ops/review-policy.json` depois do comando do worker. O plugin lê o arquivo da main desse repositório. `reviewers` dá o modelo por nome (forma abreviada em string) ou `{ "model": "…", "effort": "xhigh" }`; `default` é a lista de nomes dos revisores padrão; `agents` escreve uma lista para cada tipo de Agent de desenvolvimento, lista vazia dispensa revisão, e o mesmo nome escrito duas vezes revisa duas vezes de forma independente. `trusted_submitters` lista as contas numéricas do GitHub que podem registrar a origem. Caminhos de revisão profunda e o somente-revisão explícito podem ambos se sobrepor à dispensa. Quando uma regra de branch existente especifica o estado da revisão, passe o nome dele com `--review-status`.

O `AGENTS.md` deve ter `## Pontos de revisão`. `review.command` pode substituir o programa de revisão por um array de comando: o prompt é lido da entrada padrão, `{input}` é trocado pelo arquivo de diff em texto, e a saída padrão deve ser `{"findings":[{"title":"arquivo:número da linha e problema","text":"condição de disparo e consequência"}]}`; sem problemas, entregue uma lista vazia. Por padrão o Codex ignora a configuração do usuário, desativa a memória e lê apenas um snapshot separado de revisão. `admin_merge` é vazio por padrão; só autores de PR explicitamente listados na main podem usar o merge de administrador. Projetos sem serviço em produção podem omitir `health`, e o recibo escreverá explicitamente que apenas o merge foi concluído.

Para definir a revisão pelo Agent que escreve o código, acrescente `agents` e `trusted` em `review`:

```json
"review": {
  "points": "AGENTS.md",
  "trusted": [12345678],
  "agents": {
    "codex": null,
    "claude": { "model": "gpt-6.1-sol", "effort": "xhigh" },
    "gemini": { "command": ["/caminho-absoluto/reviewer", "{input}"] }
  }
}
```

`agents` escreve um revisor para cada Agent: `null` dispensa revisão; `model` e `effort` são o modelo e a profundidade de raciocínio usados pela revisão integrada do Codex, e o item não escrito usa o padrão (`gpt-6.1-sol`, `high`); `command` troca por um comando, com a mesma convenção de `review.command`. Agents não listados e mudanças sem origem declarada passam pela revisão padrão, ou seja, `review.command` — ou o Codex integrado, se não estiver escrito. Mudanças dispensadas de revisão que tocam um caminho `xhigh` ou levam o rótulo `deliver-review` passam pela revisão padrão do mesmo jeito; o Codex integrado revisa caminhos `xhigh` com profundidade não inferior a `xhigh`.

A origem é declarada com o status do commit. Só quando a mudança inteira foi escrita pelo mesmo Agent, escreva este status no commit a entregar, com o nome do Agent na descrição (começando com letra minúscula, usando apenas letras minúsculas, números e `-`):

```bash
gh api repos/owner/app/statuses/<sha completo do commit> -f context=delivery-agent/<número do PR> -f state=success -f description=claude
```

Só são aceitos status escritos pelas contas do GitHub em `trusted`, informando o ID numérico da conta (`gh api user --jq .id`). A declaração acompanha o commit: ao enviar novos commits com push é preciso declarar de novo, e sem declaração vale a revisão padrão; um merge limpo produzido pela sincronização da main reaproveita a declaração original. Para retirar, escreva no mesmo commit outro status de mesmo nome com `state=failure`. Descrição do PR, rótulos e nome de branch não contam como declaração.

`check.job` leva o nome do job; jobs de matriz (nomes como `check (ubuntu-latest)`) contam como o mesmo job, e cada item precisa ter sucesso. Os tipos de disparo do workflow de verificação devem incluir `ready_for_review`: depois que o draft vira ready, só é aceita uma verificação rodada depois disso, e `pull_request` por padrão não dispara ao virar ready. Escreva `on: { pull_request: { types: [opened, synchronize, reopened, ready_for_review] } }`.

Quando a verificação `pull_request` mais recente do commit atual fica na fila por mais de 10 minutos sem criar nenhuma tarefa, o plugin passa o PR para draft e de volta para pronto, reativando uma vez, e só reconhece as novas verificações posteriores à volta para pronto. O registro de auto-salvamento do mesmo commit é preservado junto com as reverificações da central. Quando a nova verificação passa de 10 minutos ainda sem tarefas, a entrega é devolvida imediatamente, explicando que o GitHub aceitou a verificação mas nunca a iniciou, e a entrega é refeita quando o GitHub se recuperar. Com tarefas já criadas e na fila esperando máquina, continua-se esperando. Nos demais casos ainda se espera no máximo 30 minutos, e erros temporários do GitHub ou de execução são repetidos pelas regras originais. Verificações `workflow_dispatch` acionadas manualmente não servem de base para o merge.

Exemplo de regras (troque os caminhos absolutos, o computador do worker e o repositório pelos seus):

```json
{
  "sources": { "github": { "name": "GitHub" } },
  "agents": {
    "poll": {
      "name": "Verificar rótulos de entrega",
      "worker": "mac-mini",
      "use": "command",
      "command": ["node", "/caminho-absoluto/agent-autoloop/plugins/delivery/poll.ts", "owner/app"]
    },
    "delivery": { "name": "Entrega", "worker": "mac-mini", "use": "delivery", "command": ["owner/app"], "timeout": 35 }
  },
  "channels": {},
  "rules": [
    {
      "name": "Verificar pendências de entrega",
      "when": { "cron": "*/2 * * * *" },
      "to": "poll",
      "cwd": "/diretório-de-trabalho-existente",
      "prompt": "Verifique os rótulos de entrega do projeto",
      "emits": { "source": "github", "types": ["pull_request.labeled", "issues.labeled"] }
    },
    {
      "name": "Entrega",
      "when": { "source": "github", "types": ["pull_request.*", "issues.labeled"] },
      "to": "delivery",
      "cwd": "/diretório-de-trabalho-existente",
      "parallel": 2,
      "prompt": "Conclua a entrega conforme as configurações do projeto na main"
    }
  ]
}
```

A sondagem não exige configurar Webhooks nem chaves novos; o número do evento é composto pelo registro do rótulo e pelo commit do PR, e leituras repetidas não re-despacham; também dá para conectar diretamente uma fonte GitHub existente. Os assuntos são separados por `owner/repo#número`, e `parallel` controla a concorrência. Colocar `deliver` inicia o fluxo; colocar junto `deliver-review` faz só a revisão, e acrescentá-lo enquanto se espera pelas verificações também impede o merge; `deliver-attended` indica que há alguém acompanhando — problemas encontrados vão só para o recibo, sem notificação extra. Depois que a revisão encontra problemas, o mesmo commit não é revisado uma segunda vez; só após corrigir e enviar novos commits com push ele é revisado de novo. Uma issue comum com `ask-owner` vira um cartão de pergunta, e o rótulo é removido após a resposta; ele não posta comentários no GitHub por você.

Quando o release falha após o merge, corrija o release e então retome o acompanhamento do Ship e da verificação de saúde do PR original.

Ao ligar este fluxo a um comando de entrega GitHub já existente, você pode acrescentar estes parâmetros ao `command` do `delivery` na regra confiável.

- `--auto-merge` ativa o squash auto-merge do GitHub para o commit atual depois que as verificações completas e a revisão passam. A lista de merge de administrador nas configurações do projeto continua valendo pelas permissões de administrador existentes.
- `--toolkit owner/name` confere antes do merge se o `ops/delivery/` instalado no projeto é igual ao da main desse repositório de ferramentas. O próprio repositório de ferramentas usa o código-fonte.
- `--progress-command /caminho-absoluto/programa` recebe pela entrada padrão um snapshot de fase, incluindo `repo`, `number`, `head`, `phase`, `at`, e, quando conhecidos, `merge`, `ship`, `detail`. Falha na exibição não afeta o recibo do GitHub.
- `--notify-command /caminho-absoluto/programa` recebe pela entrada padrão `{ "key": "…", "text": "…" }`. O programa desduplica por `key` e retorna zero após o recebimento bem-sucedido. Esse modo entrega a esse programa as devoluções que ninguém espera e os repasses de `ask-owner`, e usa a reverificação da central para repetir a cada minuto erros temporários do GitHub ou de execução.

O comando de sondagem correspondente usa `poll.ts --dispatch owner/app owner/another`. As regras roteiam para repositórios fixos por `delivery.owner.app.pr`, `delivery.owner.app.issue` e `delivery.owner.app.unacknowledged`, sendo que a última dispara quando uma devolução com marcação de espera fica três minutos sem ser reivindicada. No mesmo grupo, `parallel` controla a concorrência geral e cada regra de projeto usa `maxActive: 1`.

Com a central fora do ar, na máquina do worker original, confirme primeiro que as entregas do mesmo projeto pararam de forma estável e então use `node plugins/delivery/run.ts owner/app --pr 123` do diretório de instalação confiável, com os parâmetros de revisão e merge da regra original, para tratar os PRs já marcados com `deliver`. Ele lê diretamente o estado atual do GitHub e usa as mesmas verificações. Com a central inacessível, omita os comandos de notificação e de painel. Durante a entrega manual, mantenha o despacho automático pausado e só retome a aceitação de trabalho ao terminar.

O Ship do projeto roda apenas em push na main, com checkout do histórico completo (`fetch-depth: 0` no checkout), e então chama a Action deste repositório. Troque o commit provisório abaixo pelo SHA completo verificado após o release:

```yaml
- uses: josesilva05/agent-autoloop-br/plugins/delivery@<sha completo do commit>
  id: scope
- if: steps.scope.outputs.release == 'true' && steps.scope.outputs.superseded != 'true'
  run: ./comando-de-release-existente-do-projeto
```

A versão retornada pela interface de saúde deve permitir extrair o commit Git, e os campos de negócio devem satisfazer `require`. Execuções normais permitem apenas HTTPS; `--test-local-health` e `test-local-health: 'true'` da Action servem somente para testes locais explícitos e permitem adicionalmente `http://127.0.0.1`. Isso não dá a runners hospedados pelo GitHub acesso ao seu computador.

## MCP e revogação de chaves

No cliente MCP, preencha como programa de inicialização `node`, com os argumentos sendo o caminho absoluto do engine local `bin/agent-autoloop.ts` e `mcp`, e passe `AGENT_AUTOLOOP_HOME` no ambiente. Há suporte à versão stdio 2025-11-25, usando a chave já existente no `config.json` local, sem escrever chaves nos argumentos do cliente. As ferramentas aparecem sob a identidade existente; permissões não são criadas automaticamente.

O serviço MCP não distingue quem chama: tudo é registrado como o titular (`answer` é registrado como titular, `emit` não leva contagem de saltos). Não o configure no perfil de usuário dos CLIs que o worker inicia, senão uma rodada consegue responder aos próprios cartões.

`agent-autoloop key remove <source|worker|channel|owner> <nome>` revoga imediatamente a chave correspondente, e long polling e assinaturas de log também caem na hora; trabalho já reivindicado ainda pode entregar o resultado com o token independente daquela rodada.

## Servidor e computadores adicionais

Quando você precisa aprovar cartões pelo celular ou Webhooks de outras pessoas precisam entrar, coloque a central numa máquina com endereço público:

1. No servidor: `sh install.sh --no-service --command true` (esta máquina não roda Agents; `--command true` é só um marcador de posição, e o passo 2 troca os Agents no `rules.json` pelos reais). No `config.json`, use `127.0.0.1:3350` em `hub.listen` (deve ser escrito como `host:porta`; para IPv6 use `[endereço]:porta`; escrever só a porta ou `:porta` é recusado, para evitar escutar acidentalmente em todas as interfaces), escreva o endereço público em `hub.publicUrl`, remova `worker` e rode `agent-autoloop service install`. Coloque na frente um proxy reverso fazendo HTTPS (Caddy, nginx).
2. Em cada computador que trabalha: no servidor, `agent-autoloop key new worker <nome>`; no computador, `curl -fsSL https://raw.githubusercontent.com/josesilva05/agent-autoloop-br/main/install.sh | sh -s -- join https://<endereço da central> --worker <nome> --key <chave>`. Escreva o `worker` correspondente nos Agents do `rules.json`.

Os computadores não precisam abrir nenhuma porta; eles mesmos se conectam até lá.

Uma unit systemd de nível de sistema escrita por você no servidor deve ter o mesmo nome usado por `agent-autoloop service install` (padrão `agent-autoloop`) para que o `doctor` a reconheça. `agent-autoloop update` não toca nela; após atualizar, rode você mesmo `systemctl restart` para usar a versão nova.

## Log e recuperação

No Windows, a inicialização ocorre pelo Agendador de Tarefas após o login do titular; ao administrar por SSH, use essa mesma tarefa de logon para rodar o Codex, evitando as restrições de inicialização de sandbox dele em sessões OpenSSH (veja `INSTALL.md`); `service install`, `service remove` e `update` valem igualmente, e a atualização reinicia a central. A conta integrada Administrator do Windows usa a pasta “Inicializar” no lugar da tarefa de logon; o `service install` imprime o procedimento. Para a instalação, veja `INSTALL.md`.

Logs: no Windows em `%USERPROFILE%\.agent-autoloop\logs\up.log`, no macOS em `~/.agent-autoloop/logs/up.log`, no Linux rode `journalctl --user -u agent-autoloop`.

Antes de conectar um plugin, valide-o numa central de testes dedicada: `agent-autoloop conformance <endereço> --config <arquivo de credenciais de teste>`. No arquivo, `keys` leva respectivamente as chaves de fonte, worker, canal e titular; `eventType` corresponde à regra de teste e `answerer` está na lista de permissões do canal de teste. A verificação escreve eventos e cartões, então não a aponte para a central em uso. Os tipos do protocolo estão em `protocol/schema.json`.

`agent-autoloop runs [regra] [--before <nº da rodada>]` lista as rodadas concluídas mais antigas e seus números; `agent-autoloop why 42` consulta os eventos, as regras e o recibo de uma rodada; `GET /v1/stream?after=42` permite ao cliente do titular continuar a leitura pelo número de sequência. Backup com `agent-autoloop backup [diretório]`, possível mesmo com a central rodando; restauração com `agent-autoloop restore <diretório>`, exigindo parar a central antes. Um backup manual deve preservar junto `hub.db` e `master.key` com permissão 0600; esta última deriva os tokens dos links de rodadas e cartões.

## Versão e desinstalação

`agent-autoloop --version` mostra a versão e o commit. `agent-autoloop uninstall`, após confirmação, apaga o próprio programa, links e serviço; regras, chaves e registros são preservados; `--yes` apenas pula a confirmação.
