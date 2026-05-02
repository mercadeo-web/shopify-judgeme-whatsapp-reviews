import crypto from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const env = loadEnv();

const PORT = Number(env.PORT || 3000);
const DATA_DIR = path.resolve("data");
const QUEUE_FILE = path.join(DATA_DIR, "queue.json");
const SEND_DELAY_DAYS = Number(env.SEND_DELAY_DAYS || 7);
const REQUIRE_FULFILLED_ITEMS = String(env.REQUIRE_FULFILLED_ITEMS || "true") === "true";
const PERSONALIZE_LINK_BY_PRODUCT = String(env.PERSONALIZE_LINK_BY_PRODUCT || "true") === "true";
const WHATSAPP_REVIEW_LINK_IN_BUTTON = String(env.WHATSAPP_REVIEW_LINK_IN_BUTTON || "false") === "true";
const WHATSAPP_WEBHOOK_VERIFY_TOKEN = env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "";
const DEFAULT_COUNTRY_CODE = String(env.DEFAULT_COUNTRY_CODE || "507").replace(/\D/g, "");
const PUBLIC_APP_URL = String(env.PUBLIC_APP_URL || "").replace(/\/$/, "");
const ABANDONED_CHECKOUT_ENABLED = String(env.ABANDONED_CHECKOUT_ENABLED || "false") === "true";
const ABANDONED_CHECKOUT_FIRST_DELAY_MINUTES = Number(env.ABANDONED_CHECKOUT_FIRST_DELAY_MINUTES || 20);
const ABANDONED_CHECKOUT_SECOND_ENABLED = String(env.ABANDONED_CHECKOUT_SECOND_ENABLED || "true") === "true";
const ABANDONED_CHECKOUT_SECOND_DELAY_HOURS = Number(env.ABANDONED_CHECKOUT_SECOND_DELAY_HOURS || 24);
const ABANDONED_CHECKOUT_TEMPLATE_NAME = env.ABANDONED_CHECKOUT_TEMPLATE_NAME || "";
const ABANDONED_CHECKOUT_SECOND_TEMPLATE_NAME = env.ABANDONED_CHECKOUT_SECOND_TEMPLATE_NAME || ABANDONED_CHECKOUT_TEMPLATE_NAME;
const ABANDONED_CHECKOUT_TEMPLATE_BODY_PARAMS = Number(env.ABANDONED_CHECKOUT_TEMPLATE_BODY_PARAMS || 1);
const ABANDONED_CHECKOUT_SECOND_TEMPLATE_BODY_PARAMS = Number(env.ABANDONED_CHECKOUT_SECOND_TEMPLATE_BODY_PARAMS || ABANDONED_CHECKOUT_TEMPLATE_BODY_PARAMS);
const ABANDONED_CHECKOUT_TEMPLATE_LANGUAGE = env.ABANDONED_CHECKOUT_TEMPLATE_LANGUAGE || env.WHATSAPP_TEMPLATE_LANGUAGE;
const ABANDONED_CHECKOUT_LINK_IN_BUTTON = String(env.ABANDONED_CHECKOUT_LINK_IN_BUTTON || "true") === "true";

const requiredEnv = [
  "SHOPIFY_WEBHOOK_SECRET",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_TEMPLATE_NAME",
  "WHATSAPP_TEMPLATE_LANGUAGE",
  "JUDGEME_REVIEW_LINK"
];

for (const key of requiredEnv) {
  if (!env[key]) {
    console.warn(`Missing ${key}. Add it to .env before going live.`);
  }
}

