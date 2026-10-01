# jobcan-agent

[English](README.md) | [日本語](README.ja.md) | **Português**

> **Projeto não oficial.** Sem qualquer vínculo com a DONUTS Co., Ltd., fornecedora do Jobcan.

Permite que um agente de IA (Claude, ChatGPT, ...) opere o Jobcan 勤怠管理: solicitar folgas,
consultar saldos, preencher o ponto e manter o canal da equipe e a sua agenda em dia. Toda escrita
é mostrada antes como um plano e só é enviada quando você confirma.

- **Servidor MCP** (`packages/mcp`): fala com o Jobcan, por HTTP comum, e devolve dados estruturados.
- **Skills** (`skills/`): combinam o MCP com os conectores que o seu agente tiver (Slack ou Teams,
  Google Agenda ou Outlook), seguindo as regras da sua empresa.
- **Preset** (`preset.example.md`): onde ficam essas regras e os seus padrões. O seu preset real fica
  em `~/.config/jobcan-agent/preset.md` e nunca vai para o repositório.

## Regras de segurança

- Toda escrita é uma simulação até `confirm=true`, e você vê o plano antes de confirmar.
- O cliente HTTP só alcança uma lista fixa de páginas do Jobcan, em qualquer modo.
- Credenciais ficam no chaveiro do sistema. Nunca passam pelo chat nem pelo modelo.
- Nada específico de empresa é commitado neste repositório.

## Os termos do Jobcan

