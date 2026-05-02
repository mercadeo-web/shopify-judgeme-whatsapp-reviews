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
const DEFAULT_COUNTRY_CODE = String(env.DEFAULT_COUNTRY_CODE || "507").replace(/\D/g, "");

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

    if (req.method === "POST" && req.url === "/webhooks/shopify/orders-fulfilled") {
      const rawBody = await readRawBody(req);
      if (!isValidShopifyWebhook(req, rawBody)) {
        return json(res, 401, { error: "Invalid Shopify webhook signature" });
      }

      const order = JSON.parse(rawBody.toString("utf8"));
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
      const result = await sendWhatsAppReviewRequest(task);
      task.status = "sent";
      task.sent_at = new Date().toISOString();
      task.whatsapp_response = result;
      console.log("Sent WhatsApp review request", {
        order_id: task.order_id,
        to: maskPhone(task.to)
      });
    } catch (error) {
      task.status = "failed";
      task.failed_at = new Date().toISOString();
      task.error = error.message;
      console.error("Failed WhatsApp review request", {
        order_id: task.order_id,
        to: maskPhone(task.to),
        error: error.message
      });
    }

    changed = true;
  }

  if (changed) await saveQueue(queue);
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

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}
