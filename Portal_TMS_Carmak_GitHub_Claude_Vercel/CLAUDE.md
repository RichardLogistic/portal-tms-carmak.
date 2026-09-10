# Portal TMS Corporativo Carmak

## Objetivo

Manter e evoluir um portal logístico corporativo para a Carmak, integrando
documentos fiscais reais da Qive com rastreamento de transportadoras, indicadores
operacionais e relatórios. Preserve o visual verde da Carmak e os módulos já
existentes em `public/portal.html`.

O sistema atende diversas filiais e aproximadamente dez CNPJs corporativos. As
unidades incluem São Leopoldo, Sumaré, Itajaí, Chapecó, Panambi, Camaçari e
Horizontina. Nunca atribua documentos à filial errada.

## Arquitetura

- Next.js App Router convencional, compatível com Vercel.
- `/` redireciona para `/portal.html`.
- `public/portal.html` contém a interface operacional atual.
- `app/api/qive/documents/route.ts` consulta NF-es e CT-es pela Qive.
- `app/api/ssw/rastreio/route.ts` consulta ocorrências no SSW.
- `app/api/tw/rastreio/route.ts` atende a integração da TW.
- As integrações externas permanecem no servidor; nunca exponha credenciais no
  HTML, no JavaScript do navegador ou em variáveis `NEXT_PUBLIC_`.

## Variáveis de ambiente

Obrigatórias para a Qive:

```text
QIVE_API_ID
QIVE_API_KEY
QIVE_API_BASE_URL
```

Opcionais:

```text
SSW_RASTREIO_URL
SSW_API_TOKEN
TMS_SSW_CARRIERS
TW_RASTREIO_URL
TW_API_TOKEN
TMS_HFS_CNPJS
```

Na ausência de credenciais, informe a pendência de configuração claramente;
nunca invente resultados de consultas fiscais ou rastreamento.

## Regras operacionais obrigatórias

1. A central de rastreamento deve exibir todos os CT-es relacionados às filiais
   Carmak, independentemente de o frete ser pago pela empresa ou por terceiros.
2. Exclua apenas documentos da HFS no rastreamento.
3. Identifique claramente `Carmak paga`, `Terceiro paga`, `Frete de envio`,
   `Recebimento por compra` e `Transferência`.
4. Utilize período personalizado por data inicial e data final, sem limitar o
   usuário à seleção de um único mês.
5. Relacione as NF-es aos respectivos CT-es usando chaves de acesso.
6. Exiba o local real de entrega da NF-e, inclusive quando diferente do endereço
   do destinatário cadastrado.
7. Identifique pedidos pelos campos `xPed` e pelas observações da NF-e ou CT-e.
8. Liste as transportadoras realmente presentes nos CT-es retornados pela Qive.
9. Verifique automaticamente a compatibilidade SSW pela chave da NF-e vinculada.
10. Marque uma transportadora como `SSW confirmado` somente quando houver
    ocorrências reais retornadas e compatíveis com a transportadora.
11. Mantenha o rastreamento conhecido de Adonai, União e Estrela Vermelha, além
    da descoberta automática de outras transportadoras reais da operação.
12. Mantenha a TW em seu conector específico e classifique como SSW somente
    quando o serviço utilizado realmente pertencer ao SSW.
13. Nunca atribua eventos de uma transportadora a outra quando o CNPJ retornado
    permitir identificar divergência.
14. Preserve atualização automática a cada 15 minutos, cache de consultas e
    limites seguros de requisição.
15. Preserve filtros por filial, transportadora, período, situação, operação,
    responsabilidade financeira, tipo de carga e cobertura de rastreamento.
16. Diferencie máquinas completas de peças e acessórios. Garfos de empilhadeira,
    baterias, implementos e componentes não são máquinas completas.
17. Indicadores financeiros devem considerar somente CT-es pagos pela Carmak;
    indicadores operacionais devem considerar todos os documentos aplicáveis.
18. Relatórios devem ser coerentes com os CT-es e NF-es reais carregados.
19. Preserve responsividade, temas claro/escuro, filtros e identidade visual.
20. Não reintroduza dependências específicas do ChatGPT Sites, Vinext ou
    Cloudflare Workers para publicar o projeto na Vercel.
21. Antes de liberar dados fiscais a usuários externos, implemente autenticação
    corporativa e permissões adequadas.

## Validação

Execute `npm test`, `npm run typecheck` e `npm run build` antes de propor ou
publicar alterações.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
