#!/bin/sh
# A única coisa aqui que toca a produção. Roda fora de qualquer sandbox, como você, seja qual for o access do Agent.
# Pode rodar duas vezes: uma falha é tentada de novo, e a central promete apenas pelo menos uma vez.
set -e
echo "Este é um script de exemplo, nada foi reiniciado de verdade. Troque esta linha pelo seu comando de reinicialização e pela verificação de saúde: a primeira linha da saída é enviada a você."
