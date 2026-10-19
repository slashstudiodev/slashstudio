// Обработчик заявок с сайта: проверяет данные и отправляет заявку в Telegram-группу.
// Работает на стандартных Web API (Request/Response/fetch), поэтому один и тот же код
// используется в Vercel (api/lead.js) и Netlify (netlify/functions/lead.mjs).
//
// Переменные окружения (задаются в настройках хостинга, НЕ в коде сайта):
//   TELEGRAM_BOT_TOKEN — токен бота от @BotFather
//   TELEGRAM_CHAT_ID   — ID группы «Заявки с сайта» (бот пришлёт его, когда вы добавите его в группу)
//   ALLOWED_ORIGIN     — адрес сайта, например https://slash.studio (через запятую можно несколько; * — любой)

const LIMITS = { services: 200, task: 3000, deadline: 60, budget: 100, contact: 100, page: 300 };
const MIN_FILL_MS = 3000; // форму, заполненную быстрее 3 секунд, отправил робот

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function clean(value, max) {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, max);
}

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGIN || "*").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get("origin") || "";
  const allowOrigin = allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function originAllowed(request, env) {
  const allowed = (env.ALLOWED_ORIGIN || "*").split(",").map((s) => s.trim()).filter(Boolean);
  if (allowed.includes("*")) return true;
  // Браузер всегда присылает Origin при отправке формы; без него запрос шлёт скрипт, а не сайт
  const origin = request.headers.get("origin");
  return Boolean(origin) && allowed.includes(origin);
}

export function buildMessage(lead, now = new Date()) {
  const when = now.toLocaleString("ru-RU", { timeZone: "Europe/Moscow", dateStyle: "short", timeStyle: "short" });
  const lines = [
    "🌐 <b>Новая заявка с сайта</b>",
    "",
    `🧩 <b>Услуга:</b> ${escapeHtml(lead.services || "не выбрана")}`,
    `⏱ <b>Срок:</b> ${escapeHtml(lead.deadline || "—")}`,
    `💰 <b>Бюджет:</b> ${escapeHtml(lead.budget || "обсудим")}`,
    `👤 <b>Контакт:</b> ${escapeHtml(lead.contact)}`,
    "",
    "📝 <b>Задача:</b>",
    escapeHtml(lead.task),
    "",
    `🕒 ${escapeHtml(when)} (МСК)`,
  ];
  if (lead.page) lines.push(`🔗 ${escapeHtml(lead.page)}`);
  return lines.join("\n");
}

export function contactButton(contact) {
  const m = /^@?([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(contact.trim()) ||
            /^(?:https?:\/\/)?t\.me\/([A-Za-z][A-Za-z0-9_]{3,31})\/?$/.exec(contact.trim());
  if (!m || (!contact.includes("@") && !contact.includes("t.me"))) return null;
  return { inline_keyboard: [[{ text: "✉️ Написать клиенту", url: `https://t.me/${m[1]}` }]] };
}

export async function handleLead(request, env, fetchImpl = fetch) {
  const cors = corsHeaders(request, env);
  const json = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json(405, { ok: false, error: "Используйте POST" });
  if (!originAllowed(request, env)) return json(403, { ok: false, error: "Запрос с чужого сайта" });
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return json(500, { ok: false, error: "Приём заявок не настроен на сервере" });
  }

  let data;
  try {
    data = await request.json();
  } catch {
    return json(400, { ok: false, error: "Некорректные данные формы" });
  }

  // Защита от спам-роботов: скрытое поле заполнено или форма отправлена слишком быстро.
  // Роботу отвечаем «успехом», чтобы он не пытался обойти проверку.
  const tooFast = typeof data.startedAt === "number" && Date.now() - data.startedAt < MIN_FILL_MS;
  if (clean(data.website, 100) || tooFast) return json(200, { ok: true });

  const lead = {
    services: clean(Array.isArray(data.services) ? data.services.join(", ") : data.services, LIMITS.services),
    task: clean(data.task, LIMITS.task),
    deadline: clean(data.deadline, LIMITS.deadline),
    budget: clean(data.budget, LIMITS.budget),
    contact: clean(data.contact, LIMITS.contact),
    page: clean(data.page, LIMITS.page),
  };
  if (lead.task.length < 10) return json(400, { ok: false, error: "Опишите задачу подробнее (от 10 символов)" });
  if (lead.contact.length < 2) return json(400, { ok: false, error: "Укажите, как с вами связаться" });

  const payload = {
    chat_id: env.TELEGRAM_CHAT_ID,
    text: buildMessage(lead),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  const button = contactButton(lead.contact);
  if (button) payload.reply_markup = button;

  try {
    const tg = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await tg.json().catch(() => ({}));
    if (!tg.ok || !result.ok) {
      console.error("Telegram API error", tg.status, result.description);
      return json(502, { ok: false, error: "Не удалось доставить заявку. Напишите нам в Telegram." });
    }
  } catch (err) {
    console.error("Telegram API unreachable", err);
    return json(502, { ok: false, error: "Не удалось доставить заявку. Напишите нам в Telegram." });
  }
  return json(200, { ok: true });
}
