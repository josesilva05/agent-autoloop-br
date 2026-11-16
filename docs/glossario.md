# Glossário e vocabulário canônico (pt-BR)

Este repositório é a localização brasileira do **Agent Autoloop**. Este documento fixa o
vocabulário canônico em português do Brasil para que qualquer mudança futura — código,
documentação, testes ou mensagens — permaneça coerente. Ele é o contrato de estilo do projeto.

Regra geral: não deve existir texto em outro idioma natural no repositório. Inglês permanece
apenas em identificadores de código, nomes de produtos, siglas e termos técnicos consagrados
que este documento lista como empréstimos (`event sourcing`, `view`, `heartbeat`, `merge`,
`claim`, `lane`, `stream`, `lock`, `polling`, `listener`, `commit`, `log`).

---

## 1. Termos de arquitetura

| Termo canônico (pt-BR) | O que designa |
|---|---|
| **central** | o próprio Agent Autoloop em execução; o serviço que recebe, decide, despacha e registra |
| **kernel** | a camada determinística (`kernel/`): só recebe, decide, despacha e registra fatos |
| **host** | a casca de execução (`host/`): HTTP, arquivos, SQLite, relógio, serviço em segundo plano |
| **worker** | o programa executor (`worker/`): pega trabalho, roda o Agent, entrega o recibo |
| **regra** | uma entrada de `rules[]`: o que dispara, quem executa, onde e com que instrução |
| **evento** | a unidade de trabalho que entra na central |
| **fonte** | quem pode emitir eventos (`sources`) |
| **canal** | por onde os cartões chegam ao titular (`channels`) |
| **cartão** | a unidade de interação humana: `ask` (decisão) ou `notice` (aviso) |
| **rodada** | uma execução de trabalho por um Agent; o número dela é o `#N` dos comandos |
| **despacho** | o ato de entregar uma rodada a um worker |
| **recibo** | o bloco `agent-autoloop` com JSON que o Agent anexa à última mensagem |
| **fato** | uma entrada do registro append-only; **registro de fatos** é o log completo |
| **projeção** | o estado derivado do registro; **view** é a leitura por índice |
| **assunto** | a coisa sobre a qual os eventos falam (um Issue, um feedback, um site) |
| **objeto** | o identificador do assunto dentro de um evento (`subject`) |
| **reverificação** | um retorno agendado pelo próprio Agent (`later`) |
| **vencido** | o que chegou à hora (`due`) |
| **saltos** | a contagem de camadas entre Agents; o disjuntor para em 8 |
| **espera de custo zero** | esperar sem processo vivo e sem token gasto |
| **separação entre instrução e dados** | texto de terceiros nunca vira instrução |
| **disjuntor de saltos** | o limite de 8 camadas que impede laços entre Agents |
| **pipeline de entrega** | o plugin de CI/CD (`delivery`) |
| **revisão** | a etapa de revisão de código do pipeline de entrega |
| **merge** | a junção do PR (empréstimo consagrado) |
| **ir para produção** | o deploy; **versão saudável** é a que está viva e verificada |
| **chave** | credencial por tipo e nome; **chave mestra** é a do banco |
| **o titular** | a pessoa dona da central; quem responde aos cartões |
| **decidir** / **decisão** | o ato humano que um cartão `ask` solicita |
| **agendamento** | tarefa por cron; é também o nome da fonte reservada `schedule` |
| **pausar** / **retomar** / **reexecutar** | `pause` / `resume` / `replay` |
| **execução de teste** | o que `agent-autoloop try` faz |
| **receita** | um cenário pronto em `examples/recipes/` |
| **manual de tratamento** | o Skill que uma regra carrega |
| **notificação de desktop** | o canal `desktop` |
| **Uso** | o título dos textos de ajuda de cada comando |

## 2. Marcadores de protocolo

A primeira linha da última mensagem do Agent diz como a rodada terminou. Estes marcadores são
interpretados por `worker/contract.ts` e **não podem ser alterados** sem alterar o protocolo:

| Marcador | Significado | Efeito |
|---|---|---|
| `FALHOU:` | falha temporária | nova tentativa automática em alguns minutos |
| `NADA A FAZER:` | nada havia a fazer | encerra sem retry e sem notificar |
| `AGUARDANDO VOCÊ:` | bloqueio que só o titular resolve | encerra mantendo a pergunta aberta |
| `não deixou resultado` | mensagem vazia | contado como falha |
| `sem motivo informado` | `FALHOU` sem texto | motivo padrão |

Os fallbacks em inglês `FAILED` e `NOTHING` continuam aceitos por compatibilidade.

## 3. Estados e rótulos de interface

| Rótulo canônico | Onde aparece |
|---|---|
| Aguardando você | contador de cartões pendentes |
| Em execução / Na fila / Aguardando novo despacho / Incerto | contadores do `status` |
| Concluídas hoje | contador do `status` |
| Concluído / Concluída | desfecho de rodada (`done`) |
| Interrompida | rodada parada (`cancelled`) |
| Online / Offline | presença de Agents e canais |
| Em andamento | seção de rodadas ativas |
| Rodadas recentes / Cartões recentes | seções do `status` |
| Respondido / Concluído / Fechado / Resolvido | estados de cartão (`decided`/`done`/`closed` e o desfecho de notice) |
| Decisão / Atenção | tipo de cartão (`ask` / `notice`) |
| recomendado | a opção sugerida num `ask` |
| Pausadas | seção de regras pausadas |
| Agendamentos | seção de tarefas por cron |
| Eventos sem regra | eventos que nenhuma regra pegou |
| horário atingido | o gatilho de um cron |
| ontem / amanhã | dias relativos no `status` |
| dom, seg, ter, qua, qui, sex, sáb | dias da semana |
| minutos / horas | durações |

Locale: toda formatação de data e hora usa **`pt-BR`** (`Intl.DateTimeFormat`, `toLocaleString`).

## 4. Títulos canônicos dos documentos

Estes títulos são alvo de links entre documentos; as âncoras derivam deles no formato do GitHub
(minúsculas, sem pontuação, espaços virando hífen, **acentos preservados**).

- `README.md`: Que problema ele resolve? · Primeiros passos · Como uma tarefa flui · Como
  configurar no dia a dia? · Receitas prontas para usar · Sistema de plugins: os quatro lados
  são substituíveis · Os quatro mecanismos do kernel · Verifique você mesmo · Desempenho medido ·
  Uso e conformidade · Mais documentação
- `AGENTS.md`: Princípios · Como alterar · Contribuições da comunidade · Pontos de revisão ·
  Como fechar um lote · Como publicar uma versão · Fronteiras do kernel · Fronteiras de plugins
  e entrega · Escopo de verificação
- `docs/plugins.md`: Escrever plugins · Comece executando · Plugin de Agent · Acesso ao
  navegador · Plugin de canal · Plugin de eventos · O que o access realmente permite · Teste de
  conformidade
- `docs/protocol.md`: Protocolo · Seis palavras · Seis princípios · Regras · Fontes: transformar o
  mundo em eventos · Agent: pegar trabalho, executar e entregar o recibo · O Agent só precisa
  fazer uma coisa · Conectar um novo Agent · Canais: levar o cartão até você · O titular: visão
  geral, respostas, encerramento e parada · Pausar, retomar, reexecutar e rodar agora · O que
  acontece em caso de falha · Quem pode fazer o quê · Log e determinismo · Conformidade e
  reprodução · ACP e MCP · Modelos de canal e exemplos de linha de comando · Receitas de negócio ·
  Estrutura e medições · Crescimento do histórico na prática · Plugin de entrega · Versão e
  compatibilidade
- `skills/agent-autoloop/SKILL.md`: Central de automação de Agents · Acompanhar e responder ·
  Editar regras · Escrever um manual de tratamento · Conectar um plugin de eventos · Conectar um
  Agent · Conectar um canal · Pipeline de entrega · MCP e revogação de chaves · Servidor e
  computadores adicionais · Log e recuperação · Versão e desinstalação

## 5. Nomes canônicos dos fixtures de teste

`tests/rules.fixture.json` é compartilhado por dezenas de testes. Estes valores são fixos:

| Papel | Nome canônico |
|---|---|
| Fonte `app` / `ops` / `hooks` | aplicativo / operações / externo |
| Agent `a1` / `a2` / `a3` | alfa / beta / gama |
| Canal `chat` / `plain` | chat / texto |
| Regras | opiniões · alerta · alerta também registra · briefing matinal · inspeção |
| Tarefa de outro lugar | limpeza semanal |
| Pessoa genérica em dados de teste | Fulano (e Beltrano quando precisa de um segundo) |

## 6. Política de fuso horário

Identificadores de fuso são **dados funcionais, não idioma**: `Asia/Shanghai` permanece
`Asia/Shanghai` em fixtures, exemplos de `rules.json` e blocos de código, porque trocá-lo muda o
resultado das expressões cron e quebra os testes de agendamento. Em prosa, escreva "fuso
Asia/Shanghai (horário de Pequim)". Exemplos ilustrativos de horário dentro de strings de prompt
podem usar `-03:00`.

## 7. Strings canônicas de validação de `rules.json`

`protocol/rules.ts` produz estas mensagens e os testes as verificam. São fixas:

- `O rules.json tem problemas:` · `não pode ficar vazio` · `só pode usar letras minúsculas,
  números e -` · `{onde} deve ser um objeto` · `{onde} deve ser uma lista` · `{onde} está sem
  {campo}` · `{onde}: o campo {campo} {problema}` · `{onde} tem o campo desconhecido {campo}` ·
  `o nome de regra "{n}" está duplicado` · `a regra "{n}": ` · `{onde} no when, ` · `{onde} no
  emits, ` · `não é um Agent registrado` · `não é uma fonte registrada` · `deve ser um diretório
  absoluto (por exemplo ~/code, /srv/app, C:\code ou \\servidor\compartilhamento)` · `deve ser
  uma palavra só, começando com letra ou número e sem espaços; os únicos placeholders permitidos
  são {id} e {subject}` · `deve ser um inteiro positivo` · `deve ser um inteiro positivo (em
  minutos)` · `só pode ser true ou false` · `só pode ser {lista}` (itens separados por `, `) ·
  `deve ser uma lista de identificadores de canal` · `deve ser uma lista de comandos` · `deve ser
  o caminho de um programa` · `deve ser uma lista de textos` · `deve ser uma lista de tipos de
  evento; pode usar x.* ou *` · `não é um cron válido` · `não é um fuso horário válido` · `{onde}
  o agendamento nunca chega: {cron}` · `{onde} escreva pelo menos um entre skill e prompt` ·
  `{onde} o campo channels tem um canal não registrado: {c}` · `o campo defaultChannels do
  rules.json tem um canal não registrado: {c}` · `a fonte {id} é reservada: agendamentos usam o
  cron da regra` · `o identificador da fonte {regra}: {id}` · `a fonte {id}: ` · `o identificador
  do canal {regra}: {id}` · `o canal {id}: ` · `o identificador do Agent {regra}: {id}` · `o
  Agent {id}: ` · `as regras do grupo "{g}" precisam ter o mesmo parallel` · `a tarefa agendada
  "{n}" tem o mesmo nome de outra regra ou tarefa agendada` · `a tarefa agendada "{n}": ` · `a
  tarefa agendada "{n}" diz o que fazer depois da resposta: falta o cwd onde continuar` · `a
  tarefa agendada "{n}" tem cwd: escreva pelo menos um entre skill e prompt, o que fazer após a
  resposta` · `não é JSON: {erro}`

A lista padrão de ações que exigem decisão prévia (`askFirst`) é, nesta ordem: **apagar dados ·
derrubar serviço · gastar dinheiro · enviar mensagens a terceiros · mudar a direção do produto ·
criar ou rotacionar chaves · alterar permissões**. A fonte reservada de agendamento se chama
`agendamento`.

## 8. Sentinelas entre módulos

Estes literais aparecem em mais de um diretório de código e são comparados por igualdade ou por
regex em testes. A forma é obrigatória em todos os lados:

- `Resolvido` — produzido por `kernel/decide.ts`, comparado em `cli/status.ts` e
  `plugins/webhook/channel.ts`
- `o titular` · `não deixou resultado` · `sem motivo informado` · `FALHOU` · `NADA A FAZER` ·
  `Concluído` · `agendamento` · `canal` · `Feishu` · `notificação de desktop` · `alfa`/`beta`/`gama`
