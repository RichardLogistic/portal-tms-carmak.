# Portal TMS Corporativo Carmak

Portal corporativo de logística com integração Qive, consulta de CT-es e NF-es,
rastreamento automático de transportadoras, descoberta de cobertura SSW,
integração TW e relatórios operacionais.

Este projeto já foi adaptado para **Next.js convencional**, **GitHub**,
**Claude Code** e **Vercel**. Não depende da hospedagem anterior no ChatGPT Sites.

## Enviar ao repositório GitHub

1. Extraia o arquivo ZIP recebido.
2. Abra o repositório `portal-tms-carmak` no GitHub.
3. Volte para a página principal do repositório, na aba **Code**.
4. Clique em **Add file** e depois em **Upload files**.
5. Arraste o conteúdo da pasta extraída, incluindo `app`, `public`, `tests`,
   `package.json`, `next.config.ts`, `tsconfig.json`, `CLAUDE.md` e este README.
6. Clique em **Commit changes**.

Envie o conteúdo da pasta; não envie o arquivo ZIP como único arquivo do
repositório. O README existente pode ser substituído por este.

## Continuar o desenvolvimento pelo Claude

Conecte sua conta do GitHub ao Claude Code, escolha este repositório e peça:

> Leia o arquivo CLAUDE.md, analise todo o projeto e continue desenvolvendo o
> Portal TMS Carmak sem alterar as regras operacionais existentes.

O arquivo `CLAUDE.md` contém o contexto da operação, as integrações e as regras
de rastreamento que devem ser preservadas.

## Publicar na Vercel

1. Na Vercel, selecione **Add New** e depois **Project**.
2. Conecte o GitHub e importe este repositório.
3. Mantenha o framework **Next.js**.
4. Em **Environment Variables**, configure:

```text
QIVE_API_ID
QIVE_API_KEY
QIVE_API_BASE_URL=https://api.arquivei.com.br
```

5. Configure as variáveis opcionais do `.env.example` somente quando aplicável.
6. Clique em **Deploy**.

As credenciais da Qive devem ser obtidas com o responsável pela integração e
inseridas diretamente na Vercel. Elas não acompanham este pacote.

## Desenvolvimento local

```bash
npm install
npm run dev
```

Para validar:

```bash
npm test
npm run typecheck
npm run build
```

## Segurança

Mantenha o repositório privado. Nunca salve chaves da Qive, tokens SSW ou tokens
de transportadoras no GitHub. Antes de disponibilizar dados fiscais para outras
pessoas, implemente autenticação corporativa e controle de acesso adequados.
