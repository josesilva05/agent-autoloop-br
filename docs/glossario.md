# Glossário de tradução (zh-CN → pt-BR)

Este arquivo é o contrato de tradução do repositório. Todo texto traduzido — documentação,
comentários de código, strings visíveis ao usuário e testes — **deve** usar exatamente os
termos abaixo. Se um termo não estiver aqui, escolha a tradução mais natural em português
do Brasil e acrescente-a a esta tabela.

Regra geral: o original chinês é a fonte de verdade; o `README.en.md` histórico (inglês) foi
usado como conferência de sentido. Não deve sobrar texto em chinês no resultado final, e o
inglês só permanece em nomes próprios de produtos, siglas e identificadores de código.

## 1. Termos de arquitetura

| Chinês | Inglês (referência) | **Português (obrigatório)** |
|---|---|---|
| 中台 | hub | **central** |
| 内核 | kernel | **kernel** |
| 外壳 / 运行外壳 | host | **host** |
| 接单程序 | worker | **worker** |
| 规则 | rule | **regra** |
| 事件 | event | **evento** |
| 来源 | source | **fonte** |
| 通道 | channel | **canal** |
| 卡片 | card | **cartão** |
| 一轮 / 轮次 / 第几轮 | run / round | **rodada** / **nº da rodada** |
| 派活 / 派 | dispatch | **despachar** / **despacho** |
| 回执 | receipt | **recibo** |
| 事实 / 事实日志 | fact / fact log | **fato** / **registro de fatos** |
| 投影 | projection | **projeção** |
| 事项 | thread / subject item | **assunto** |
| 对象 | subject | **objeto** |
| 到期 | due | **vencido** / **no prazo** |
| 复查 | follow-up check | **reverificação** |
| 跳数 | hops | **saltos** |
| 挂起零消耗 | zero-cost wait | **espera de custo zero** |
| 事件溯源 | event sourcing | **event sourcing** |
| 指令数据分离 | code / data split | **separação entre instrução e dados** |
| 跳数熔断 | hop circuit breaker | **disjuntor de saltos** |
| 交付流水线 | delivery pipeline | **pipeline de entrega** |
| 审查 | review | **revisão** |
| 合并 | merge | **merge** |
| 上线 | go live | **ir para produção** |
| 密钥 | key | **chave** |
| 主密钥 | master key | **chave mestra** |
| 本人 | the owner | **o titular** |
| 拍板 / 决定 | make the call | **decidir** / **decisão** |
| 定时 | schedule | **agendamento** / **tarefa agendada** |
| 暂停 / 恢复 / 补跑 | pause / resume / replay | **pausar** / **retomar** / **reexecutar** |
| 试跑 | try run | **execução de teste** |
| 场景模板 / 模板 | recipe | **receita** |
| 处理手册 | task skill / manual | **manual de tratamento** |
| 桌面通知 | desktop notification | **notificação de desktop** |
| 用法 | usage | **Uso** |

## 2. Marcadores de protocolo (NÃO alterar a forma)

Estes marcadores aparecem na primeira linha da última mensagem do Agent e são interpretados
por `worker/contract.ts`. A tradução é fixa e os testes dependem dela exatamente assim.

| Chinês | **Português** | Observação |
|---|---|---|
| `没跑成：` | **`FALHOU:`** | falha temporária, nova tentativa automática |
| `没事可做：` | **`NADA A FAZER:`** | nada havia para fazer |
| `待你处理：` | **`AGUARDANDO VOCÊ:`** | bloqueio que só o titular resolve |
| `没留下结果` | **`não deixou resultado`** | mensagem vazia |
| `没说原因` | **`sem motivo informado`** | `FALHOU` sem texto |

Os fallbacks em inglês já existentes (`FAILED`, `NOTHING`) são mantidos.

## 3. Estados e rótulos de interface

