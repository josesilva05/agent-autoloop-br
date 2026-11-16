# Inspeção de sites e investigação de anomalias

Uma máquina externa verifica o site, entrega a falha ao Agent de manutenção e encerra o caso depois da recuperação. Um script fixo roda a cada 5 minutos; quando está tudo bem, nenhum modelo é chamado; quando a anomalia continua, nada é despachado nem notificado de novo; na recuperação, o cartão original é atualizado.

## Como ativar

1. Copie este diretório para `~/.agent-autoloop/work/website-watch/`, com acesso apenas para o titular. O computador que executa o script de verificação deve ficar fora do serviço verificado, para que a inspeção não caia junto quando o servidor parar.
2. Coloque o `SKILL.md` em `~/.codex/skills/website-watch/`; no Claude Code, em `~/.claude/skills/website-watch/`.
3. Mescle os `sources`, `agents`, `channels` e `rules` do `rules.json`. Troque os dois `worker` pelo computador do worker; o `cwd` da regra de verificação aponta para o diretório do modelo copiado, e o da regra de investigação aponta para o seu diretório de código. Use o fuso `Asia/Shanghai`.
4. Altere o `site.json`: preencha o número do seu site, o nome, a URL de saúde e o texto que a resposta deve conter. O domínio de exemplo é apenas um espaço reservado e não serve como alvo de verificação. O endereço não pode ter usuário e senha, parâmetros de consulta nem fragmento; para uma interface de saúde que exige autenticação, altere antes o script de verificação conforme a convenção do seu projeto.
5. Permissão: `read`. O Agent de manutenção só lê o código local por padrão; as requisições HTTP ficam com o script de verificação fixo. Para consultar logs de produção ou executar ações já aprovadas, é preciso registrar as ferramentas existentes no manual de manutenção do main do projeto — comandos não podem vir do evento.
6. Execute `agent-autoloop check` e, numa central de teste dedicada, conecte um serviço HTTP falso local para verificar anomalia, anomalia persistente e recuperação. Não teste derrubando um site real.

## Critério de verificação

O sucesso exige ao mesmo tempo HTTP 200 e a presença do texto não vazio indicado em `contains`. Redirecionamentos não são seguidos; falha de conexão, timeout de leitura (20 segundos) ou conteúdo divergente contam como anomalia, e o corpo da resposta não é impresso. Este exemplo relata já na primeira falha; ele não herda a contagem de "três vezes seguidas" do monitoramento interno, para que o modelo não precise manter mais um estado. Se o site já tiver um bom debounce de alertas, conecte os alertas dele diretamente como eventos.

As anomalias ainda não recuperadas ficam nos cartões de notificação de problema da central. O script confere apenas o cartão correspondente ao site atual; se o cartão ainda estiver aberto, nada é reenviado e, na recuperação, o caso é encerrado e um evento `site.recovered` é emitido para o Agent de manutenção conferir o que restou. **Não clique em "Resolvido" antes da hora para fechar um cartão de anomalia ainda não recuperada**: fechar à mão significa que aquele aviso foi tratado, e a próxima verificação que falhar será relatada de novo. O mesmo grupo de verificação serve apenas a este site, com um nome estável; vários sites usam fonte, nome de regra, group e número de site independentes, e o `emits.source` de cada conjunto deve corresponder somente ao `when.source` da regra de tratamento daquele site, para que alertas de outros sites não sejam despachados ao projeto errado.

Recuperação por HTTP não significa que o navegador ou todas as funções de negócio passaram. Quando for preciso o titular restabelecer a conexão com a página, o login ou uma permissão, o Agent de manutenção deixa a pendência com `ask`; esta rodada se encerra, sem reexecutar o trabalho repetidamente.

## Notificação pelo Feishu

As regras registram por padrão o canal `feishu`. Troque `ou_REPLACE_ME` pelo open_id do titular; no `channels.feishu` do `config.json` existente, configure o `user` dessa pessoa e a chave de canal já em uso. Reaproveite o canal Feishu que já está rodando, sem abrir outra escuta. Se ele ainda não estiver conectado, siga a [configuração de canais](../../../skills/agent-autoloop/SKILL.md#conectar-um-canal); quando a configuração envolver chaves ou permissões novas, obtenha antes a autorização do titular.

A leitura dos dados de negócio usa a identidade do titular; a notificação usa a identidade do bot. Por padrão envia-se apenas ao titular; uma central entrega os cartões a todos os canais que ela tem configurados, então regras com dados privados devem declarar `channels` para enviar somente ao canal de conversa privada do titular, sem se misturar com canais de grupo compartilhados. Não faça commit no repositório de chaves, open_id reais, tokens de tabela nem dados de negócio.