await ensureQueue();

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && req.url?.startsWith("/webhooks/whatsapp")) {
      return verifyWhatsAppWebhook(req, res);
    }

    if (req.method === "POST" && req.url === "/webhooks/whatsapp") {
      const rawBody = await readRawBody(req);
      const payload = JSON.parse(rawBody.toString("utf8"));
      logWhatsAppWebhook(payload);
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && req.url?.startsWith("/recover")) {
      const requestUrl = new URL(req.url, PUBLIC_APP_URL || `http://${req.headers.host}`);
      const token = requestUrl.searchParams.get("token");
      const recoveryUrl = await findRecoveryUrl(token);

      if (!recoveryUrl) {
        return json(res, 404, { error: "Recovery link not found" });
      }

      res.writeHead(302, { Location: recoveryUrl });
      return res.end();
    }

    if (req.method === "POST" && req.url === "/webhooks/shopify/orders-fulfilled") {
      const rawBody = await readRawBody(req);
      if (!isValidShopifyWebhook(req, rawBody)) {
        console.error("Rejected Shopify webhook", {
          topic: req.headers["x-shopify-topic"],
          reason: "invalid_signature",
          body_size: rawBody.length
        });
        return json(res, 401, { error: "Invalid Shopify webhook signature" });
      }

      const order = JSON.parse(rawBody.toString("utf8"));
      console.log("Received Shopify webhook", {
        topic: req.headers["x-shopify-topic"],
        order_id: order.id,
        has_phone: Boolean(
          order.shipping_address?.phone ||
            order.billing_address?.phone ||
            order.customer?.phone ||
            order.phone
        ),
        line_items: order.line_items?.length || 0,
        fulfillment_status: order.fulfillment_status
      });
      const task = buildReviewRequestTask(order);

      if (!task) {
        console.log("Skipped Shopify webhook", {
          topic: req.headers["x-shopify-topic"],
          order_id: order.id,
          reason: getSkipReason(order)
        });
        return json(res, 202, { ok: true, skipped: true });
      }

      const queue = await loadQueue();
      if (queue.tasks.some((item) => item.id === task.id)) {
        return json(res, 200, { ok: true, duplicate: true });
      }

      queue.tasks.push(task);
      await saveQueue(queue);
      console.log("Scheduled review request", {
        order_id: task.order_id,
        product_id: task.product_id,
        to: maskPhone(task.to),
        send_at: task.send_at
      });

      return json(res, 202, { ok: true, scheduled_for: task.send_at });
    }

    if (req.method === "POST" && req.url === "/webhooks/shopify/checkouts-update") {
      const rawBody = await readRawBody(req);
      if (!isValidShopifyWebhook(req, rawBody)) {
        console.error("Rejected Shopify checkout webhook", {
          topic: req.headers["x-shopify-topic"],
          reason: "invalid_signature",
          body_size: rawBody.length
        });
        return json(res, 401, { error: "Invalid Shopify webhook signature" });
      }

      const checkout = JSON.parse(rawBody.toString("utf8"));
      const result = await handleCheckoutWebhook(checkout, req.headers["x-shopify-topic"]);
      return json(res, 202, result);
    }

    return json(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: "Internal error" });
  }
});

server.listen(PORT, () => {
  console.log(`Review automation listening on http://localhost:${PORT}`);
});

setInterval(processQueue, 60_000);
processQueue().catch(console.error);

function loadEnv() {
  const values = { ...process.env };
  const envPath = path.resolve(".env");

  if (!existsSync(envPath)) return values;

  const content = readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    values[key] = value.replace(/^["']|["']$/g, "");
  }

  return values;
}

function verifyWhatsAppWebhook(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const mode = requestUrl.searchParams.get("hub.mode");
  const token = requestUrl.searchParams.get("hub.verify_token");
  const challenge = requestUrl.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end(challenge || "");
  }

  return json(res, 403, { error: "Invalid WhatsApp verify token" });
}

function logWhatsAppWebhook(payload) {
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};

      for (const status of value.statuses || []) {
        console.log("WhatsApp delivery status", {
          id: status.id,
          recipient_id: maskPhone(status.recipient_id || ""),
          status: status.status,
          timestamp: status.timestamp,
          conversation_id: status.conversation?.id,
          pricing_category: status.pricing?.category,
          errors: status.errors || []
        });
      }

      for (const message of value.messages || []) {
        console.log("WhatsApp inbound message", {
          from: maskPhone(message.from || ""),
          type: message.type,
          id: message.id
        });
      }
    }
  }
}

async function ensureQueue() {
  await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(QUEUE_FILE)) {
    await saveQueue({ tasks: [] });
  }
}

async function loadQueue() {
  return JSON.parse(await readFile(QUEUE_FILE, "utf8"));
}