Os termos de uso do Jobcan são um contrato entre o Jobcan e a sua empresa, não com você
pessoalmente. Eles não mencionam automação nem scripts, mas proíbem analisar o serviço e qualquer
coisa que possa atrapalhar a operação dele ([termos básicos](https://all.jobcan.ne.jp/terms/),
artigo 9). Esta ferramenta entra como você, lê as mesmas páginas que o seu navegador e espaça as
requisições. Se isso é aceitável, cabe a você e a quem administra o Jobcan na sua empresa decidir.
Pergunte antes.

## Estado

Em desenvolvimento inicial, verificado no Jobcan de uma empresa. Veja [O que já foi testado](#o-que-já-foi-testado)
e [O que ainda não foi testado](#o-que-ainda-não-foi-testado).

## Início rápido

Requisitos: macOS (as credenciais são lidas do Keychain), Node.js 20 ou mais recente e uma conta
Jobcan que entre com e-mail e senha. SSO e verificação em duas etapas são detectados e param com
uma mensagem; ainda não têm suporte.

```bash
git clone https://github.com/clins1994/jobcan-agent.git
cd jobcan-agent
npm install && npm run build
security add-generic-password -s jobcan-mcp -a voce@exemplo.com -w   # pede a sua senha
npm run verify -w packages/mcp                                        # checagem só de leitura no Jobcan
```

Registre o servidor no seu agente. Escritas ficam desligadas a menos que você as ligue:

```bash
claude mcp add jobcan -- node "$PWD/packages/mcp/dist/index.js"                              # só leitura
claude mcp add jobcan -e JOBCAN_ALLOW_WRITES=1 -- node "$PWD/packages/mcp/dist/index.js"     # escritas permitidas
```

No Claude Desktop, adicione `{"command": "node", "args": ["<repo>/packages/mcp/dist/index.js"],
"env": {"JOBCAN_ALLOW_WRITES": "1"}}` em `mcpServers.jobcan`.

Experimente: "qual é o meu saldo de férias", depois "planeje uma folga na próxima sexta", e confirme.

Isso basta para as ferramentas do Jobcan. Para as skills, que acrescentam as etapas de chat e agenda:

1. Copie [`preset.example.md`](preset.example.md) para `~/.config/jobcan-agent/preset.md` e
   preencha com o seu canal, as regras dele e o seu dia habitual.
2. Deixe as skills visíveis para o seu agente. No Claude Code, faça um link ou copie para
   `~/.claude/skills/`:

   ```bash
   for s in skills/*/; do ln -s "$PWD/$s" ~/.claude/skills/; done
   ```

3. Ative no agente os conectores que o seu preset usa (Slack ou Teams, Google Agenda ou Outlook).
   Um conector ausente pula aquela etapa; nunca bloqueia a solicitação no Jobcan.

Depois, numa sessão nova: "quero folga na próxima sexta" ou "preencha o mês passado".

## O que já foi testado

Tudo isto foi executado pelo autor contra o Jobcan real de uma empresa, na sessão em que o agente foi
construído. Funcionou de ponta a ponta ao menos uma vez; não está provado para toda configuração.

- Login com e-mail e senha; a sessão salva é reutilizada; um segundo login não derruba uma sessão
  aberta no navegador.
- Leituras: calendário (inclusive meses futuros), tipos de folga, saldos, solicitações, folha de
  ponto e descoberta do formulário de folga (campos, se o motivo é obrigatório, seletores de hora).
- Folgas: dias inteiros e folga por horas (meio dia de 4 horas), datas passadas, motivo reaproveitado
  do histórico quando não informado, retirada de uma solicitação pendente e troca de uma solicitação
  por horas pendente por um dia inteiro.
- Ponto: um mês inteiro de entradas e saídas (15 dias, 30 registros), contornando folgas por horas.
  Uma segunda execução não registra nada em dobro enquanto a primeira aguarda aprovação.
- A skill `jobcan-request-leave`, conduzida passo a passo: solicitar; postar no canal conforme as
  regras dele e reagir; criar o evento de ausência. O procedimento de fim de mês que virou
  `jobcan-backfill`, conduzido do mesmo jeito: conciliar o canal, a agenda e o Jobcan; solicitar as
  folgas que faltavam; preencher o ponto.
- 427 testes unitários contra fakes do cliente e das páginas do Jobcan, e `npm run verify` contra o
  sistema real.

## O que ainda não foi testado

- **Configuração por alguém que não é engenheiro**: entregar o link do repositório a um agente e
  pedir para ser configurado, sem ajuda do autor.
- **Uma sessão nova** com o servidor registrado e as skills linkadas: chamar uma skill pelo nome,
  ou apenas dizer "quero folga na próxima sexta" ou "preencha o mês passado". Até aqui o autor
  conduziu as skills à mão, e `jobcan-backfill` nunca rodou como skill.
- **`jobcan-setup`**, o construtor interativo de preset. Ainda não existe; presets são escritos à
  mão. Deve perguntar sobre o seu fluxo (só chat, só agenda, chat primeiro e Jobcan depois, o seu
  horário habitual) e escrever o preset por você.
- **Outros fluxos**: só agenda, só chat, chat primeiro; Teams e Outlook (há notas de referência,
  nunca executadas).
- **Jobcan de outras empresas**: tipos de meio período, 代休 e 振休, campos obrigatórios extras no
  formulário, motivo opcional, SSO, verificação em duas etapas.
- **Depois da aprovação**: como registros e folgas aprovados aparecem na folha, e se o saldo do
  Jobcan já desconta solicitações pendentes (assume-se que não; a ferramenta só pode subestimar o
  disponível).
- **Ausência repentina**: postar primeiro e solicitar no Jobcan dentro do prazo da empresa.
- Pacote MCPB para instalação com um clique no Claude Desktop, transporte remoto, ChatGPT, avaliações,
  um teste noturno só de leitura.

## Contribuindo

Testar no seu próprio Jobcan é a contribuição mais útil agora.

- **Abra uma issue** para qualquer coisa que falhe, faça uma pergunta que não deveria, ou leia uma
  página errado. A saída de `npm run verify` e o plano que a ferramenta mostrou são a melhor evidência.
- **Abra um pull request** para correções e casos novos. Diga como testou, no Jobcan real ou contra
  os fakes, e o que aconteceu.
- **Deixe dados da empresa de fora** de issues, pull requests e fixtures: nada de nomes de empresa,
  canais, pessoas, ids do Slack, nomes de tipos de folga ou capturas de tela com nomes. Descreva a
  forma do que viu em vez disso.

## Desenvolvimento

```bash
npm test                          # testes unitários, sem rede
npm run typecheck -w packages/mcp
```

[`packages/mcp/README.md`](packages/mcp/README.md) lista as ferramentas e variáveis de ambiente.
[`AGENTS.md`](AGENTS.md) é para agentes trabalhando no código.

## Inspiração

- [m13/calendar2jobcan](https://github.com/m13/calendar2jobcan): sincroniza o Jobcan a partir do Google
  Agenda ou de um CSV. A ideia de preencher o ponto com o que a agenda já sabe vem de lá.
- [clins1994/raycast-jobcan](https://github.com/clins1994/raycast-jobcan): a extensão Raycast inacabada do autor para o
  Jobcan. As gravações do fluxo de login e dos endpoints que ela guardava foram o ponto de partida do
  cliente HTTP.

## Licença

MIT
