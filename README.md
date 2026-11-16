# Agent Autoloop

**Deixe seus Agents de linha de comando pegarem trabalho sozinhos em segundo plano e o acompanharem até o fim; no dia a dia não incomodam você e só enviam um cartão pedindo sua decisão quando encontram algo incerto.**

[Primeiros passos](#primeiros-passos) · [Receitas](#receitas-prontas-para-usar) · [Plugins](#sistema-de-plugins-os-quatro-lados-são-substituíveis) · [Kernel](#os-quatro-mecanismos-do-kernel) · [Documentação](#mais-documentação)

![Diagrama de arquitetura](docs/architecture.svg)

## Que problema ele resolve?

No dia a dia, usamos Agents de linha de comando como Claude Code e Codex quase sempre "com uma pessoa grudada no terminal": você digita uma frase, fica olhando rodar e espera ele perguntar o próximo passo. Se fechar a janela ou se afastar, o trabalho para.

**Agent Autoloop** é uma central de automação extremamente leve. Ele transforma o agendamento de tarefas em um **kernel** sem nenhuma dependência externa e separa as fontes de eventos, os Agents, os canais de notificação e até o pipeline de entrega de código em **plugins** que podem ser trocados a qualquer momento.

- **Um computador e um comando bastam.** Instala no seu Windows, Mac ou Linux, sem comprar servidor em nuvem e sem abrir porta pública.
- **Uma linha de configuração conecta um Agent novo.** Sem SDK e sem alterar o código-fonte do Agent: serve qualquer ferramenta de linha de comando que receba um prompt e imprima a última resposta.
- **Não há painel web.** Quando precisa da sua decisão, ele envia um cartão para Feishu, DingTalk, WeCom, Slack, Discord ou como notificação de desktop; para ver o andamento geral, digite um comando.

## Primeiros passos

Funciona em Windows, macOS e Linux. Você precisa de Node 24 ou mais novo, Git e um Agent de linha de comando já autenticado; macOS/Linux também precisam de curl. Não é necessária uma conta no GitHub. Você também pode entregar as [instruções de instalação](INSTALL.md) ao seu Agent.

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/josesilva05/agent-autoloop-br/main/install.ps1 | iex
```

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/josesilva05/agent-autoloop-br/main/install.sh | sh
```

Tanto a instalação quanto `agent-autoloop update` instalam o [Release](https://github.com/josesilva05/agent-autoloop-br/releases) mais recente, que é a versão aprovada em todas as verificações.

Depois de instalar, percorra um ciclo real com o Agent da sua máquina: "pergunta → sai e espera a resposta → você decide → ele termina o trabalho":

```bash
agent-autoloop try
```

A seguir, a saída real no terminal:

```text
Evento enviado, o Agent começou a trabalhar...

O Agent terminou esta rodada e fez uma pergunta a você. Agora ele não ocupa processo nem gasta tokens.

[AGUARDANDO SUA DECISÃO] #1 Execução de teste: escolha uma cor
Esta é uma execução de teste, qualquer opção serve.
  1. Azul
  2. Verde
Resposta: agent-autoloop answer 1 <número>
Depois de responder, rode agent-autoloop status para ver que ele seguiu e terminou o trabalho.
```

Em um terminal interativo, digite o número e pressione Enter; em um terminal não interativo, rode `agent-autoloop answer 1 2` para escolher "verde". Rodando `agent-autoloop status` de novo, você vê que ele retomou a conversa anterior e mostra "você escolheu verde, execução de teste aprovada", além do número de rodadas, dos tokens e dos custos de hoje e dos últimos 7 dias ([critério de contagem](skills/agent-autoloop/SKILL.md#acompanhar-e-responder)).

## Como uma tarefa flui

Os números correspondem um a um ao diagrama de arquitetura acima:

1. **Chega um evento novo.** A tarefa agendada das 9h, um Issue recém-aberto no GitHub ou um erro reportado pelo sistema de negócio viram um evento padrão enviado ao kernel.
2. **Despacho segundo as regras.** O kernel segue as regras que você escreveu para decidir qual Agent assume e em qual diretório trabalha. Mensagens que chegam para o mesmo assunto enquanto ele está na fila são agrupadas em uma única rodada.
3. **Terminou a rodada, saiu.** O Agent escreve o resultado na última resposta e o processo encerra direto.
4. **Só pergunta quando não tem certeza.** Diante de coisas como apagar dados, reiniciar serviço, gastar dinheiro ou enviar mensagem para fora, o kernel manda um cartão para você pelo Feishu ou por notificação de desktop. Enquanto espera sua resposta, ele não ocupa processo em segundo plano nem consome tokens.
5. **Um clique e ele continua.** Depois que você escolhe, ele retoma a conversa original e termina o resto do trabalho.

O que ele consegue resolver sozinho segue o ciclo automático na parte de cima do diagrama: resolve na hora ou marca um horário (por exemplo, meia hora depois) para acordar e fazer uma reverificação, sem incomodar você em momento algum.

## Como configurar no dia a dia?

### Escrever uma regra (`rules.json`)

Não é preciso escrever código de cola. Abra `~/.agent-autoloop/rules.json` e declare em `rules` **o que aconteceu, quem assume e em qual diretório trabalha**. Em `to` vá um nome que já exista em `agents`. Por exemplo, escrever o briefing matinal todo dia às 9h:

```json
{
  "name": "Briefing matinal",
  "when": { "cron": "0 9 * * *" },
  "to": "codex",
  "cwd": "~/notes",
  "prompt": "Organize as notas e os commits de ontem e escreva o briefing de hoje."
}
```

Eventos externos funcionam do mesmo jeito, só que antes é preciso conectar a fonte. Por exemplo, para entregar Issues novos ao Codex, primeiro registre `github` em `sources` conforme a [instrução](skills/agent-autoloop/SKILL.md#conectar-um-plugin-de-eventos):

```json
{
  "name": "Tratar issue",
  "when": { "source": "github", "types": ["issues.opened"] },
  "to": "codex",
  "cwd": "~/code/app",
  "skill": "handle-issue",
  "parallel": 3
}
```

`agent-autoloop pause <regra>` e `resume <regra>` pausam e retomam uma regra. Durante a pausa ela não roda no horário agendado, não aceita eventos e não os coloca na fila, e a retomada não reexecuta nada sozinha; ao retomar, ela lista os eventos pulados durante a pausa e você usa o `agent-autoloop replay <regra> --since <tempo>` indicado para reexecutá-los de uma vez, cada um apenas uma vez. `agent-autoloop run <regra>` roda uma rodada imediatamente. Tudo isso fica no log da central e não altera o `rules.json`. `agent-autoloop runs [regra]` lista as rodadas concluídas, `--before <nº da rodada>` pagina para trás e, com o número em mãos, `agent-autoloop why <nº da rodada>` mostra todo o contexto.

As mudanças valem em poucos segundos após salvar. Você pode rodar `agent-autoloop check` para verificar, `agent-autoloop check <arquivo>` para verificar um rascunho sem tocar na central em execução, `agent-autoloop rules explain [arquivo]` para ver as regras em vigor e o próximo agendamento (também aceita um rascunho) e `agent-autoloop emit <tipo> --dry-run` para ensaiar para quem um evento seria despachado (sem conectar na central e sem gravar log). Mesmo que você erre a edição, ou que o arquivo seja apagado ou não possa ser lido, o sistema continua rodando com as regras antigas e manda um cartão avisando.

### Como o Agent se comunica com a central?

A central só pede uma coisa ao Agent: **informe o resultado na última resposta**. Se o trabalho foi feito, basta imprimir uma frase de conclusão. Quando precisar consultar você, ele anexa no fim da resposta um bloco de código `agent-autoloop`:

````text
A conferência dos pedidos foi concluída e o estoque é suficiente.

```agent-autoloop
{
  "ask": [{
    "title": "Como enviar?",
    "text": "As duas opções podem ser despachadas hoje.",
    "options": ["Transportadora", "Retirada"],
    "key": "shipping"
  }]
}
```
````

Além de perguntar (`ask`), ele pode enviar notificações (`notice`), fechar cartões já resolvidos (`resolve`), agendar reverificações (`later`) e disparar novos eventos (`events`). Um aviso não exige resposta, mas ao encerrá-lo você pode escrever de passagem uma nota de tratamento, que fica registrada no cartão; um aviso marcado como `fyi` serve apenas para informar e não traz botões. Se o JSON sair errado, a central só pede que ele reescreva esse trecho final na mesma sessão, sem refazer o trabalho de negócio já concluído; se a reescrita também falhar, ela mantém a conclusão original e avisa você de que o recibo não teve efeito (comandos genéricos não têm sessão, então vão direto para essa etapa). Continuar na sessão antiga funciona igual: só abre uma sessão nova quando não dá para retomar a anterior; se retomou e parou no meio, conta como falha e, alguns minutos depois, volta à sessão original para tentar de novo, sem abrir sessão nova para refazer. Um evento novo do mesmo assunto abre por padrão uma sessão nova; com `"resume": true` na regra, ele continua na sessão da rodada anterior.

## Receitas prontas para usar

Cada receita traz regras de exemplo e instruções de ativação.

| O que você quer fazer | Fluxo já encapsulado |
|---|---|
| [Briefing diário](examples/recipes/morning-brief/README.md) | Por padrão, às 8h, organiza as notas locais e os commits do Git e grava em `briefs/YYYY-MM-DD.md` |
| [Acompanhar Issues do GitHub](examples/recipes/github-issues/README.md) | Verifica Issues novos a cada 5 minutos, altera o código localmente e avisa você para revisar; não faz commit, não dá push e não responde no Issue |
| [Investigar alertas de produção](examples/recipes/ops-alerts/README.md) | Recebe o erro, compara com o código para achar a causa e, quando é preciso reiniciar, manda um cartão perguntando; continua depois da resposta |
| [Tratar feedback de usuários](examples/recipes/feedback/README.md) | Relê o estado atual do feedback, corrige, entrega, verifica e prepara a resposta; pergunta a você no Feishu quando precisa de decisão e continua após a resposta |
| [Monitorar site](examples/recipes/website-watch/README.md) | Checa status e conteúdo essencial a cada 5 minutos; a primeira anomalia vai para o Agent, anomalias persistentes não geram aviso repetido e, na recuperação, o cartão original é atualizado |
| [Resumo semanal e de negócios no Feishu](examples/recipes/feishu-brief/README.md) | Domingo às 18h, lê os relatórios e as planilhas indicadas com as suas permissões e gera um resumo local; só um resumo curto vai para o Feishu, o texto completo fica na máquina |
| [Triagem da caixa de entrada](examples/recipes/inbox-triage/README.md) | Por padrão, às 8h, lê os e-mails não lidos das últimas 24 horas e escreve uma lista com rascunhos de resposta; não envia e não altera o estado da caixa |
| [Entrega automática de PR](skills/agent-autoloop/SKILL.md#pipeline-de-entrega) | Depois de aplicar o rótulo `deliver`, revisa, espera o CI, faz o merge, aguarda a publicação e confere a versão em produção |

**Para ativar:** abra a instrução correspondente. Quando a receita trouxer um Skill de tarefa, coloque-o no diretório de skills do Agent usado. Mescle as regras de exemplo em `~/.agent-autoloop/rules.json`, troque nomes de máquinas e caminhos e rode `agent-autoloop check`.

Tratamento de feedback, monitoramento de site, resumo no Feishu e triagem da caixa de entrada usam por padrão o fuso America/Sao_Paulo e enviam apenas para o chat privado do titular no Feishu. Os dados de exemplo são fictícios; os scripts e os recibos foram verificados apenas com HTTP local e uma CLI falsa do Feishu, nunca executados de ponta a ponta em uma conta real.

Mais receitas: [Claude delegando ao Codex o trabalho na web](examples/recipes/browser-handoff/README.md) e [limpeza semanal de código](examples/skills/weekly-sweep/SKILL.md).

## Sistema de plugins: os quatro lados são substituíveis

Os plugins embutidos vêm com o programa e são ativados preenchendo a configuração; plugins de terceiros são instalados com `agent-autoloop add <endereço git>`.

| Lado | Embutidos | Configuração |
|---|---|---|
| **Eventos**: como descobrir trabalho novo | [Webhook do GitHub](plugins/github/source.ts), [Webhook do GitLab](plugins/gitlab/source.ts), [Interface HTTP](docs/protocol.md#fontes-transformar-o-mundo-em-eventos), [Regras de agendamento](skills/agent-autoloop/SKILL.md#editar-regras), [Script de polling de Issues](examples/watch-github-issues.sh) | [Instrução](skills/agent-autoloop/SKILL.md#conectar-um-plugin-de-eventos) |
| **Agents**: quem faz o trabalho | [Claude Code](plugins/claude/agent.ts), [Codex](plugins/codex/agent.ts), [ACP](plugins/acp/agent.ts), [DeepSeek Harness](plugins/dsh/agent.ts), [ZCode](plugins/zcode/agent.ts), [Comando genérico](plugins/command/agent.ts) | [Instrução](skills/agent-autoloop/SKILL.md#conectar-um-agent) |
| **Canais**: onde procurar você para decidir | [Notificação de desktop](plugins/desktop/channel.ts) (ativada por padrão), [Feishu](plugins/feishu/channel.ts), [DingTalk / WeCom / Slack / Discord](plugins/webhook/templates.ts) | [Instrução](skills/agent-autoloop/SKILL.md#conectar-um-canal) |
| **Entrega**: CI/CD também como plugin | [`delivery`](plugins/delivery/delivery.ts) | [Instrução](skills/agent-autoloop/SKILL.md#pipeline-de-entrega) |

**O que foi testado de fato:** Claude Code, Codex e ACP (adaptador ACP oficial do Codex) passaram por várias rodadas de perguntas e respostas e por retomada de sessão entre processos; o ZCode passou por pergunta, resposta e retomada da sessão original; o Feishu passou por envio, callback de botões e atualização de cartão; os quatro modelos de Webhook foram verificados apenas contra serviços simulados localmente, e o Webhook do GitLab foi testado no formato da documentação oficial, sem conexão com um GitLab real. Esses canais de texto decidem por um link de resposta, então `hub.publicUrl` precisa ser um endereço acessível pelo seu celular ou computador.

**Agents embutidos passando por um gateway de terceiros.** Se Claude Code ou Codex precisam usar um serviço de modelo de terceiros, ou se é preciso definir variáveis de ambiente antes de iniciar, escreva um script pequeno que define as variáveis e inicia o programa e coloque no Agent `"program": "caminho/do/script"`; a retomada de sessão e a contagem de uso continuam iguais. Veja a [instrução](skills/agent-autoloop/SKILL.md#conectar-um-agent).

**Outros Agents de linha de comando entram com uma linha.** Defina `use: "command"` e passe o array de comandos; `{prompt}` é passado como argumento isolado e nunca é executado como código de shell. Os comandos abaixo foram reunidos da documentação oficial de cada um e ainda não foram testados individualmente por nós:

| Agent | Comando de conexão |
|---|---|
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.md#dsh-headless) versões antigas (o plugin embutido exige 0.2.2 ou mais novo) | `dsh --profile headless {prompt}` |
| [pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md) | `pi --print {prompt}` |
| [OpenClaw](https://docs.openclaw.ai/cli/agent) | `openclaw agent exec {prompt}` |
| [Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/cli) | `hermes chat -Q -q {prompt}` |
| [Cursor](https://cursor.com/docs/cli/reference/parameters) | `agent -p --trust {prompt}` |
| [WorkBuddy / CodeBuddy](https://www.codebuddy.ai/docs/cli/headless) | `codebuddy -p {prompt}` |

O `agent exec` do OpenClaw roda no máximo 600 segundos por padrão e, ao atingir o limite, conta como falha; para trabalhos mais longos, acrescente `--timeout <segundos>` ao comando (`0` significa sem limite).

Agents que falam ACP conectam com `use: "acp"` e ainda conseguem continuar na sessão original: para o [Gemini CLI](https://geminicli.com/docs/cli/acp-mode/) escreva `"command": ["gemini", "--acp"]`, e para o [OpenCode](https://opencode.ai/docs/acp) escreva `"command": ["opencode", "acp"]`. Esses dois já passaram pelo handshake ACP (Gemini CLI 0.67.0, OpenCode 1.1.2); várias rodadas de perguntas e respostas e a retomada de sessão ainda não foram testadas.

**Pipeline de entrega.** Depois de configurar as regras de entrega, ao aplicar o rótulo `deliver` em um PR do GitHub ele acompanha sozinho até ir para produção: **revisar o código → esperar o CI → fazer o merge do PR → esperar o deploy → conferir a versão em produção**. A revisão pode ser definida por Agent que escreveu o código, e vários projetos podem compartilhar uma mesma política. As configurações de revisão e entrega são lidas apenas de `main`, e o código do PR nunca é baixado nem executado na máquina que recebe o trabalho; fila, concorrência e nova tentativa reutilizam diretamente o kernel.

**Escreva seus próprios plugins.** Comece pelos três modelos mínimos e executáveis de [Agent](examples/plugins/hello-agent/agent.ts), [canal](examples/plugins/hello-channel/channel.ts) e [evento](examples/plugins/hello-source/source.ts); veja a [documentação de desenvolvimento de plugins](docs/plugins.md). Para o Agent operar páginas web, leia antes [Acesso ao navegador](docs/plugins.md#acesso-ao-navegador). A linha de comando e o [MCP](skills/agent-autoloop/SKILL.md#mcp-e-revogação-de-chaves) também permitem consultar e responder cartões.

## Os quatro mecanismos do kernel

O kernel não tem dependências de runtime. Ele não lê o relógio do sistema, não usa números aleatórios e não faz requisições para fora; os plugins é que conectam nele, e as credenciais das contas ficam em cada plugin. A mesma entrada produz sempre o mesmo resultado. Ele aplica a Agents de linha de comando quatro práticas consagradas da computação:

- **Espera de custo zero**: quando espera a sua decisão, o processo encerra direto e o estado de espera fica no banco de dados, sem deixar o Agent pendurado. Se você ficar três dias sem responder, nesses três dias não há nenhum processo de Agent rodando e nenhum token é gasto — só a central, bem leve, aguarda em segundo plano; assim que você responde, ela continua a conversa original.
- **Event sourcing**: todo estado é calculado a partir de um log somente de acréscimos; log e índices são gravados em disco na mesma transação, e só depois disso há resposta. Se o processo for morto à força, os fatos já confirmados não se perdem (queda de energia da máquina inteira não foi testada separadamente); o porquê de qualquer rodada ter rodado e qual foi o resultado se descobre com um único comando; se o formato dos dados mudar, tudo é reconstruído a partir do log, sem escrever script de migração.
- **Separação entre instrução e dados**: a ideia é a mesma da parametrização de SQL. Textos externos, como título e corpo de um Issue, entram apenas como dados em um arquivo e nunca são concatenados no prompt; no prompt vão somente tipo, número e link com caracteres validados. Qual Agent usar, em qual diretório e com quais permissões é decidido exclusivamente pelas regras da sua máquina; eventos que tragam os campos `cwd`, `agent` ou `access` são recusados de imediato.
- **Disjuntor de saltos**: a ideia é a mesma do TTL de um pacote de rede. Eventos devolvidos por um Agent podem despachar outros Agents, e a contagem de saltos só cresce — não zera nem ao passar por perguntas a humanos nem por reverificações agendadas — e o Agent não consegue alterá-la. Passando de 8 saltos, o kernel apenas registra, não despacha mais e envia um cartão avisando você.

### Verifique você mesmo

No Windows use `npm run test:windows` e `node scripts/install-smoke-windows.ts`, que executam os testes de comportamento compartilhados e as verificações nativas de processo e de instalação; os testes de shell Unix continuam rodando em Linux/macOS.

No diretório do programa, `~/.agent-autoloop/app`, rode:

| O que verificar | Comando |
|---|---|
| O contexto completo de qualquer rodada | `agent-autoloop why 1` |
| 200 mil passos simulando queda de rede, perda de pacotes, travamentos e envios duplicados, reproduzíveis com uma única semente | `node sim/random.ts 24301 200000` |
| 1000 mortes forçadas de processo sem perder nenhum registro confirmado | `node sim/crash.ts 1000 12648430` |
| Os números de desempenho abaixo | `npm run benchmark` |

```text
Rodada 1 · Demonstração
11-03 20:47:25  Versão das regras #1
11-03 20:47:25  Evento disparador: fonte local · tipo demo.start · objeto example
11-03 20:47:25  local pegou o trabalho (programa de demonstração)
11-03 20:47:25  Encerrado: demonstração concluída
```

### Desempenho medido

Apple M5 Pro, 24 GB, Node 24.21.0. Cada gravação é confirmada individualmente, com resposta só depois que a transação chega ao disco.

| Métrica | Medido |
|---|---:|
| Inicialização a frio | 88,78 ms |
| Memória em ociosidade | 59,94 MB RSS |
| 1.000 long polls simultâneos em espera | 170,49 MB RSS |
| Gravações duráveis | 2.394 eventos/s |
| Despacho p99 | 1,82 ms |
| Heartbeat retido p99 com 5.000 na fila | 1,66 ms |
| Inicialização com 1,1 milhão de fatos | 99,8 ms |
| Dependências de runtime | 0 |

Quando o histórico cresce, o resumo de estado fica mais lento e o log e os índices continuam ocupando disco; a primeira inicialização após uma mudança de formato reconstrói tudo a partir do log, o que levou 43,1 segundos para 1,1 milhão de fatos. [Dados completos e método de medição](docs/protocol.md#crescimento-do-histórico-na-prática).

## Uso e conformidade

A central chama diretamente as ferramentas de linha de comando que você já instalou e autenticou na sua máquina; ela não lê nem guarda as credenciais da sua conta. O consumo das chamadas de modelo é cobrado na sua própria conta, e cotas e escopo de uso seguem os termos de serviço de cada fornecedor de modelo.

Em cenários de automação de alta frequência, os fornecedores geralmente recomendam usar API Key (a cota da assinatura pessoal foi pensada sobretudo para a interação humana do dia a dia; veja as explicações oficiais da [Anthropic](https://code.claude.com/docs/en/legal-and-compliance) e da [OpenAI](https://learn.chatgpt.com/docs/auth)). Se você for usá-lo para prestar serviço a terceiros, use API Key. Este é um projeto open source independente, sem vínculo nem endosso dos fornecedores citados.

## Mais documentação

- [Instruções de instalação](INSTALL.md)
- [Manual de configuração de regras e do pipeline de entrega](skills/agent-autoloop/SKILL.md)
- [Como escrever plugins](docs/plugins.md)
- [Protocolo de comunicação completo](docs/protocol.md)
- [Limites de segurança](SECURITY.md)
- [Como contribuir e conversar](CONTRIBUTING.md)
- [Convenções de desenvolvimento do projeto](AGENTS.md)

<details>
<summary><strong>Estrutura do repositório</strong></summary>

| Local | O que contém |
|---|---|
| `kernel/` | Kernel: decisões, registro de fatos, projeções de estado, vencimentos, casamento de regras, comportamento das interfaces e formulários dos cartões |
| `host/` | Host: HTTP do Node, conexões de arquivo e SQLite, relógio, configuração, resumo de estado, serviços em segundo plano e carregamento de plugins |
| `protocol/` | Formatos de comunicação, JSON Schema, validação de entrada, cliente HTTP e verificações de conformidade |
| `worker/` | Worker: pegar trabalho, executar o Agent, heartbeat e parada, leitura e envio de recibos |
| `cli/`, `bin/` | Comandos do usuário e ponto de entrada, incluindo status, resposta, `why`, MCP, atualização e desinstalação |
| `plugins/` | Plugins embutidos de Agent, evento, canal e entrega |
| `examples/recipes/` | Cenários completos: regras, Skills de tarefa e instruções de ativação |
| `examples/plugins/`, `examples/skills/`, `examples/*.sh` | Modelos mínimos de plugin, manuais de tarefa independentes e exemplos em Shell |
| `skills/agent-autoloop/` | Manual oficial de configuração e operação da central, também disponibilizado ao Agent durante a instalação |
| `docs/` | Protocolo de comunicação, documentação de desenvolvimento de plugins e diagrama de arquitetura |
| `tests/`, `sim/` | Testes de comportamento do dia a dia, além de simulação, enumeração, morte forçada e verificação por mutação |
| `scripts/`, `.github/workflows/` | Verificações de desempenho e em máquina real, scripts de smoke de instalação e CI para Windows / Linux / macOS |
| Documentos da raiz e `install.sh` | README, instruções de instalação, limites de segurança, convenções de desenvolvimento, licença e script de instalação |

Para ler o código, comece por `bin/agent-autoloop.ts` → `cli/main.ts` e depois entre em `host/`, `worker/` ou `plugins/` conforme a funcionalidade; para o design do kernel, leia primeiro o [protocolo](docs/protocol.md). Arquivos com o mesmo nome pertencem a camadas diferentes: `host/http.ts` converte a requisição do Node, enquanto `kernel/http.ts` define o comportamento da interface; `protocol/rules.ts` valida a entrada, enquanto `kernel/rules.ts` define os tipos de regra e o casamento.

</details>

[Licença MIT](LICENSE)