async function saveQueue(queue) {
  await writeFile(QUEUE_FILE, `${JSON.stringify(queue, null, 2)}\n`);
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function isValidShopifyWebhook(req, rawBody) {
  if (!env.SHOPIFY_WEBHOOK_SECRET) return false;

  const header = req.headers["x-shopify-hmac-sha256"];
  if (!header || Array.isArray(header)) return false;

  const digest = crypto
    .createHmac("sha256", env.SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("base64");

  return timingSafeEqual(header, digest);
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function buildReviewRequestTask(order) {
  const phone = normalizePhone(
    order.shipping_address?.phone ||
      order.billing_address?.phone ||
      order.customer?.phone ||
      order.phone
  );

  if (!phone) return null;

  const fulfilledItems = (order.line_items || []).filter((item) => {
    return item.fulfillment_status === "fulfilled" || item.fulfillable_quantity === 0;
  });

  if (REQUIRE_FULFILLED_ITEMS && fulfilledItems.length === 0) return null;
  const reviewableItem = fulfilledItems[0] || order.line_items?.[0];

  const customerName =
    order.customer?.first_name ||
    order.shipping_address?.first_name ||
    order.billing_address?.first_name ||
    "gracias";

  const orderName = order.name || String(order.id);
  const sendAt = new Date(Date.now() + SEND_DELAY_DAYS * 24 * 60 * 60 * 1000);

  return {
    id: `shopify-order-${order.id}`,
    order_id: order.id,
    order_name: orderName,
    customer_name: customerName,
    to: phone,
    product_id: reviewableItem?.product_id || null,
    product_title: reviewableItem?.title || null,
    review_link: buildJudgeMeReviewLink(reviewableItem),
    send_at: sendAt.toISOString(),
    status: "pending",
    created_at: new Date().toISOString()
  };
}

async function handleCheckoutWebhook(checkout, topic) {
  console.log("Received Shopify checkout webhook", {
    topic,
    checkout_id: checkout.id,
    checkout_key: getCheckoutKey(checkout),
    has_phone: Boolean(checkout.phone || checkout.shipping_address?.phone || checkout.billing_address?.phone),
    completed_at: checkout.completed_at || null,
    total_price: checkout.total_price || checkout.total_line_items_price || null
  });

  const queue = await loadQueue();
  const checkoutKey = getCheckoutKey(checkout);
  const taskId = `shopify-checkout-${checkoutKey}-reminder-1`;
  const existing = queue.tasks.find((task) => task.id === taskId);

  if (checkout.completed_at) {
    let cancelled = 0;
    for (const task of queue.tasks) {
      if (task.type !== "abandoned_checkout") continue;
      if (task.checkout_key !== checkoutKey) continue;
      if (task.status !== "pending") continue;
      task.status = "cancelled";
      task.cancelled_at = new Date().toISOString();
      task.cancelled_reason = "checkout_completed";
      cancelled += 1;
    }
    if (cancelled > 0) await saveQueue(queue);
    return { ok: true, cancelled };
  }

  const task = buildAbandonedCheckoutTask(checkout);
  if (!task) {
    console.log("Skipped Shopify checkout webhook", {
      topic,
      checkout_id: checkout.id,
      reason: getCheckoutSkipReason(checkout)
    });
    return { ok: true, skipped: true };
  }

  if (existing && existing.status !== "pending") {
    return { ok: true, duplicate: true, status: existing.status };
  }

  if (existing) {
    Object.assign(existing, task, {
      created_at: existing.created_at,
      updated_at: new Date().toISOString()
    });
  } else {
    queue.tasks.push(task);
  }

  await saveQueue(queue);
  console.log("Scheduled abandoned checkout reminder", {
    checkout_id: checkout.id,
    to: maskPhone(task.to),
    send_at: task.send_at
  });

  return { ok: true, scheduled_for: task.send_at };
}

function buildAbandonedCheckoutTask(checkout) {
  if (!ABANDONED_CHECKOUT_ENABLED) return null;

  const phone = normalizePhone(
    checkout.phone ||
      checkout.shipping_address?.phone ||
      checkout.billing_address?.phone
  );

  if (!phone) return null;
  if (!checkout.abandoned_checkout_url) return null;

  const checkoutKey = getCheckoutKey(checkout);
  const recoveryToken = crypto.randomBytes(16).toString("hex");
  const customerName =
    checkout.shipping_address?.first_name ||
    checkout.billing_address?.first_name ||
    checkout.customer?.first_name ||
    "gracias";

  const orderValue = formatCheckoutValue(checkout);
  const sendAt = new Date(Date.now() + ABANDONED_CHECKOUT_FIRST_DELAY_MINUTES * 60 * 1000);

  return {
    id: `shopify-checkout-${checkoutKey}-reminder-1`,
    type: "abandoned_checkout",
    checkout_key: checkoutKey,
    checkout_id: checkout.id || null,
    checkout_token: checkout.token || null,
    reminder_attempt: 1,
    template_name: ABANDONED_CHECKOUT_TEMPLATE_NAME,
    body_param_count: ABANDONED_CHECKOUT_TEMPLATE_BODY_PARAMS,
    recovery_token: recoveryToken,
    recovery_url: checkout.abandoned_checkout_url,
    customer_name: customerName,
    order_value: orderValue,
    to: phone,
    send_at: sendAt.toISOString(),
    status: "pending",
    created_at: new Date().toISOString()
  };
}

function getCheckoutKey(checkout) {
  const stableValue =
    checkout.id ||
    checkout.token ||
    checkout.cart_token ||
    checkout.abandoned_checkout_url ||
    `${checkout.email || ""}:${checkout.total_price || ""}`;

  return crypto.createHash("sha256").update(String(stableValue)).digest("hex").slice(0, 24);
}

function getCheckoutSkipReason(checkout) {
  const phone = normalizePhone(
    checkout.phone ||
      checkout.shipping_address?.phone ||
      checkout.billing_address?.phone
  );

  if (!ABANDONED_CHECKOUT_ENABLED) return "abandoned_checkout_disabled";
  if (!phone) return "missing_phone";
  if (!checkout.abandoned_checkout_url) return "missing_recovery_url";
  return "unknown";
}

function formatCheckoutValue(checkout) {
  const amount = checkout.total_price || checkout.total_line_items_price || checkout.subtotal_price || "";
  const currency = checkout.presentment_currency || checkout.currency || "";
  return [currency, amount].filter(Boolean).join(" ") || "tu compra";
}

async function findRecoveryUrl(token) {
  if (!token) return "";
  const queue = await loadQueue();
  const task = queue.tasks.find((item) => {
    return item.type === "abandoned_checkout" && item.recovery_token === token;
  });

  return task?.recovery_url || "";
}

function getSkipReason(order) {
  const rawPhone =
    order.shipping_address?.phone ||
    order.billing_address?.phone ||
    order.customer?.phone ||
    order.phone;

  if (!normalizePhone(rawPhone)) return "missing_phone";

  const fulfilledItems = (order.line_items || []).filter((item) => {
    return item.fulfillment_status === "fulfilled" || item.fulfillable_quantity === 0;
  });

  if (REQUIRE_FULFILLED_ITEMS && fulfilledItems.length === 0) {
    return "no_fulfilled_line_items";
  }

  return "unknown";
}

function buildJudgeMeReviewLink(item) {
  if (!PERSONALIZE_LINK_BY_PRODUCT || !item?.product_id) {
    return env.JUDGEME_REVIEW_LINK;
  }

  try {
    const url = new URL(env.JUDGEME_REVIEW_LINK);
    url.searchParams.set("id", String(item.product_id));
    url.searchParams.set("source", url.searchParams.get("source") || "shareable-link");
    return url.toString();
  } catch {
    const separator = env.JUDGEME_REVIEW_LINK.includes("?") ? "&" : "?";
    return `${env.JUDGEME_REVIEW_LINK}${separator}id=${encodeURIComponent(item.product_id)}&source=shareable-link`;
  }
}

function normalizePhone(value) {
  if (!value) return "";
  const text = String(value).trim();
  const digits = text.replace(/\D/g, "");

  if (!digits) return "";
  if (text.startsWith("+")) return digits;

  if (DEFAULT_COUNTRY_CODE && digits.length === 8) {
    return `${DEFAULT_COUNTRY_CODE}${digits}`;
  }

  return digits;
}

function maskPhone(value) {
  if (!value) return "";
  return `${value.slice(0, 3)}****${value.slice(-2)}`;
}

async function processQueue() {
  const queue = await loadQueue();
  const now = Date.now();
  let changed = false;

  for (const task of queue.tasks) {
    if (task.status !== "pending") continue;
    if (new Date(task.send_at).getTime() > now) continue;

    try {
      const result = await sendQueuedWhatsAppMessage(task);
      task.status = "sent";
      task.sent_at = new Date().toISOString();
      task.whatsapp_response = result;
      scheduleNextAbandonedCheckoutReminder(queue, task);
      console.log("Sent WhatsApp request", {
        type: task.type || "review_request",
        order_id: task.order_id,
        checkout_id: task.checkout_id,
        to: maskPhone(task.to)
      });
    } catch (error) {
      task.status = "failed";
      task.failed_at = new Date().toISOString();
      task.error = error.message;
      console.error("Failed WhatsApp request", {
        type: task.type || "review_request",
        order_id: task.order_id,
        checkout_id: task.checkout_id,
        to: maskPhone(task.to),
        error: error.message
      });
    }

    changed = true;
  }

  if (changed) await saveQueue(queue);
}

function scheduleNextAbandonedCheckoutReminder(queue, task) {
  if (task.type !== "abandoned_checkout") return;
  if (task.reminder_attempt !== 1) return;
  if (!ABANDONED_CHECKOUT_SECOND_ENABLED) return;

  const checkoutKey = task.checkout_key || String(task.checkout_id || task.checkout_token);
  const secondTaskId = `shopify-checkout-${checkoutKey}-reminder-2`;
  if (queue.tasks.some((item) => item.id === secondTaskId)) return;

  queue.tasks.push({
    ...task,
    id: secondTaskId,
    reminder_attempt: 2,
    template_name: ABANDONED_CHECKOUT_SECOND_TEMPLATE_NAME,
    body_param_count: ABANDONED_CHECKOUT_SECOND_TEMPLATE_BODY_PARAMS,
    send_at: new Date(Date.now() + ABANDONED_CHECKOUT_SECOND_DELAY_HOURS * 60 * 60 * 1000).toISOString(),
    status: "pending",
    created_at: new Date().toISOString(),
    sent_at: undefined,
    failed_at: undefined,
    error: undefined,
    whatsapp_response: undefined
  });
}

async function sendQueuedWhatsAppMessage(task) {
  if (task.type === "abandoned_checkout") {
    return sendWhatsAppAbandonedCheckoutReminder(task);
  }

  return sendWhatsAppReviewRequest(task);
}

async function sendWhatsAppReviewRequest(task) {
  const graphVersion = env.WHATSAPP_GRAPH_VERSION || "v24.0";
  const url = `https://graph.facebook.com/${graphVersion}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: task.to,
    type: "template",
    template: {
      name: env.WHATSAPP_TEMPLATE_NAME,
      language: { code: env.WHATSAPP_TEMPLATE_LANGUAGE },
      components: buildWhatsAppTemplateComponents(task)
    }
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`WhatsApp API error ${response.status}: ${JSON.stringify(body)}`);
  }

  return body;
}

async function sendWhatsAppAbandonedCheckoutReminder(task) {
  const graphVersion = env.WHATSAPP_GRAPH_VERSION || "v24.0";
  const url = `https://graph.facebook.com/${graphVersion}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: task.to,
    type: "template",
    template: {
      name: task.template_name || ABANDONED_CHECKOUT_TEMPLATE_NAME,
      language: { code: ABANDONED_CHECKOUT_TEMPLATE_LANGUAGE },
      components: buildAbandonedCheckoutTemplateComponents(task)
    }
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`WhatsApp API error ${response.status}: ${JSON.stringify(body)}`);
  }

  return body;
}

function buildWhatsAppTemplateComponents(task) {
  const productName = task.product_title || task.order_name;

  if (!WHATSAPP_REVIEW_LINK_IN_BUTTON) {
    return [
      {
        type: "body",
        parameters: [
          { type: "text", text: task.customer_name },
          { type: "text", text: productName },
          { type: "text", text: task.review_link }
        ]
      }
    ];
  }

  return [
    {
      type: "body",
      parameters: [
        { type: "text", text: task.customer_name },
        { type: "text", text: productName }
      ]
    },
    {
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [{ type: "text", text: String(task.product_id || "") }]
    }
  ];
}

function buildAbandonedCheckoutTemplateComponents(task) {
  const bodyParameters = [{ type: "text", text: task.customer_name }];
  if (Number(task.body_param_count || 1) >= 2) {
    bodyParameters.push({ type: "text", text: task.order_value });
  }

  const body = {
    type: "body",
    parameters: bodyParameters
  };

  if (!ABANDONED_CHECKOUT_LINK_IN_BUTTON) {
    const recoveryLink = `${PUBLIC_APP_URL}/recover?token=${task.recovery_token}`;
    body.parameters.push({ type: "text", text: recoveryLink });
    return [body];
  }

  return [
    body,
    {
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [{ type: "text", text: task.recovery_token }]
    }
  ];
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}