- `Interrompida` · `não existe esse endereço` · `não existe essa rodada` · `esta fonte não aceita
  Webhook` · `ainda não está instalado: rode antes agent-autoloop init` · `não é JSON` · `nome
  fixo deste assunto` · `uma frase` · `respondeu ${response.status}` · `fora dos limites` ·
  `verificado` · `Fechado` · `corrigido` · `escolha uma` · `escolha` · `um`/`dois`/`três` ·
  `conteúdo` · `reverificação` · `fonte`
- `Nota de tratamento` com maiúscula é o rótulo de UI na página do cartão (seguido de `: `);
  `nota de tratamento` minúsculo compõe mensagens
- `agent-autoloop try`: `execução de teste` · `experimente` · `Execução de teste: escolha uma
  cor` · `Azul` · `Verde` · `Execute agent-autoloop status para ver`
- `status`: `Online` · `Em andamento` · `Rodadas recentes` · `Cartões recentes` · `Eventos sem
  regra` · `esta máquina` · `continuando a sessão da rodada anterior` · `Fonte: ` (com espaço)
- Mensagens de plugin: `o ACP não devolveu um identificador de sessão` · `O Agent fez uma
  pergunta a você` · `o Codex não concluiu nem deixou um resultado` · `o DSH não concluiu nem
  deixou um resultado` · `o DSH não terminou esta rodada` · `o ZCode não concluiu nem deixou um
  resultado` · `esta rodada esgotou o limite de saída` · `esta rodada foi abortada` · `esta
  rodada travou e não concluiu` · `o rules.json está com erro; as regras antigas continuam em
  uso` · `o worker não conectou` · `uma rodada que falhou só pode enviar notificação` · `fora do
  escopo de verificação desta rodada` · `este trabalho não pertence a este token` · `o rótulo de
  entrega foi retirado` · `entrega devolvida: ${reason}` · `a revisão encontrou problemas; merge
  ainda não feito` · `não há rótulo de entrega pendente` · `Registrar e encerrar` · `não foi
  possível confirmar que o merge automático foi encerrado` · `a mudança foi fechada ou o branch
  de destino mudou; o merge é só para o main.` · `o pull request foi fechado; sem merge nem
  publicação` · `NADA A FAZER: o pull request foi fechado` · `código de saída ${code}: `

## 9. O que não se traduz

Identificadores de código, nomes de arquivos e diretórios, chaves e nomes de campo JSON, comandos
(`agent-autoloop status`), flags (`--json`, `--dry-run`, `--since`), variáveis de ambiente
(`AGENT_AUTOLOOP_HOME`, `NO_COLOR`), URLs, endpoints HTTP (`/v1/state`, `/v1/stream`), expressões
cron, nomes de serviços e tarefas agendadas, labels e nomes de branch do GitHub (`deliver`,
`main`), SHA de ações, números de versão, limites numéricos e nomes de produtos e siglas (Node,
SQLite, macOS, Linux, Windows, launchd, systemd, PowerShell, Claude Code, Codex, ACP, MCP,
Feishu/Lark, lark-cli, DingTalk, WeCom, Slack, Discord, GitHub, GitLab).

Caracteres de largura total que têm função técnica permanecem: os substitutos `］` e `＜` que
impedem o WeCom de renderizar marcação injetada, a classe `[^\s；，。]` do regex de fronteira de
URL e o `：` aceito depois dos marcadores de protocolo.

## 10. Regras de estilo

- Pontuação brasileira; aspas curvas ou retas são aceitáveis, mas consistentes dentro de um
  arquivo. Parênteses comuns, nunca de largura total.
- Números no padrão pt-BR: vírgula decimal, ponto de milhar (`88,78 ms`, `2.394 eventos/s`).
- Comentários de código em pt-BR, explicando apenas o *porquê* que o código não mostra.
- Texto voltado ao usuário em português simples e direto, sem siglas técnicas, códigos de status,
  caminhos de arquivo nem identificadores internos quando o leitor não vê o código.
- Blocos de código com JSON: traduzir apenas valores de prosa, nunca chaves; o JSON deve
  continuar válido.
- O texto da licença MIT permanece como está: é texto legal e o nome do detentor dos direitos é
  um nome próprio.