| Chinês | **Português** |
|---|---|
| 等你 | **Aguardando você** |
| 在跑 | **Em execução** |
| 排队 | **Na fila** |
| 等重派 | **Aguardando novo despacho** |
| 不确定 | **Incerto** |
| 今天做完 | **Concluídas hoje** |
| 做完了 | **Concluída** |
| 停了 | **Interrompida** |
| 在线 / 离线 | **Online** / **Offline** |
| 正在做 | **Em andamento** |
| 最近几轮 | **Rodadas recentes** |
| 最近的卡片 | **Cartões recentes** |
| 已回答 / 已完成 / 已关闭 / 已处理 | **Respondido** / **Concluído** / **Fechado** / **Resolvido** |
| 决定（cartão） | **Decisão** |
| 留意（cartão） | **Atenção** |
| 推荐 | **recomendado** |
| 暂停中 | **Pausadas** |
| 定时 | **Agendamentos** |
| 没有规则接的事件 | **Eventos sem regra** |
| 到点了 | **horário atingido** |
| 昨天 / 明天 | **ontem** / **amanhã** |
| 周日…周六 | **dom, seg, ter, qua, qui, sex, sáb** |
| 分钟 / 小时 | **minutos** / **horas** |

Locale: `zh-CN` → **`pt-BR`** em `Intl.DateTimeFormat` e `toLocaleString`.

## 4. Títulos fixos (âncoras de link)

Estes títulos são alvo de links entre documentos. A tradução **deve** ser literalmente a
string da coluna da direita, para que as âncoras geradas pelo GitHub coincidam.

### `README.md`

| Original | **Título em pt-BR** |
|---|---|
| `## 它解决什么问题？` | `## Que problema ele resolve?` |
| `## 上手` | `## Primeiros passos` |
| `## 一件事怎么转起来` | `## Como uma tarefa flui` |
| `## 日常怎么配？` | `## Como configurar no dia a dia?` |
| `## 拿来即用的场景模板` | `## Receitas prontas para usar` |
| `## 插件体系：四个方向都能自由替换` | `## Sistema de plugins: os quatro lados são substituíveis` |
| `## 内核的四个机制` | `## Os quatro mecanismos do kernel` |
| `### 自己跑一遍` | `### Verifique você mesmo` |
| `### 实测性能` | `### Desempenho medido` |
| `## 用量与合规说明` | `## Uso e conformidade` |
| `## 更多文档` | `## Mais documentação` |

### `AGENTS.md`

| Original | **Título em pt-BR** |
|---|---|
| `## 原则` | `## Princípios` |
| `## 怎么改` | `## Como alterar` |
| `## 社区贡献` | `## Contribuições da comunidade` |
| `## 审查要点` | `## Pontos de revisão` |
| `## 一批怎么收尾` | `## Como fechar um lote` |
| `## 怎么发版` | `## Como publicar uma versão` |
| `## 内核边界` | `## Fronteiras do kernel` |
| `## 插件与交付边界` | `## Fronteiras de plugins e entrega` |
| `## 验证范围` | `## Escopo de verificação` |

### `docs/plugins.md`

| Original | **Título em pt-BR** |
|---|---|
| `# 写插件` | `# Escrever plugins` |
| `## 先跑起来` | `## Comece executando` |
| `## Agent 插件` | `## Plugin de Agent` |
| `### 浏览器接入` | `### Acesso ao navegador` |
| `## 通道插件` | `## Plugin de canal` |
| `## 事件插件` | `## Plugin de eventos` |
| `## access 实际能做什么` | `## O que o access realmente permite` |
| `## 一致性测试` | `## Teste de conformidade` |

### `docs/protocol.md`

| Original | **Título em pt-BR** |
|---|---|
| `# 协议` | `# Protocolo` |
| `## 六个词` | `## Seis palavras` |
| `## 六条原则` | `## Seis princípios` |
| `## 规则` | `## Regras` |
| `## 来源：把世界变成事件` | `## Fontes: transformar o mundo em eventos` |
| `## Agent：领活、干活、交回执` | `## Agent: pegar trabalho, executar e entregar o recibo` |
| `### Agent 只需要做一件事` | `### O Agent só precisa fazer uma coisa` |
| `### 接一个新 Agent` | `### Conectar um novo Agent` |
| `## 通道：把卡片送到你面前` | `## Canais: levar o cartão até você` |
| `## 本人：看全局、回答、结案、停止` | `## O titular: visão geral, respostas, encerramento e parada` |
| `### 暂停、恢复、补跑、立即运行` | `### Pausar, retomar, reexecutar e rodar agora` |
| `## 失败时会怎样` | `## O que acontece em caso de falha` |
| `## 谁能做什么` | `## Quem pode fazer o quê` |
| `## 日志与确定性` | `## Log e determinismo` |
| `## 一致性和复现` | `## Conformidade e reprodução` |
| `### ACP 和 MCP` | `### ACP e MCP` |
| `### 通道模板与命令行示例` | `### Modelos de canal e exemplos de linha de comando` |
| `## 业务场景模板` | `## Receitas de negócio` |
| `## 结构与实测` | `## Estrutura e medições` |
| `### 历史增长实测` | `### Crescimento do histórico na prática` |
| `## 交付插件` | `## Plugin de entrega` |
| `## 版本与兼容` | `## Versão e compatibilidade` |

