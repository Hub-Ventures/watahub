# UX Copy: watahub.dev (en · es · pt)

Voz del panel: simple, técnica y directa. Oraciones cortas; los valores de máquina (rutas, cabeceras, variables, ids)
van en `mono`. Español con tú (como el panel); portugués de Brasil con você. Cada hecho del sitio actual se conserva;
solo se suman los que aprobaste en PRODUCT.md. Los mensajes y números de las burbujas son datos de ejemplo y lo dicen.

## Posicionamiento (Julián, 2026-11-08)

| Elemento | en | es | pt |
|---|---|---|---|
| tagline (h1, title, og) | The hub for your WhatsApp agents | El hub de tus agentes para WhatsApp | O hub dos seus agentes para WhatsApp |
| paso 1 | Connect your line | Conecta tu línea | Conecte sua linha |
| paso 2 | Deploy your agents on your line | Despliega tus agentes en tu línea | Implante seus agentes na sua linha |
| paso 3 | That's it. | ¡Listo! | Pronto! |
| detalle 1 | Embedded Signup connects the number. The business token stays in the gateway. | Embedded Signup conecta el número. El token del negocio se queda en el gateway. | O Embedded Signup conecta o número. O token do negócio fica no gateway. |
| detalle 2 | Your agent gets every message as a signed webhook and replies with `POST /v1/messages`. | Tu agente recibe cada mensaje como un webhook firmado y responde con `POST /v1/messages`. | Seu agente recebe cada mensagem como um webhook assinado e responde com `POST /v1/messages`. |
| detalle 3 | Failed deliveries are retried, and on the hosted account a person can reply from the Inbox. | Las entregas fallidas se reintentan, y en la cuenta alojada una persona puede responder desde el Inbox. | Entregas com falha são reenviadas e, na conta hospedada, uma pessoa pode responder pelo Inbox. |
| bajada | Open-source WhatsApp Cloud API gateway for agents that work for your business: support, sales, bookings. MIT, on Cloudflare Workers or Node. | Gateway open source para la API de WhatsApp Cloud, hecho para agentes que trabajan para tu negocio: soporte, ventas, reservas. MIT, en Cloudflare Workers o Node. | Gateway open source para a API do WhatsApp Cloud, feito para agentes que trabalham para o seu negócio: suporte, vendas, reservas. MIT, no Cloudflare Workers ou Node. |
| sección enviar (h2) | Deploy your agents on your line | Despliega tus agentes en tu línea | Implante seus agentes na sua linha |
| sección enviar (bajada) | Your agent gets every inbound message as a signed webhook and replies with `POST /v1/messages`. It names the phone number id; Watahub uses the token it stored. You don't pass it. | Tu agente recibe cada mensaje entrante como un webhook firmado y responde con `POST /v1/messages`. Nombra el id del número; Watahub usa el token que guardó. Tú no lo pasas. | Seu agente recebe cada mensagem recebida como um webhook assinado e responde com `POST /v1/messages`. Ele informa o id do número; o Watahub usa o token que guardou. Você não o envia. |
| sección conectar (h2) | Connect your line | Conecta tu línea | Conecte sua linha |
| nav | Agents | Agentes | Agentes |

Este posicionamiento reemplaza el titular anterior ("Connect WhatsApp once. / The token stays in the gateway."); la
custodia del token sigue en el detalle del paso 1, en el par del hero y en el cierre. El paso 3 dice "responder"
y no "tomar la conversación": el Inbox lee, responde y asigna, pero nada detiene al agente cuando entra una persona.

## Términos fijos

| en | es | pt | Nota |
|---|---|---|---|
| business token | token del negocio | token do negócio | El token que guarda connect. En la respuesta el campo se llama `accessToken`. |
| phone number id | id del número | id do número | En código: `phoneNumberId`. |
| WABA id | id de la WABA | id da WABA | En código: `wabaId`. |
| line | línea | linha | "Conectar una línea". |
| gateway | gateway | gateway | Tu despliegue de Watahub. No se traduce. |
| delivery | entrega | entrega | Lo que Watahub reenvía a tu endpoint. |
| hosted account | cuenta alojada | conta hospedada | `app.watahub.dev`. |
| Meta app | app de Meta | app da Meta | |
| Embedded Signup | Embedded Signup | Embedded Signup | Nombre de Meta, no se traduce. |

