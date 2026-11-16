---
name: weekly-sweep
description: Limpe o código uma vez por semana: encontre e apague o código podre que entrou em merge desde a última limpeza.
---

# Limpeza semanal

Passe pelas alterações que entraram em merge desde a última limpeza, apague o que puder ser apagado, junte o que puder ser juntado e então coloque em produção.

1. **Defina o escopo**: encontre o commit da última limpeza e liste as alterações mescladas depois dele.
2. **Leia uma a uma** e pergunte:
   - O que ela desativou ou substituiu? O código antigo, os testes, as frases na documentação e a configuração foram apagados? O que foi só "desligado" ou "deixado de exibir" continua com o mecanismo de pé.
   - Ela acrescentou proteção? Locks, novas tentativas, fallbacks: há um incidente real ou documentação que os justifique? Sem isso, apague.
   - A mesma coisa está escrita duas vezes? É um remendo para um caso isolado?
   - A documentação passou a mentir por causa dela?
3. **Aja**: uma alteração por área, dizendo na descrição o que foi apagado, com que base isso pôde ser apagado e como foi verificado. Siga o fluxo normal de ida para produção.
4. **Feche**: sem nada que o usuário precise decidir, encerre em silêncio. O que depender de decisão dele (apagar uma tabela com dados, por exemplo), pergunte por cartão.