### `skills/agent-autoloop/SKILL.md`

| Original | **Título em pt-BR** |
|---|---|
| `# Agent 自动化中台` | `# Central de automação de Agents` |
| `## 看情况、回答` | `## Acompanhar e responder` |
| `## 改规则` | `## Editar regras` |
| `## 写处理手册` | `## Escrever um manual de tratamento` |
| `## 接一个事件插件` | `## Conectar um plugin de eventos` |
| `## 接一个 Agent` | `## Conectar um Agent` |
| `## 接一个通道` | `## Conectar um canal` |
| `## 交付流水线` | `## Pipeline de entrega` |
| `## MCP 与密钥撤销` | `## MCP e revogação de chaves` |
| `## 放到服务器、加电脑` | `## Servidor e computadores adicionais` |
| `## 日志与恢复` | `## Log e recuperação` |
| `## 版本与卸载` | `## Versão e desinstalação` |

## 5. Nomes fixos dos fixtures de teste

`tests/rules.fixture.json` é compartilhado por dezenas de testes. Os valores abaixo já foram
traduzidos e **devem** ser usados exatamente assim em qualquer teste que precise dos mesmos
nomes de exemplo:

| Papel | Chinês | **Português** |
|---|---|---|
| Fonte `app` | 应用 | **aplicativo** |
| Fonte `ops` | 运维 | **operações** |
| Fonte `hooks` | 外部 | **externo** |
| Agent `a1` | 甲 | **alfa** |
| Agent `a2` | 乙 | **beta** |
| Agent `a3` | 丙 | **gama** |
| Canal `chat` | 聊天 | **chat** |
| Canal `plain` | 文字 | **texto** |
| Regra | 意见 | **opiniões** |
| Regra | 告警 | **alerta** |
| Regra | 告警也记一笔 | **alerta também registra** |
| Regra | 早报 | **briefing matinal** |
| Regra | 巡检 | **inspeção** |
| Tarefa de outro lugar | 每周清理 | **limpeza semanal** |

Para nomes de exemplo fora do fixture, use `alfa`/`beta`/`gama` no lugar de 甲/乙/丙, e
`Fulano` no lugar de 王某.

## 6. Política de fuso horário (IMPORTANTE)

Identificadores de fuso horário são **dados funcionais, não idioma**. Eles NÃO devem ser
traduzidos nem trocados:

- `Asia/Shanghai` permanece `Asia/Shanghai` em fixtures de teste, exemplos de `rules.json` e
  blocos de código. Trocar o fuso altera o resultado de cron e quebra os testes de
  agendamento.
- Em prosa, onde o original diz "北京时间" (horário de Pequim), escreva **"fuso Asia/Shanghai
  (horário de Pequim)"** para manter a informação técnica correta.
- Exemplos ilustrativos de horário com fuso dentro de strings de prompt (não funcionais)
  podem usar `-03:00`.

## 7. Strings fixas de validação de `rules.json`

`protocol/rules.ts` produz estas mensagens e `tests/rules.test.ts` as verifica. A tradução é
**fixa** — quem traduzir a fonte e quem traduzir o teste precisam gerar exatamente isto.

### Lista padrão de ações que exigem decisão prévia (`ASK_FIRST`)

| Chinês | **Português** |
|---|---|
| 删数据 | **apagar dados** |
| 停服 | **derrubar serviço** |
| 花钱 | **gastar dinheiro** |
| 对外发消息 | **enviar mensagens a terceiros** |
| 改产品方向 | **mudar a direção do produto** |
| 新建或轮换密钥 | **criar ou rotacionar chaves** |
| 修改权限 | **alterar permissões** |

A fonte reservada de agendamento `rules.sources[SCHEDULE]` recebe `{ name: "agendamento" }`.

### Mensagens

