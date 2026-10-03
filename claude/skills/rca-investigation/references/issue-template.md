# Descrição do ticket de troubleshooting

Template para o modo opcional de issue tracking do workflow RCA.

```text
Problema / Sintomas: [sintoma e serviço/ambiente afetado]

Início: [AAAA-MM-DD HH:mm + fuso horário]
Início troubleshooting: [AAAA-MM-DD HH:mm + fuso horário]
Fim:

Impacto: [impacto no negócio; âmbito afetado e consequências medidas]

Ações:
- [timestamp] [Recomendada/Executada/Rejeitada] [ação de mitigação]
  Resultado: [resultado observado ou por validar]

Root cause: Por confirmar.
[Hipótese principal, grau de confiança e evidência em falta, quando disponíveis]

Validação da resolução: Pendente.

Ações preventivas:
- [Proposta/Em curso/Concluída] [ação e critério de validação]
  Referência: [tarefa relacionada, se existir]
```

## Regras de preenchimento

- Início é o início do incidente; identificar explicitamente timestamps estimados e horas desconhecidas.
- Início troubleshooting é o momento em que o incidente foi escalado ao utilizador. Se o trabalho efetivo começou depois, acrescentar essa hora quando relevante.
- Fim fica vazio enquanto o incidente estiver por resolver. Preencher com a hora de resolução validada, não com a hora de fecho do ticket. Não inventar uma hora se só houver confirmação da recuperação sem timestamp.
- Usar timestamps com fuso horário consistente. Distinguir observações, informação reportada, inferências e desconhecidos quando isso altera a interpretação.
- Ações distingue recomendações de ações executadas e preserva os resultados observados.
- Root cause permanece Por confirmar quando a evidência não estabelece a causa. A melhoria após mitigação não prova a causa.
- Validação da resolução identifica os testes, observações e referências que sustentam a recuperação.
- Ações preventivas pode continuar pendente depois de Fim ser preenchido. Não inventar responsáveis ou prazos.
- Incluir referências de evidência junto das afirmações relevantes; evitar copiar logs extensos ou dados sensíveis para a descrição.
- Omitir placeholders opcionais sem informação. Manter os nove campos principais e Fim vazio durante o incidente.
