// ============================================================
// نور بوت - واتساب سيلز بوت بالذكاء الاصطناعي
// ============================================================

require("dotenv").config({ override: true });

const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const pino = require("pino");

// ============================================================
// تحميل الملفات
// ============================================================

function loadTextFile(filename) {
  const filePath = path.join(__dirname, "config", filename);

  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, "utf-8").trim();
  }

  console.error(`❌ ملف مش موجود: config/${filename}`);
  process.exit(1);
}

// ============================================================
// تحميل الـ Config
// ============================================================

const PERSONA_PROMPT = loadTextFile("persona.txt");
const PRODUCTS_PROMPT = loadTextFile("products.txt");
const FAQ_PROMPT = loadTextFile("faq.txt");
const INTRO_MESSAGE = loadTextFile("intro.txt");

// ============================================================
// OpenAI
// ============================================================

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ============================================================
// Sessions
// ============================================================

const sessions = new Map();

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      messages: [],
      orderData: {},
      stage: "chat",
      isFirstMessage: true,
    });
  }

  return sessions.get(phone);
}

// ============================================================
// System Prompt
// ============================================================

function buildSystemPrompt(orderData, stage) {
  return `
${PERSONA_PROMPT}

${PRODUCTS_PROMPT}

${FAQ_PROMPT}

قواعد مهمة:

- اتكلمي زي بنت مصرية بتبيع على واتساب فعلًا.
- استخدمي كلمات مصرية دارجة مش فصحى.
- بدل كلمة "عاجبك" استخدمي "معجبك" أو "على ذوقك".
- متقوليش "حابب" قولي "تحب".
- متقوليش "أنواع" قولي "أشكال" أو "حاجات".
- متقوليش "متوفر" قولي "فيه".
- متقوليش "وريني عينة" قولي "ابعتلي صورة".
- الردود تبقى قصيرة على قد السؤال.
- أحيانًا ابعتي رسالة قصيرة جدًا من كلمة أو كلمتين عادي.
- متكرريش السلام أو الترحيب أكتر من مرة.
- متشرحيش المنتج كله إلا لو العميل سأل.
- متستخدميش جمل AI طويلة.
- كلامك يبقى طبيعي حتى لو فيه اختصار بسيط.
- الإيموجي قليل.
- متستخدميش فصحى نهائي.
`;
}

// ============================================================
// Chat With Nour
// ============================================================

async function chatWithNour(phone, userMessage) {
  const session = getSession(phone);

  session.isFirstMessage = false;

  session.messages.push({
    role: "user",
    content: userMessage,
  });

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(session.orderData, session.stage),
        },
        ...session.messages,
      ],
      temperature: 0.85,
      max_tokens: 500,
    });

    const reply = response.choices[0].message.content.trim();

    session.messages.push({
      role: "assistant",
      content: reply,
    });

    return reply;
  } catch (err) {
    console.error("❌ OpenAI Error:", err.message);
    return "في مشكلة صغيرة دلوقتي 😅";
  }
}

// ============================================================
// WhatsApp (Baileys - اتصال بالباركود)
// ============================================================

let sock = null;

// إرسال رسالة عبر Baileys
async function sendWhatsAppMessage(chatId, message) {
  try {
    if (!sock) {
      console.error("❌ الاتصال بالواتساب لسه مش جاهز");
      return;
    }
    await sock.sendMessage(chatId, { text: message });
  } catch (err) {
    console.error("❌ WhatsApp Send Error:", err.message);
  }
}

// ============================================================
// Message Buffer
// ============================================================

const messageBuffers = new Map();
const BUFFER_DELAY_MS = 4000;

function handleIncomingMessage(chatId, text) {
  console.log(`📩 ${chatId}: ${text}`);

  if (messageBuffers.has(chatId)) {
    clearTimeout(messageBuffers.get(chatId).timer);
    messageBuffers.get(chatId).texts.push(text);
  } else {
    messageBuffers.set(chatId, {
      texts: [text],
      timer: null,
    });
  }

  const buffer = messageBuffers.get(chatId);

  buffer.timer = setTimeout(async () => {
    const mergedText = buffer.texts.join(" ");
    const session = getSession(chatId);
    const isFirst = session.isFirstMessage;

    messageBuffers.delete(chatId);

    console.log(`📨 الرسائل المجمعة: ${mergedText}`);

    // تأخير 30 ثانية للرسالة الأولى بس
    if (isFirst) {
      console.log(`⏳ تأخير 30 ثانية للرسالة الأولى من ${chatId}`);

      await new Promise((resolve) => setTimeout(resolve, 30000));

      session.isFirstMessage = false;
    }

    const reply = await chatWithNour(chatId, mergedText);

    await sendWhatsAppMessage(chatId, reply);

    console.log(`💬 نور: ${reply}`);
  }, BUFFER_DELAY_MS);
}

// ============================================================
// استخراج نص الرسالة من رسالة Baileys
// ============================================================

function extractMessageText(msg) {
  const m = msg.message;
  if (!m) return null;

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    null
  );
}

// ============================================================
// تشغيل اتصال الواتساب (باركود عبر التيرمينال)
// ============================================================

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(
    path.join(__dirname, "auth_info")
  );

  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("📱 امسح الباركود ده من واتساب (الأجهزة المرتبطة):");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.error(
        "❌ الاتصال اتقفل:",
        lastDisconnect?.error?.message || "غير معروف"
      );

      if (shouldReconnect) {
        console.log("🔄 بيعيد الاتصال...");
        startWhatsApp();
      } else {
        console.log(
          "🚪 تم تسجيل الخروج. احذف فولدر auth_info وشغّل تاني علشان تعمل باركود جديد."
        );
      }
    } else if (connection === "open") {
      console.log("✅ نور شغالة ومتصلة بالواتساب");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key.fromMe) continue;

      const chatId = msg.key.remoteJid;
      if (!chatId) continue;

      // تجاهل رسائل الجروبات والحالات
      if (chatId.endsWith("@g.us") || chatId === "status@broadcast") continue;

      const text = extractMessageText(msg);
      if (!text || !text.trim()) continue;

      handleIncomingMessage(chatId, text.trim());
    }
  });
}

// ============================================================
// Start
// ============================================================

console.log("🚀 تشغيل نور بوت (باركود واتساب)...");

startWhatsApp();