| Chinês | **Português** |
|---|---|
| `rules.json 有问题：` | `rules.json tem problemas:` |
| 不能为空 | `não pode ficar vazio` |
| 只能用小写字母、数字和 - | `só pode usar letras minúsculas, números e -` |
| `{onde}要是一个对象` | `{onde} deve ser um objeto` |
| `{onde}要是一个列表` | `{onde} deve ser uma lista` |
| `{onde}缺少 {campo}` | `{onde} está faltando {campo}` |
| `{onde}的 {campo} {problema}` | `{onde}: o campo {campo} {problema}` |
| `{onde}有不认识的字段 {campo}` | `{onde} tem o campo desconhecido {campo}` |
| `规则名「{n}」重复了` | `o nome de regra "{n}" está duplicado` |
| `规则「{n}」` (prefixo de local) | `a regra "{n}"` |
| `{onde}的 when ` | `o when de {onde} ` |
| `{onde}的 emits ` | `o emits de {onde} ` |
| 不是已登记的 Agent：{x} | `não é um Agent registrado: {x}` |
| 不是已登记的 Agent | `não é um Agent registrado` |
| 不是已登记的来源：{x} | `não é uma fonte registrada: {x}` |
| 不是已登记的来源 | `não é uma fonte registrada` |
| 要是绝对目录（如 ~/code、/srv/app、C:\\code 或 \\\\服务器\\共享目录） | `deve ser um diretório absoluto (por exemplo ~/code, /srv/app, C:\code ou \\servidor\compartilhamento)` |
| 要是字母或数字开头、不含空白的一个词，占位符只能用 {id}、{subject} | `deve ser uma palavra só, começando com letra ou número e sem espaços; os únicos placeholders permitidos são {id} e {subject}` |
| 要是正整数 | `deve ser um inteiro positivo` |
| 要是正整数（分钟） | `deve ser um inteiro positivo (minutos)` |
| 只能是 true 或 false | `só pode ser true ou false` |
| 只能是 {lista} | `só pode ser {lista}` (itens separados por `, `) |
| 要是通道编号的列表 | `deve ser uma lista de identificadores de canal` |
| 要是命令行的列表 | `deve ser uma lista de linha de comando` |
| 要是一个程序的路径 | `deve ser o caminho de um programa` |
| 要是文字的列表 | `deve ser uma lista de textos` |
| 要是事件类型的列表，可以用 x.* 或 * | `deve ser uma lista de tipos de evento; pode usar x.* ou *` |
| 要是事件类型的列表 | `deve ser uma lista de tipos de evento` |
| 不是有效的 cron | `não é um cron válido` |
| 不是有效的时区 | `não é um fuso horário válido` |
| `{onde}的定时永远不会到来：{cron}` | `o agendamento de {onde} nunca vai chegar: {cron}` |
| `{onde}的 skill 和 prompt 至少写一个` | `{onde} precisa de pelo menos um entre skill e prompt` |
| `{onde}的 channels 不是已登记的通道：{c}` | `o channels de {onde} não é um canal registrado: {c}` |
| `rules.json 的 defaultChannels 不是已登记的通道：{c}` | `o defaultChannels do rules.json não é um canal registrado: {c}` |
| `来源 {id} 是保留的，定时用规则的 cron` | `a fonte {id} é reservada; para agendamento use o cron da regra` |
| `来源的编号{regra}：{id}` | `o identificador da fonte {regra}: {id}` |
| `来源 {id} ` (prefixo de local) | `a fonte {id} ` |
| `通道的编号{regra}：{id}` | `o identificador do canal {regra}: {id}` |
| `通道 {id} ` (prefixo de local) | `o canal {id} ` |
| `Agent 的编号{regra}：{id}` | `o identificador do Agent {regra}: {id}` |
| `Agent {id} ` (prefixo de local) | `o Agent {id} ` |
| `组「{g}」里的规则 parallel 要一致` | `as regras do grupo "{g}" precisam ter o mesmo parallel` |
| `定时任务「{n}」和别的规则或定时任务重名` | `a tarefa agendada "{n}" tem o mesmo nome de outra regra ou tarefa agendada` |
| `定时任务「{n}」` (prefixo de local) | `a tarefa agendada "{n}"` |
| `定时任务「{n}」写了回答后照什么做，还要写 cwd：在哪接着做` | `a tarefa agendada "{n}" definiu o que fazer após a resposta, mas falta cwd: onde continuar` |
| `定时任务「{n}」写了 cwd，skill 和 prompt 至少写一个：回答后照什么做` | `a tarefa agendada "{n}" definiu cwd; escreva pelo menos um entre skill e prompt: o que fazer após a resposta` |
| 不是 JSON：{erro} | `não é JSON: {erro}` |

