# Automatizacion Shopify + Judge.me + WhatsApp

Esta automatizacion envia una solicitud de resena por WhatsApp cuando Shopify avisa que un pedido fue cumplido.

## Como funciona

1. Shopify envia un webhook de pedido cumplido a `/webhooks/shopify/orders-fulfilled`.
2. La automatizacion valida la firma del webhook.
3. Guarda una tarea pendiente con la fecha de envio.
4. Al cumplirse el tiempo configurado, envia una plantilla aprobada de WhatsApp con el enlace de Judge.me.
5. Si el pedido tiene un producto de Shopify, agrega su `product_id` al enlace para abrir la resena de ese producto.
6. Guarda el estado en `data/queue.json`.

## Necesitas

- URL publica donde corra esta automatizacion, por ejemplo Render, Railway, Fly.io, VPS o ngrok para pruebas.
- Webhook secret de Shopify.
- Token de WhatsApp Cloud API de Meta.
- Phone Number ID de WhatsApp.
- Plantilla de WhatsApp aprobada.
- Enlace general de resena de Judge.me. La automatizacion lo personaliza por producto cuando Shopify envia `product_id`.

## Plantilla sugerida de WhatsApp

Nombre: `review_request`

Idioma: `es`

Body:

```text
Hola {{1}}, gracias por tu compra en El Lector.

Como te parecio {{2}}? Tu resena ayuda a otros lectores a elegir mejor.
Comparte tu experiencia aqui: {{3}}
```

La automatizacion envia estos parametros:

1. Nombre del cliente.
2. Nombre del producto/libro.
3. Enlace de Judge.me.

## Opcion con boton de WhatsApp

Para que el enlace aparezca como boton, la plantilla aprobada en Meta debe tener un boton URL dinamico.

Ejemplo de body:

```text
Hola {{1}}, gracias por tu compra en El Lector.

Como te parecio {{2}}? Tu resena ayuda a otros lectores a elegir mejor.

Solo toma un minuto.
```

Boton URL:

```text
https://judge.me/product_reviews/b6cb7ae9-022a-4c11-9e3b-0e9dfd6f4196/new?source=shareable-link&id={{1}}
```

Cuando esa plantilla este aprobada, cambia:

```env
WHATSAPP_REVIEW_LINK_IN_BUTTON=true
```

## Configuracion

1. Copia `.env.example` como `.env`.
2. Rellena los valores reales.
3. Ejecuta:

```bash
npm start
```

## Webhook en Shopify

Crea un webhook para el evento de pedido cumplido y apunta a:

```text
https://TU-DOMINIO.com/webhooks/shopify/orders-fulfilled
```

Tambien puedes usar el mismo endpoint con eventos de fulfillment si tu tienda trabaja mejor con esos disparadores.

## Nota importante

WhatsApp exige consentimiento/opt-in del cliente para mensajes iniciados por el negocio y plantillas aprobadas para conversaciones fuera de la ventana de 24 horas. Asegurate de que tu checkout o politicas recojan ese permiso.

## Carrito/pedido abandonado

La misma app puede recibir webhooks de `Checkout update` desde Shopify y enviar una plantilla de WhatsApp con un boton para recuperar la compra. El primer mensaje se agenda 20 minutos despues del abandono. Si el cliente no completa el pago, se agenda un segundo recordatorio 24 horas despues del primer mensaje.

Webhook:

```text
https://TU-DOMINIO.com/webhooks/shopify/checkouts-update
```

Plantilla sugerida:

```text
Hola {{1}},

Tu pedido de {{2}} en El Lector aun no se ha realizado.

Da clic en el boton para completar el pago y confirmar tu pedido.
```

Boton URL dinamico:

```text
https://TU-DOMINIO.com/recover?token={{1}}
```

Variables:

1. Nombre del cliente.
2. Valor del pedido.
3. Boton: token interno de recuperacion.

Variables de tiempo:

```env
ABANDONED_CHECKOUT_FIRST_DELAY_MINUTES=20
ABANDONED_CHECKOUT_SECOND_ENABLED=true
ABANDONED_CHECKOUT_SECOND_DELAY_HOURS=24
ABANDONED_CHECKOUT_SECOND_TEMPLATE_NAME=checkout_abandonado
```

Para usar un segundo mensaje mas llamativo, crea otra plantilla aprobada en Meta y pon su nombre en `ABANDONED_CHECKOUT_SECOND_TEMPLATE_NAME`.