> Bun salió del sitio: el README de `main` (#62) dice que no se prueba en Bun (CI usa Node 20 y 22). Las cabeceras
> de entrega van en minúscula, como las envía `src/services/delivery.ts`.

## Elementos clave, con alternativas

### Titular (h1)

**Elegido (Julián, 2026-11-08):** B con verbo preciso: "Connect WhatsApp once. / The token stays in the gateway."

| Opción | Copy | Tono | Mejor para |
|---|---|---|---|
| A | Paste four Meta values. Watahub keeps the business token. | Concreto | El mecanismo en nueve palabras; es el titular de hoy. |
| B | Connect WhatsApp once. The token never leaves the gateway. | Amplio | Si quieres hablar de custodia sin nombrar las variables. |
| C | Your code names a phone number id. Watahub holds the token. | Técnico | Si quieres empezar por el envío y no por la conexión. |

### Acción principal

**Recomendado:** "Source on GitHub"

| Opción | Copy | Tono | Mejor para |
|---|---|---|---|
| A | Source on GitHub | Directo | Dice qué hay y dónde; lo reconoce cualquier dev. |
| B | Get the source | Verbo | Si prefieres que empiece por verbo. |
| C | Self-host Watahub | Verbo | Si la acción debe nombrar el resultado. |

### Enlace a la cuenta alojada (bajo los botones)

**Recomendado:** "Don't want to run a Meta app? Create a hosted account"

| Opción | Copy | Tono | Mejor para |
|---|---|---|---|
| A | Don't want to run a Meta app? Create a hosted account | Útil | Nombra la razón para elegirla (tu respuesta). |
| B | Use the hosted gateway | Neutro | Más corto, sin razón. |
| C | Or open app.watahub.dev | Neutro | Si basta con el dominio. |

## Copy completo

### Cabecera y metadatos

| Elemento | en | es | pt |
|---|---|---|---|
| title | Watahub · Open-source WhatsApp Cloud API gateway | Watahub · Gateway open source para la API de WhatsApp Cloud | Watahub · Gateway open source para a API do WhatsApp Cloud |
| description | Open-source WhatsApp Cloud API gateway. Paste four Meta values and connect a line once; the business token stays in the gateway. MIT. Cloudflare Workers and Node. | Gateway open source para la API de WhatsApp Cloud. Pega cuatro valores de Meta y conecta una línea una vez; el token del negocio se queda en el gateway. MIT. Cloudflare Workers y Node. | Gateway open source para a API do WhatsApp Cloud. Cole quatro valores da Meta e conecte uma linha uma vez; o token do negócio fica no gateway. MIT. Cloudflare Workers e Node. |
| nav | Connect · Send · Events · Self-host · Hosted | Conectar · Enviar · Eventos · Autoalojar · Alojado | Conectar · Enviar · Eventos · Auto-hospedagem · Hospedado |
| idioma | English · Español · Português | ← | ← |
| skip | Skip to content | Ir al contenido | Pular para o conteúdo |

### Portada

| Elemento | en | es | pt |
|---|---|---|---|
| h1 | Connect WhatsApp once. / The token stays in the gateway. | Conecta WhatsApp una vez. / El token se queda en el gateway. | Conecte o WhatsApp uma vez. / O token fica no gateway. |
| deck | Open-source WhatsApp Cloud API gateway. Paste four Meta values, connect a line, and every send after that names a phone number id. MIT, on Cloudflare Workers or Node. | Gateway open source para la API de WhatsApp Cloud. Pegas cuatro valores de Meta, conectas una línea y desde ahí cada envío solo nombra el id del número. MIT, en Cloudflare Workers o Node. | Gateway open source para a API do WhatsApp Cloud. Você cola quatro valores da Meta, conecta uma linha e, a partir daí, cada envio só informa o id do número. MIT, no Cloudflare Workers ou Node. |
| botón 1 | Source on GitHub | Código en GitHub | Código no GitHub |
| botón 2 | Getting started | Guía de inicio | Guia de início |
| enlace | Don't want to run a Meta app? Create a hosted account | ¿No quieres tener tu propia app de Meta? Crea una cuenta alojada | Não quer manter seu próprio app da Meta? Crie uma conta hospedada |
| marca | Example data | Datos de ejemplo | Dados de exemplo |
| burbuja in | Do you ship to Medellín today? | ¿Hacen envíos a Medellín hoy? | Vocês entregam em Medellín hoje? |
| registro in | Delivered to your webhook · signed | Llega a tu webhook · firmado | Chega no seu webhook · assinado |
| burbuja out | Yes, if you order before 6 pm. | Sí, si pides antes de las 6 pm. | Sim, se pedir antes das 18h. |
| registro out | No Meta token. Watahub sends with the token it stored when you connected the line. | Sin token de Meta. Watahub envía con el token que guardó al conectar la línea. | Sem token da Meta. O Watahub envia com o token que guardou ao conectar a linha. |

### Conectar

| Elemento | en | es | pt |
|---|---|---|---|
| h2 | Connect a line once | Conecta una línea una vez | Conecte uma linha uma vez |
| deck | Four Meta values on the gateway. Once. | Cuatro valores de Meta en el gateway. Una sola vez. | Quatro valores da Meta no gateway. Uma vez só. |
| App ID | The Meta app that owns the webhook. | La app de Meta dueña del webhook. | O app da Meta dono do webhook. |
| App Secret | Exchanges the Embedded Signup code. Callers cannot send it. | Canjea el código de Embedded Signup. Quien llama no puede enviarlo. | Troca o código do Embedded Signup. Quem chama não pode enviá-lo. |
| Configuration ID | The Embedded Signup `config_id` for `FB.login`. | El `config_id` de Embedded Signup para `FB.login`. | O `config_id` do Embedded Signup para o `FB.login`. |
| API version | The Graph API version. Default `v24.0`. | La versión de Graph. Por defecto `v24.0`. | A versão da Graph API. Padrão `v24.0`. |
| lista (título) | What connect does | Qué hace connect | O que o connect faz |
| paso 1 | Exchanges the Embedded Signup code. | Canjea el código de Embedded Signup. | Troca o código do Embedded Signup. |
| paso 2 | Stores the business token for that phone number id. | Guarda el token del negocio para ese id de número. | Guarda o token do negócio para esse id de número. |
| paso 3 | Subscribes the WABA to messages. | Suscribe la WABA a los mensajes. | Inscreve a WABA nas mensagens. |
| paso 4 | Registers the phone with the 6-digit PIN. | Registra el número con el PIN de 6 dígitos. | Registra o número com o PIN de 6 dígitos. |
| petición | Send the code, the WABA id, the phone number id and the PIN. The gateway finishes the line. | Envía el código, el id de la WABA, el id del número y el PIN. El gateway termina la línea. | Envie o código, o id da WABA, o id do número e o PIN. O gateway conclui a linha. |
| `code` | From Embedded Signup | De Embedded Signup | Do Embedded Signup |
| `wabaId` | WABA id | Id de la WABA | Id da WABA |
| `phoneNumberId` | Phone number id | Id del número | Id do número |
| `pin` | 6-digit PIN | PIN de 6 dígitos | PIN de 6 dígitos |
| respuesta | No `accessToken`. The response does not include the business token. | Sin `accessToken`. La respuesta no incluye el token del negocio. | Sem `accessToken`. A resposta não inclui o token do negócio. |
| nota | `$GATEWAY` is the host where you deploy Watahub. watahub.dev is only the project page. | `$GATEWAY` es el host donde despliegas Watahub. watahub.dev es solo la página del proyecto. | `$GATEWAY` é o host onde você implanta o Watahub. watahub.dev é só a página do projeto. |

### Enviar

| Elemento | en | es | pt |
|---|---|---|---|
| h2 | Then send by phone number id | Después, envía por id de número | Depois, envie pelo id do número |
| deck | Name the phone number id. Watahub uses the token it stored. You don't pass it. | Nombra el id del número. Watahub usa el token que guardó. Tú no lo pasas. | Informe o id do número. O Watahub usa o token que guardou. Você não o envia. |
| apoyo | One endpoint for text, templates, media and interactive messages. Media uploads stream to Meta, up to 100 MB. | Un solo endpoint para texto, plantillas, media y mensajes interactivos. La media sube a Meta en streaming, hasta 100 MB. | Um só endpoint para texto, templates, mídia e mensagens interativas. A mídia sobe para a Meta em streaming, até 100 MB. |
| burbuja | Hello from Watahub | Hola desde Watahub | Olá do Watahub |
| estado | Delivered. Meta's receipt reaches your webhook as a status event. | Entregado. El acuse de Meta llega a tu webhook como evento de estado. | Entregue. O recibo da Meta chega no seu webhook como evento de status. |

### Lo que nunca tocas

| Elemento | en | es | pt |
|---|---|---|---|
| h2 | What you never touch | Lo que nunca tocas | O que você nunca toca |
| fila 1 | System user token. Connect stores a business token for each phone number id. | Token de usuario del sistema. Connect guarda un token del negocio para cada id de número. | Token de usuário do sistema. O connect guarda um token do negócio para cada id de número. |
| fila 2 | Subscribing the WABA. Connect subscribes the WABA to messages. | Suscribir la WABA. Connect suscribe la WABA a los mensajes. | Inscrever a WABA. O connect inscreve a WABA nas mensagens. |
| fila 3 | Registering the phone. Connect registers it with the 6-digit PIN. | Registrar el número. Connect lo registra con el PIN de 6 dígitos. | Registrar o número. O connect o registra com o PIN de 6 dígitos. |
| insignia | Done by connect | Lo hace connect | Feito pelo connect |

### Eventos

| Elemento | en | es | pt |
|---|---|---|---|
| h2 | Events arrive flat and signed | Los eventos llegan planos y firmados | Os eventos chegam planos e assinados |
| deck | Meta posts to `/webhook`. Watahub checks `X-Hub-Signature-256`, flattens Meta's envelope and forwards one signed delivery to your endpoint. | Meta publica en `/webhook`. Watahub verifica `X-Hub-Signature-256`, aplana el sobre de Meta y reenvía una entrega firmada a tu endpoint. | A Meta envia para `/webhook`. O Watahub verifica o `X-Hub-Signature-256`, achata o envelope da Meta e encaminha uma entrega assinada para o seu endpoint. |
| botón en burbuja | Confirm order | Confirmar pedido | Confirmar pedido |
| consejo | Check the signature with your secret and deduplicate on `x-watahub-delivery-id`. | Verifica la firma con tu secreto y deduplica por `x-watahub-delivery-id`. | Verifique a assinatura com o seu segredo e deduplique pelo `x-watahub-delivery-id`. |
| tipos 1 | Messages: text, image, audio, video, document, location, contacts, reaction, interactive. | Mensajes: … | Mensagens: … |
| tipos 2 | Echoes: replies sent from the WhatsApp Business app. | Ecos: respuestas enviadas desde la app WhatsApp Business. | Ecos: respostas enviadas pelo app WhatsApp Business. |
| tipos 3 | Statuses: sent, delivered, read, failed. | Estados: … | Status: … |

### Autoalojar

| Elemento | en | es | pt |
|---|---|---|---|
| h2 | Run it yourself | Córrelo tú mismo | Rode você mesmo |
| deck | MIT. One operator: one Meta app, one subscriber webhook, one API key, and the lines you connect. You pay Meta's fees directly, with no markup. | MIT. Un operador: una app de Meta, un webhook suscriptor, una clave API y las líneas que conectes. Pagas las tarifas de Meta directo, sin recargo. | MIT. Um operador: um app da Meta, um webhook assinante, uma chave de API e as linhas que você conectar. Você paga as tarifas da Meta direto, sem acréscimo. |
| Workers | The gateway is its own Worker. This page is not that Worker. | El gateway es su propio Worker. Esta página no es ese Worker. | O gateway é o próprio Worker. Esta página não é esse Worker. |
| Node | Same routes. `pnpm run dev:node`. | Las mismas rutas. `pnpm run dev:node`. | As mesmas rotas. `pnpm run dev:node`. |
| webhook | One subscriber webhook. Meta posts to `/webhook`; you get one signed, normalized delivery. | Un webhook suscriptor. Meta publica en `/webhook`; tú recibes una entrega firmada y normalizada. | Um webhook assinante. A Meta envia para `/webhook`; você recebe uma entrega assinada e normalizada. |
| botones | Source on GitHub · Deployment guide | Código en GitHub · Guía de despliegue | Código no GitHub · Guia de implantação |

### Cuenta alojada

| Elemento | en | es | pt |
|---|---|---|---|
| h2 | Or skip the Meta app | O sáltate la app de Meta | Ou dispense o app da Meta |
| deck | Create an account on app.watahub.dev and connect your numbers with Embedded Signup. The Meta token stays sealed in the gateway; you hold a Watahub API key you can revoke. | Crea una cuenta en app.watahub.dev y conecta tus números con Embedded Signup. El token de Meta queda sellado en el gateway; tú tienes una clave API de Watahub que puedes revocar. | Crie uma conta em app.watahub.dev e conecte seus números com o Embedded Signup. O token da Meta fica selado no gateway; você tem uma chave de API do Watahub que pode revogar. |
| 1 | Inbox: read, reply and assign conversations. | Inbox: lee, responde y asigna conversaciones. | Inbox: leia, responda e atribua conversas. |
| 2 | Webhooks per number, signed with your secret. | Webhooks por número, firmados con tu secreto. | Webhooks por número, assinados com o seu segredo. |
| 3 | Logs of API calls, Meta calls and deliveries, kept 7 days. | Logs de llamadas al API, a Meta y de entregas, guardados 7 días. | Logs de chamadas à API, à Meta e de entregas, guardados por 7 dias. |
| 4 | API keys shown once, revocable. | Claves API que se muestran una vez y se pueden revocar. | Chaves de API exibidas uma vez e revogáveis. |
| 5 | Installable on desktop and phone, with push notifications for new messages. | Se instala en escritorio y teléfono, con avisos push de mensajes nuevos. | Instalável no computador e no celular, com notificações push de novas mensagens. |
| clave única | Each key is shown only once. | Cada clave se muestra una sola vez. | Cada chave é exibida uma única vez. |
| crédito | New accounts start with a courtesy credit. | Las cuentas nuevas empiezan con un crédito de cortesía. | Contas novas começam com um crédito de cortesia. |
| botón | Create an account | Crear una cuenta | Criar uma conta |

### Cierre y pie

| Elemento | en | es | pt |
|---|---|---|---|
| h2 | The connect response has no token. | La respuesta de connect no trae el token. | A resposta do connect não traz o token. |
| texto | The next send uses the token Watahub stored. | El siguiente envío usa el token que Watahub guardó. | O próximo envio usa o token que o Watahub guardou. |
| botones | Source on GitHub · API reference | Código en GitHub · Referencia del API | Código no GitHub · Referência da API |
| pie | Watahub, by Hub Ventures. MIT license. | Watahub, de Hub Ventures. Licencia MIT. | Watahub, da Hub Ventures. Licença MIT. |

### 404

| Elemento | en | es | pt |
|---|---|---|---|
| title | Page not found · Watahub | Página no encontrada · Watahub | Página não encontrada · Watahub |
| h1 | That page isn't on watahub.dev. | Esa página no está en watahub.dev. | Essa página não está em watahub.dev. |
| texto | watahub.dev is the project page. The gateway runs on the Worker or Node process you deploy. | watahub.dev es la página del proyecto. El gateway corre en el Worker o el proceso de Node que despliegas. | watahub.dev é a página do projeto. O gateway roda no Worker ou no processo Node que você implanta. |
| botón | Go to the home page | Ir al inicio | Ir para o início |

## Por qué funciona

- El titular nombra la custodia con un verbo exacto («stays in», no «never leaves»: el core aún tiene
  `/v1/onboarding/exchange` y el token viaja a Meta en cada llamada); los cuatro valores siguen en la bajada.
- Cada sección abre con lo que hace el visitante y lo que hace el gateway, en ese orden; los pares mensaje/registro
  muestran el resultado en vez de afirmarlo.
- La cuenta alojada se ofrece con la razón concreta para elegirla (no tener una app de Meta) y queda en segundo lugar.
- No hay cifras, clientes ni precios; el crédito de cortesía va sin monto.

## Notas de localización

- El español y el portugués son ~15–25 % más largos: los botones y la navegación se diseñan con ese margen.
- No se traducen: gateway, Embedded Signup, WABA, Inbox, webhook, endpoint, los nombres de campo, rutas, cabeceras y
  variables.
- "6 pm" en es, "18h" en pt (uso local). Medellín queda igual en los tres idiomas.
- Los JSON de ejemplo llevan el mismo texto que su burbuja, en el idioma de la página.