## 8. Âncoras de link

As âncoras do GitHub **preservam acentos**: `## Versão e compatibilidade` gera
`#versão-e-compatibilidade`. Ao traduzir um link com âncora, escreva o slug a partir do novo
título em minúsculas, sem pontuação, com espaços virando hífen e **mantendo os acentos**.

Não se preocupe em acertar o slug de primeira: ao final da conversão um script varre todos os
`.md`, compara cada âncora com os títulos reais do arquivo de destino e corrige o que não
bater. O importante é que o **texto do título** seja exatamente o fixado na seção 4.

## 10. Sentinelas entre módulos (CRÍTICO)

Estes literais aparecem em **mais de um diretório de código** e são comparados com `===` /
`!==` ou verificados por regex em testes. Se dois módulos traduzirem de forma diferente, a
comparação quebra em silêncio ou o teste falha. A tradução é **fixa e obrigatória**.

### Alto risco (atravessam três módulos ou mais)

| Chinês | **Português (obrigatório)** | Onde aparece |
|---|---|---|
| `已处理` | **`Resolvido`** | `kernel/decide.ts` (produz), `cli/status.ts` (compara), `plugins/webhook/channel.ts` (compara), testes |
| `本人` | **`o titular`** | `kernel/`, `scripts/`, `sim/`, testes |
| `没留下结果` | **`não deixou resultado`** | `worker/contract.ts`, `plugins/`, `examples/`, testes |
| `没说原因` | **`sem motivo informado`** | `worker/contract.ts`, `kernel/`, testes |
| `没跑成` | **`FALHOU`** | `worker/contract.ts`, testes |
| `没事可做` | **`NADA A FAZER`** | `worker/contract.ts`, `cli/`, testes |
| `做完了` | **`Concluído`** | `cli/`, `tests/helpers.ts`, testes |
| `定时` | **`agendamento`** | `protocol/rules.ts` (nome da fonte reservada), `cli/`, testes |
| `通道` | **`canal`** | `cli/`, `kernel/`, `sim/` |
| `飞书` | **`Feishu`** | `plugins/`, `examples/`, testes |
| `桌面通知` | **`notificação de desktop`** | `cli/`, `plugins/`, testes |
| `甲` / `乙` / `丙` | **`alfa` / `beta` / `gama`** | `protocol/`, `sim/`, testes |
| `意见` | **`opiniões`** | `scripts/`, testes (fixture) |
| `早报` | **`briefing matinal`** | `examples/`, testes (fixture) |

### Dois módulos

| Chinês | **Português (obrigatório)** | Onde aparece |
|---|---|---|
| `已停止` | **`Interrompida`** | `kernel/`, `worker/`, testes |
| `没有这个地址` | **`não existe esse endereço`** | `cli/`, `kernel/`, testes |
| `没有这一轮` | **`não existe essa rodada`** | `host/`, `kernel/` |
| `这个来源不收 Webhook` | **`esta fonte não aceita Webhook`** | `host/`, `kernel/` |
| `还没装好：先运行 agent-autoloop init` | **`ainda não está instalado: rode antes agent-autoloop init`** | `cli/`, `host/` |
| `不是 JSON` | **`não é JSON`** | `cli/`, `kernel/` |
| `这件事的固定名字` | **`nome fixo deste assunto`** | `cli/`, `worker/contract.ts` |
| `一句话` | **`uma frase`** | `worker/contract.ts`, testes |
| `返回 ${response.status}` | **`respondeu ${response.status}`** | `examples/`, `plugins/` |
| `越界` | **`fora dos limites`** | `protocol/`, testes |
| `已核实` | **`verificado`** | `protocol/`, `scripts/` |
| `已关闭` | **`Fechado`** | `cli/`, testes |
| `处理说明` | **`nota de tratamento`** | `kernel/`, testes |
| `改好了` | **`corrigido`** | `kernel/`, testes |
| `选一个` | **`escolha uma`** | `sim/`, testes |
| `选择` | **`escolha`** | `sim/`, testes |
| `一` / `二` / `三` | **`um` / `dois` / `três`** | `kernel/`, testes |
| `内容` | **`conteúdo`** | `sim/`, testes |
| `复查` | **`reverificação`** | `sim/`, testes |
| `来源` | **`fonte`** | `kernel/`, `sim/` |

### `agent-autoloop try` (scripts/ ↔ cli/ ↔ testes)

