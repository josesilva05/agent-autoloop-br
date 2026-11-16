# Escrever plugins

Primeiro veja o [catálogo de plugins integrados no README](../README.md#sistema-de-plugins-os-quatro-lados-são-substituíveis) para escolher uma implementação existente; quando precisar estender, comece pelos três modelos mínimos e executáveis abaixo e substitua a parte de negócio:

| Modelo | O que já demonstra | O que você deve substituir |
| ------ | ------------------ | -------------------------- |
| [Modelo de Agent](../examples/plugins/hello-agent/agent.ts) | Usa `printf` para simular a execução e lê a saída, o número da sessão e o "recebeu o prompt" | O comando de inicialização do novo Agent e a análise da saída |
| [Modelo de canal](../examples/plugins/hello-channel/channel.ts) | Busca cartões, escreve em arquivo e reporta a entrega; responde pela linha de comando | O envio, a atualização e o callback de resposta da plataforma de destino |
| [Modelo de plugin de eventos](../examples/plugins/hello-source/source.ts) | Valida a assinatura HMAC-SHA256 e converte pedidos simulados em eventos | O modo de validação de assinatura do sistema de negócio e o mapeamento de campos |

O plugin de eventos, o worker, o canal e a linha de comando compartilham a mesma interface HTTP + JSON. Para conectar o protocolo usando apenas Shell, veja o [script de worker](../examples/worker.sh) e o [script de canal](../examples/channel.sh): defina o endereço da central e a chave antes de executar; eles precisam de `curl` e `jq`. Servem para demonstrar tarefas curtas; para tarefas longas, use os recursos de heartbeat, parada e retomada do worker integrado.

Um plugin é um diretório, com ponto de entrada `agent.ts`, `channel.ts` ou `source.ts`. Use apenas módulos `node:` e arquivos do próprio diretório, e declare os tipos dentro do plugin; não referencie o código-fonte do motor por caminho relativo: um plugin instalado em `~/.agent-autoloop/plugins/` não alcança o motor por caminho relativo. Os plugins integrados são publicados junto com o motor, e só por isso podem importar diretamente utilitários como `findProgram` e `tail` de `worker/agents.ts`; o motor, por sua vez, nunca referencia plugins.

Instale com `agent-autoloop add <endereço git>` em `~/.agent-autoloop/plugins/<nome do repositório>`; repositórios Git locais também são aceitos. O nome do plugin é o nome desse diretório: o nome do repositório é convertido para minúsculas e só pode conter letras minúsculas, dígitos e `-`. Qualquer outro nome é rejeitado, e a mensagem informa o nome que ele calculou. É esse nome que vai no `use` da regra e no `adapter` da fonte. O comando apenas clona: não instala dependências, não roda scripts de instalação e não atualiza automaticamente. O plugin é executado no carregamento, e um plugin de mesmo nome no diretório de instalação tem prioridade.

## Comece executando

Execute este comando no diretório do motor: ele instala os três exemplos em centrais temporárias, percorre de verdade a validação de assinatura, o despacho, a execução, a notificação e o relatório, e limpa tudo ao sair.

```bash
node --disable-warning=ExperimentalWarning --test --test-name-pattern='agent-autoloop add' tests/example-plugins.test.ts
```

## Plugin de Agent

Comece por [hello-agent/agent.ts](../examples/plugins/hello-agent/agent.ts). Ele usa `printf` no lugar de um modelo e continua funcionando se for clonado para outro lugar. Imprime uma linha ao receber o prompt e outra ao terminar: pela primeira linha, `read` sabe que esta rodada retomou a sessão original, e a segunda linha é a última mensagem dele.

| Método do objeto exportado | Função |
| -------------------------- | ------ |
| `command(turn)` | Retorna o array de argumentos do comando; os argumentos não são executados como código de shell |
| `read(stdout, code, stderr)` | Retorna `text`, `session`, `usage`, `sessionUsage`, `error`, `finished` e `started`; durante a execução, `code` é `null` |
| `link(session)` | Opcional: o link para abrir esta sessão. Quando o recibo vem escrito errado, todo plugin cujo `read` retornou `session` apenas reescreve o recibo, independentemente de haver link ou não |
| `check(program)` | Opcional: o `doctor` pergunta a ele se este Agent está utilizável agora — retorna `null` se estiver e, caso contrário, retorna o que fazer em seguida. O argumento é o `program` escrito para ele na regra; se não houver, nada é passado |

Em `turn` sempre existem `prompt`, `session`, `resume`, `cwd`, `access`, `contextFile` e `folder`; os outros cinco só existem se a regra os tiver definido para este Agent: `model`, `effort`, `tier`, `command` e `program`. `resume` é a sessão original que esta rodada deve retomar, e é `null` quando uma rodada nova é aberta. `contextFile` é o arquivo de dados, e um CLI restrito precisa ter permissão de leitura em `folder`. `program` é o programa de inicialização que o plugin integrado substitui; plugins de terceiros não o usam, e podem recebê-lo e ignorá-lo. `tier` é a faixa de serviço, com a denominação do próprio CLI: hoje só o plugin integrado do Codex a utiliza (passada como `-c service_tier="…"`, em que `priority` equivale ao Fast do aplicativo Codex), e os demais plugins a recebem e ignoram. Leia esses cinco como "podem não existir", que é exatamente como os plugins integrados fazem: `...(turn.model ? ["--model", turn.model] : [])`, `turn.command ?? []`. `read` precisa saber lidar com saída ainda incompleta; só retorne `text` quando o CLI realmente terminar. Se `read` lançar um erro ou não retornar nada, o que ainda está em execução continua; ao terminar, a rodada é contada como falha e permanece na sessão original para novo despacho.

Um plugin que suporta `resume` deve retornar `started: true` desde o momento em que o Agent recebe o prompt, inclusive durante a execução e depois de um erro. Caso contrário, uma interrupção no meio do trabalho também será tratada como sessão impossível de retomar, abrindo uma sessão nova e refazendo o serviço. Se você retorna `session`, deve retomar a sessão original conforme `turn.resume`: o novo despacho após falha e a reescrita de recibos errados dependem disso. Um CLI que não consegue retomar não deve retornar `session`.

`usage` é o volume consumido por esta inicialização. `input` conta toda a entrada, e `cached` é a parte dela lida do cache; quando o CLI reporta a entrada sem incluir o cache (é o caso de Claude Code e DSH), o plugin soma de volta a leitura e a escrita de cache em `input`, para que os diferentes provedores possam ser comparados entre si. Alguns CLI só informam o acumulado da sessão inteira até agora (os Tokens do Codex, o custo do Claude Code): esses itens vão em `sessionUsage`, e `session` deve ser retornado junto. O worker anota o acumulado anterior dessa sessão antes de iniciar, subtrai ao terminar e reporta o resultado somado a `usage`; esses registros ficam em `~/.agent-autoloop/worker/usage/`, de modo que uma reinicialização do worker no meio do caminho não conta a mais.

Em continuações sem registro (troca de computador, sessões anteriores à atualização) ou quando o acumulado diminui, esses itens não são reportados desta vez, sem adivinhar; a continuação seguinte volta ao normal. O volume consumido por outros programas na mesma sessão não pode ser separado: quando o titular abre o link e continua a conversa, por exemplo, isso entra na conta da continuação seguinte. Se o CLI passar a reportar apenas o valor de cada execução, o plugin deve mover esses itens de volta para `usage`, sem tentar adivinhar pelo tamanho dos números.

Escolha este plugin na regra:

```json
{ "name": "Hello", "worker": "my-computer", "use": "hello-agent", "access": "read" }
```

O sandbox Windows elevated do Codex usa uma conta dedicada; o plugin concede a esse grupo de contas permissão de leitura sobre o `context.json` desta rodada, sem alterar a conta nem o modo de sandbox. O próprio Codex também concede a esse grupo de contas permissão de leitura nas pastas do diretório do usuário (incluindo o diretório de dados); veja [SECURITY](../SECURITY.md).

A execução nativa no Windows suporta `.exe`/`.com`, `.ps1` do PowerShell e wrappers `.cmd` gerados pelo npm (executando diretamente o ponto de entrada JS ou o `.exe`, preservando texto não-ASCII, várias linhas e aspas). Outros `.bat`/`.cmd` não são iniciados como código-fonte de shell; use um executável ou `node script.js`. O Unix continua procurando comandos pelo shell de login, e o Windows procura por PATH e PATHEXT; o próprio Agent também precisa suportar o sistema atual. Os tutoriais de shell, curl e jq deste documento rodam em Unix ou WSL.

Quando basta imprimir a última mensagem, use o `command` integrado com um array de argumentos — não é preciso escrever um plugin. Nos argumentos podem aparecer `{prompt}`, `{model}`, `{effort}`, `{cwd}` e `{context}`; cada argumento é substituído uma única vez, e o prompt inserido é passado ao programa exatamente como está: se o prompt contém `{cwd}` ou `$&`, o programa recebe esses mesmos caracteres, sem uma segunda substituição. Todo processo de Agent (incluindo scripts `program` configurados pelos plugins integrados) consegue ler as variáveis de ambiente `AGENT_AUTOLOOP_CONTEXT` (arquivo de dados) e `AGENT_AUTOLOOP_RUN` (nº da rodada). O número não muda em novas tentativas da mesma rodada nem na reescrita do recibo; respostas e reverificações vencidas são uma rodada nova, com número diferente.

O DeepSeek Harness tem o plugin integrado `dsh`; escreva `use: "dsh"` na regra. É necessário 0.2.2 ou mais recente, e o `agent-autoloop doctor` verifica isso. Hoje o `latest` do npm ainda é uma versão antiga, então instale assim: `npm install -g @deepseek-ai/dsh@next --allow-scripts=koffi,node-pty,@deepseek-ai/dsh-subprocess-local`. O npm novo não executa por padrão os scripts de instalação das dependências; se esses três pacotes não forem liberados, a instalação parece normal e o erro só aparece ao rodar. Quem vem de uma versão antiga pode ter um 0.2.2 incapaz de ler o `refs` de `~/.dsh/.credentials.yaml`, reportando `MISSING_CREDENTIAL`: coloque a chave em uma variável de ambiente e, para serviços de sistema no Linux, em `~/.config/environment.d/*.conf`. Reporta apenas Tokens, não custos. Um usuário relatou ter validado na prática, em WSL2 com 0.2.2-rc.1 e um serviço compatível com OpenAI de terceiros, perguntas e respostas, uso e `resume`. Ele executa uma rodada com `dsh headless --json`, obtém o número da sessão no evento `session`, retoma com `--session-id`, soma o uso de `step_end` em Tokens e só considera a rodada concluída no evento `final`; `access` é mapeado sempre para `--permission-mode`, e chamadas que exigiriam aprovação humana são recusadas diretamente com `--approval-policy never`. `model` e `effort` da regra não têm efeito: vale a configuração do próprio DSH. Não há link de sessão de desktop para abrir. Por padrão o DSH envia os logs de sessão à DeepSeek; veja [a documentação dele](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md).

O ZCode tem o plugin integrado `zcode`; escreva `use: "zcode"` na regra. Ele inicia o CLI instalado junto com a versão de desktop, roda `zcode -p … --json` e, ao final da rodada, imprime um objeto JSON: o número da sessão vem de `sessionId`, `response` é a última mensagem e `inputTokens`, `outputTokens` e `cacheReadTokens` dentro de `usage` são os Tokens da rodada; a rodada seguinte retoma com `--resume sess_…`. `access` é mapeado para os modos dele: `read`→`plan`, `edit`→`edit`, `full`→`yolo`. No Windows o CLI é um pacote `.cjs`: escreva `"program": "caminho\\zcode.cjs"` no Agent e o plugin o iniciará com node; também vale indicar outro executável. `model` e `effort` da regra não têm efeito — modelo e provedor são definidos pela configuração do próprio ZCode; se o CLI retornar vazio com `-p`, troque primeiro para um provedor funcional no ZCode. Reporta apenas Tokens, não custos; não há link de sessão de desktop para abrir.

### Acesso ao navegador

As ferramentas de navegador ficam instaladas no computador que roda o Agent e são fornecidas pela configuração de ferramentas do CLI ou por um Skill do projeto. O plugin do Codex inicia o [`codex exec`](https://developers.openai.com/codex/noninteractive/) em segundo plano; é possível usar as [ferramentas MCP](https://developers.openai.com/codex/mcp/) já configuradas nele, mas não se pode concluir que o segundo plano acessa o mesmo navegador só porque o aplicativo de desktop consegue abrir páginas.

As regras completas, o Skill e o script de invocação com parâmetros para o Claude delegar ao Codex estão no [modelo de passagem para o navegador](../examples/recipes/browser-handoff/README.md). O comando de entrada, o alvo e as operações permitidas são configurados pelo titular; o assistente web retorna evidências e o número da sessão, e a tarefa principal cuida do negócio e do recibo.

Quando já existir uma entrada dedicada de navegador, escreva no `prompt` ou no `skill` da regra o comando real, o modo de continuação da sessão e as operações permitidas. Entregue apenas os passos web, retornando o que foi visto, o resultado das operações e o motivo do bloqueio; a tarefa principal cuida do negócio e do recibo à central. A entrada de navegador não é um componente obrigatório: a central não embute scripts de um computador específico nem modifica automaticamente a configuração de ferramentas do CLI.

Tarefas que exigem aceite pela web precisam abrir de fato a página de destino com o mesmo modo de inicialização em segundo plano, conferir o conteúdo e continuar a sessão uma vez. Se não houver entrada disponível, ou se for preciso que o titular restabeleça a conexão, faça login ou valide algo, mantenha os itens não aceitos e use o `ask` existente para esperar a retomada; não escreva "FALHOU:" para disparar um novo despacho, nem trate uma consulta HTTP como se o aceite pela web já tivesse sido feito.

## Plugin de canal

Comece por [hello-channel/channel.ts](../examples/plugins/hello-channel/channel.ts). Ele escreve os cartões em um arquivo e responde pela linha de comando.

A exportação padrão é uma função assíncrona com os parâmetros `{ hub, options, log, signal }`; `options` vem de `config.json` e não inclui a chave da central.

| Chamada | Função |
| ------- | ------ |
| `hub.nextCard(50)` | Busca cartões com long polling; sem cartões, retorna `{ card: null }` |
| `hub.delivered(id, version, ref)` | Reporta a entrega e salva o número externo da mensagem |
| `hub.failed(id, version, error)` | Reporta falha de envio |
| `hub.answer(id, { choice, by, ref })` | Encaminha a resposta; confere quem respondeu e a mensagem original |

Com `ref` vazio, envia uma mensagem nova; com valor, atualiza a mensagem original; quando não dá para atualizar, apenas reporta. Cartões não reportados voltam a ser despachados depois de um minuto. Saia quando `signal` for abortado; se a função retornar ou lançar um erro antes disso, o fato é registrado no log e ela reinicia após 30 segundos — por isso ela deve permanecer em execução. O plugin e a central vivem no mesmo processo: erros não capturados são apenas registrados no log, sem derrubar a central.

Registre o canal em `rules.json`, obtenha a chave com `agent-autoloop key new channel cards` e coloque o item abaixo em `channels` no `config.json`; depois reinicie a central:

```json
{ "cards": { "use": "hello-channel", "key": "chave do canal", "file": "/tmp/cards.txt" } }
```

Um canal que recebe callbacks deve definir `answerers` na regra; sem isso, qualquer pessoa no canal pode responder, e o `doctor` avisa. Um canal que só envia texto deve definir `links: true` e enviar o `card.link`. Quem obtiver o link consegue responder àquele cartão.

O canal e a central compartilham um único processo Node, então chamadas externas devem ser aguardadas de forma assíncrona. O canal integrado do Feishu consulta usuários, envia e atualiza chamando o CLI de modo assíncrono; durante o envio, a central continua recebendo eventos e heartbeats.

## Plugin de eventos

Comece por [hello-source/source.ts](../examples/plugins/hello-source/source.ts). Ele verifica o HMAC-SHA256 em `x-shop-signature` e então converte pedidos em eventos.

A exportação padrão é uma função síncrona com os parâmetros `{ headers, body, secret }`. Valide a assinatura primeiro e só depois analise o conteúdo; retorne um array de eventos, `[]` quando não houver nada, e lance uma exceção para recusar a requisição. O plugin de eventos apenas traduz, não faz requisições.

Registre a fonte em `rules.json`:

```json
{ "shop": { "name": "Loja", "adapter": "hello-source" } }
```

O endereço da requisição é `/v1/in/shop`; o segredo fica em `AGENT_AUTOLOOP_SECRET_SHOP` no `secrets.env` (nome da fonte em maiúsculas, com `-` trocado por `_`; reinicie a central após alterar), nunca na regra. Um evento precisa ter `id` estável e `type` válido, e pode trazer `subject`, `summary`, `detail` e `link`; os limites estão no [protocolo](protocol.md#fontes-transformar-o-mundo-em-eventos).

Quando a fonte consegue enviar JSON padrão diretamente, não é preciso escrever um plugin: basta chamar `POST /v1/events` com a chave da fonte e, depois, consultar o andamento com `GET /v1/events/<número>` usando a mesma chave (veja o [protocolo](protocol.md#fontes-transformar-o-mundo-em-eventos)).

## O que o access realmente permite

`access` é traduzido pelo plugin; não é um sandbox de sistema fornecido pela central. Abaixo está o comportamento quando nenhuma permissão local adicional é liberada.

| Plugin | `read` | `edit` | `full` |
| ------ | ------ | ------ | ------ |
| Codex | `read-only`: roda shell, não escreve arquivos e os comandos não têm rede por padrão | `workspace-write`: roda shell, escreve no diretório de trabalho e no temporário; os comandos não têm rede por padrão | `danger-full-access`: escreve arquivos, roda shell e acessa a rede, sem aprovação |
| Claude Code | `plan`: lê arquivos e executa comandos somente leitura; os demais comandos dependem da aprovação automática e das regras locais | `acceptEdits`: também permite editar arquivos dentro do diretório e operações comuns de arquivo; qualquer shell ou rede ainda precisa ser liberado | `bypassPermissions`: pula a aprovação de ferramentas, sem isolamento de sistema adicional |
| DeepSeek Harness | `read-only`: não escreve arquivos; leitura de arquivos e rede sem restrições | `workspace-write`: comandos e alterações de arquivos limitados ao diretório de trabalho e ao temporário; leitura de arquivos e rede sem restrições | `danger-full-access`: sem restrições |
| ZCode | `plan`: planejamento somente leitura, não escreve arquivos | `edit`: aplica edições automaticamente e executa comandos de shell diretamente | `yolo`: sem aprovação e sem restrições |
| ACP | Quando o Agent pergunta, autoriza leitura e busca | Também autoriza edições dentro do diretório de trabalho | Autoriza todas as operações que o Agent vier a perguntar |

As três faixas do Codex foram executadas de fato com o comando do plugin; no ZCode, o CLI real percorreu o modo `edit`, uma pergunta e a continuação da sessão após a resposta, enquanto `plan` e `yolo` foram organizados a partir da documentação do `--mode` dele; DeepSeek Harness e Claude Code foram compilados com base na [documentação do DSH](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md) e na [documentação oficial de permissões](https://code.claude.com/docs/en/permission-modes), sem executar o modelo de verdade. A restrição de rede dos comandos do Codex não é a mesma fronteira de hosted search e MCP; veja a [documentação oficial de sandbox](https://learn.chatgpt.com/docs/agent-approvals-security). A configuração de CLI do usuário pode mudar as capacidades acima, e `read` também não significa que as chaves locais estejam inacessíveis.

O `access` do ACP só cobre as operações que o Agent pergunta por conta própria. A especificação permite que o Agent execute sem perguntar, e esse tipo de operação o `access` não consegue bloquear: é preciso limitar pelo modo do próprio Agent, por exemplo escrevendo `env INITIAL_AGENT_MODE=read-only …` em `command`. `model`, `effort` e `tier` do ACP não têm efeito e também devem ser configurados do lado do Agent.

As receitas escolhem permissões com base nisso: o briefing matinal usa `edit` para escrever arquivos locais, a de issues usa `edit` para alterar código e deixa um script fixo acessar a rede para buscar o corpo da issue, e a de alertas usa `read` para examinar o código e a pilha de chamadas que acompanha o evento. Tratamento de feedback, resumo do Feishu e triagem de e-mail usam `edit`; investigação de site usa `read`. Os scripts fixos de inspeção, de leitura do Feishu e de leitura da caixa de e-mail cuidam do acesso à rede, enquanto os Agents de resumo e de triagem leem apenas o snapshot completo. `command` e os scripts fixos rodam com a conta local, sem ficar sujeitos ao `access`.

## Teste de conformidade

Execute no diretório do motor as verificações HTTP existentes do protocolo, todas com dados temporários e portas aleatórias:

```bash
node --disable-warning=ExperimentalWarning --test tests/conformance.test.ts
```

Para verificar outras implementações da central, use `agent-autoloop conformance <endereço de teste> --config <arquivo de credenciais de teste>`; o formato do arquivo está no [protocolo](protocol.md#conformidade-e-reprodução). Ele escreve eventos e cartões, então rode apenas contra uma central dedicada de testes.

O teste completo de integração do plugin em si está em [tests/example-plugins.test.ts](../tests/example-plugins.test.ts). Também vale escrever um processo independente em outra linguagem; veja o [canal em curl/jq](../examples/channel.sh) e o [worker](../examples/worker.sh).