| Chinês | **Português (obrigatório)** |
|---|---|
| `试跑` | **`execução de teste`** |
| `试一下` | **`experimente`** |
| `试跑：选一个颜色` | **`Execução de teste: escolha uma cor`** |
| `蓝色` | **`Azul`** |
| `绿色` | **`Verde`** |
| `运行 agent-autoloop status 查看` | **`Rode agent-autoloop status para ver`** |

### Rótulos do `status` (cli/ ↔ testes)

Já fixados na seção 3: `在线` → **Online**, `正在做` → **Em andamento**, `最近几轮` →
**Rodadas recentes**, `最近的卡片` → **Cartões recentes**, `没有规则接的事件` → **Eventos sem
regra**, `本机` → **esta máquina**, `接着上一轮的会话` → **continuando a sessão da rodada
anterior**.

### Mensagens de plugin (plugins/ ↔ testes)

| Chinês | **Português (obrigatório)** |
|---|---|
| `ACP 没有返回会话编号` | **`o ACP não devolveu um identificador de sessão`** |
| `Agent 问你一个问题` | **`Um Agent fez uma pergunta a você`** |
| `Codex 没有完成并留下实际结果` | **`o Codex não concluiu nem deixou um resultado`** |
| `DSH 没有完成并留下实际结果` | **`o DSH não concluiu nem deixou um resultado`** |
| `DSH 没跑完这一轮` | **`o DSH não terminou esta rodada`** |
| `ZCode 没有完成并留下实际结果` | **`o ZCode não concluiu nem deixou um resultado`** |
| `这一轮用完了输出上限` | **`esta rodada esgotou o limite de saída`** |
| `这一轮被中止了` | **`esta rodada foi abortada`** |
| `这一轮被卡住了，没有完成` | **`esta rodada travou e não concluiu`** |
| `rules.json 写错了，还在用旧规则` | **`o rules.json está com erro; as regras antigas continuam em uso`** |
| `接单程序没连上` | **`o worker não conectou`** |
| `没跑成的一轮只能发通知` | **`uma rodada que falhou só pode enviar notificação`** |
| `不在本轮核对范围` | **`fora do escopo de verificação desta rodada`** |
| `这件活不归这个令牌` | **`este trabalho não pertence a este token`** |
| `交付标记已撤回` | **`o rótulo de entrega foi retirado`** |
| `交付退回：${reason}` | **`entrega devolvida: ${reason}`** |
| `审查发现问题，尚未合并` | **`a revisão encontrou problemas; merge ainda não feito`** |
| `没有待交付的标记` | **`não há rótulo de entrega pendente`** |
| `记录并结案` | **`Registrar e encerrar`** |
| `无法确认自动合并已关闭` | **`não foi possível confirmar que o merge automático foi encerrado`** |
| `改动已关闭或目标分支已变更，只合并到 main。` | **`a mudança foi fechada ou o branch de destino mudou; o merge é só para o main.`** |
| `合并请求已关闭，未合并或发布` | **`o pull request foi fechado; sem merge nem publicação`** |
| `没事可做：合并请求已关闭` | **`NADA A FAZER: o pull request foi fechado`** |

## 11. Regras de estilo




- **Não traduzir:** identificadores de código, nomes de arquivos, chaves JSON, nomes de
  comandos (`agent-autoloop status`), variáveis de ambiente, URLs, expressões cron, nomes de
  produtos (Claude Code, Codex, Feishu/Lark, DingTalk, WeCom, Slack, Discord, GitHub, GitLab).
- **Agent** fica com inicial maiúscula e sem plural em "s" quando usado como o conceito do
  projeto ("os Agents" é aceitável no plural).
- Pontuação chinesa `，。；：！？、（）「」“”` → pontuação brasileira `, . ; : ! ? ( ) " "`.
- Parênteses de largura total `（）` → `()`.
- Manter a estrutura Markdown idêntica: mesmos níveis de título, mesmas tabelas, mesmas
  cercas de código, mesmas tags `<details>`.
- Blocos de código com JSON/exemplos: traduzir apenas os **valores textuais** que são prosa
  (ex.: `"name": "早报"` → `"name": "Briefing matinal"`), nunca chaves.
- Números, tabelas de benchmark e unidades: manter os valores; traduzir unidades
  (`条/秒` → `eventos/s`, `毫秒` → `ms`).
- Comentários de código: traduzir para pt-BR, mantendo o princípio do projeto de explicar
  apenas o *porquê* que o código não mostra.
