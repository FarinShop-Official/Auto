const { Telegraf, Markup, session } = require("telegraf");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const qs = require("querystring");
const FormData = require("form-data");
const archiver = require("archiver");
const QRCode = require("qrcode");
const config = require("./config");
const { createdQris, cekStatus, toRupiah } = require("./lib/payment");

const bot = new Telegraf(config.botToken);
bot.use(session());

const globalNokos = {
  cachedServices: [],
  cachedCountries: {},
  lastServicePhoto: {},
  activeOrders: {}
};

function isPrivateChat(ctx) {
  return ctx.chat.type === 'private';
}

async function requirePrivateChat(ctx, actionName) {
  if (!isPrivateChat(ctx)) {
    await ctx.answerCbQuery("❌ Perintah ini hanya bisa digunakan di Private Chat!", { show_alert: true });
    
    try {
      await ctx.reply("𝐒𝐢𝐥𝐚𝐤𝐚𝐧 𝐆𝐮𝐧𝐚𝐤𝐚𝐧 𝐝𝐢 𝐏𝐫𝐢𝐯𝐚𝐭𝐞 𝐂𝐡𝐚𝐭 𝐁𝐨𝐭𝐳", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💬 𝐏𝐫𝐢𝐯𝐚𝐭𝐞 𝐂𝐡𝐚𝐭", url: `https://t.me/${bot.botInfo.username}` }]
          ]
        }
      });
    } catch (e) {}
    
    return false;
  }
  return true;
}

function getSaldo(userId) {
  const filePath = path.join(__dirname, 'database', 'saldoOtp.json');
  if (!fs.existsSync(filePath)) return 0;

  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  // Ambil langsung angka dari JSON, kalau tidak ada default 0
  return Number(data[userId] || 0);
}

async function atlanticTransfer(nominal, config, note = "Withdraw Saldo Bot") {
  try {
    const reffId = `wd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const body = {
      api_key: config.apiAtlantic,
      ref_id: reffId,
      kode_bank: config.wd_balance.bank_code,
      nomor_akun: config.wd_balance.destination_number,
      nama_pemilik: config.wd_balance.destination_name,
      nominal: Number(nominal),
      email: "bot@telegram.com",
      phone: config.wd_balance.destination_number,
      note: note
    };

    const response = await axios.post("https://atlantich2h.com/transfer/create", qs.stringify(body), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000
    });

    return response.data;
  } catch (error) {
    throw new Error(`Gagal membuat transfer: ${error.message}`);
  }
}

async function rumahOtpTransfer(nominal, config) {
  try {
    const reffId = `wd_rotp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const body = {
      api_key: config.RUMAHOTP,
      action: 'transfer',
      code: config.wd_balance.bank_code,
      target: config.wd_balance.destination_number,
      amount: parseInt(nominal),
      reff_id: reffId
    };

    const response = await axios.post("https://www.rumahotp.com/api/v2/h2h/transfer", qs.stringify(body), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });

    if (!response.data || (response.data.success === false)) {
        throw new Error(response.data.message || "Gagal request ke API RumahOTP");
    }

    return response.data;
  } catch (error) {
    throw new Error(`Gagal WD RumahOTP: ${error.message}`);
  }
}

async function atlanticTransferStatus(transferId, api_key) {
  const body = { api_key, id: String(transferId) };
  const response = await axios.post("https://atlantich2h.com/transfer/status", qs.stringify(body), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" }
  });
  return response.data;
}

async function editMenuMessage(ctx, text, keyboard) {
  try {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      ...keyboard
    });
  } catch (e) {
    try {
      const newMsg = await safeReply(ctx, text, {
        parse_mode: "HTML",
        ...keyboard
      });
      
      try {
        if (ctx.callbackQuery) {
          await ctx.deleteMessage();
        }
      } catch (err) {}
      
      return newMsg;
    } catch (replyErr) {
      console.error("Edit menu error:", replyErr);
      return null;
    }
  }
}

async function editMenuMessageWithPhoto(ctx, photo, caption, keyboard) {
  try {
    await ctx.editMessageMedia({
      type: 'photo',
      media: photo,
      caption: caption,
      parse_mode: 'HTML'
    }, {
      parse_mode: "HTML",
      ...keyboard
    });
  } catch (e) {
    try {
      try {
        if (ctx.callbackQuery) {
          await ctx.deleteMessage();
        }
      } catch (err) {}
      
      await ctx.replyWithPhoto(photo, {
        caption: caption,
        parse_mode: "HTML",
        ...keyboard
      });
    } catch (replyErr) {
      console.error("Edit menu with photo error:", replyErr);
      return null;
    }
  }
}

async function safeSend(method, chatId, ...args) {
  try {
    return await bot.telegram[method](chatId, ...args);
  } catch (err) {
    const m = err?.response?.description || err?.description || err?.message || String(err);
    if (typeof m === 'string' && (m.toLowerCase().includes('user is deactivated') || m.toLowerCase().includes('bot was blocked') || m.toLowerCase().includes('blocked'))) {
      return null;
    }
    throw err;
  }
}

async function safeReply(ctx, text, extra = {}) {
  try {
    return await ctx.reply(text, extra);
  } catch (err) {
    const m = err?.response?.description || err?.description || err?.message || String(err);
    if (typeof m === 'string' && (m.toLowerCase().includes('user is deactivated') || m.toLowerCase().includes('bot was blocked') || m.toLowerCase().includes('blocked'))) {
      return null;
    }
    throw err;
  }
}

const USERS_DB = "./users.json";
const DB_PATH = "./database.json";

/* PASANG DI SINI ⬇️ */
function readDb() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({
      isPanelOpen: true,
      scripts: [],
      apps: [],
      users: {}, // ⬅️ WAJIB ADA
      paymentMethod: config.payment?.method || 'orkut'
    }, null, 2));
  }

  const db = JSON.parse(fs.readFileSync(DB_PATH));

  if (!db.users) db.users = {}; // ⬅️ pengaman

  return db;
}

function saveDb(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

const MANUAL_PAYMENTS_DB = "./manual_payments.json";
const activeTransactions = {};
const userState = {};
const liveChatState = {};
const ownerReplyState = {};

let botStartTime = Date.now();

const TESTIMONI_CHANNEL = config.testimoniChannel || "";

async function createAndSendFullBackup(ctx = null, isAuto = false) {
  const timestamp = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })
    .replace(/[\/:]/g, '-').replace(/, /g, '_');
  
  const backupName = `SC_FULL_${config.botName || 'Bot'}_${timestamp}.zip`;
  const backupPath = path.join(__dirname, backupName);
  const output = fs.createWriteStream(backupPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  console.log(`[BACKUP] Memulai proses zip full SC...`);

  return new Promise((resolve, reject) => {
    output.on('close', async () => {
      try {
        const caption = isAuto 
          ? `♻️ <b>AUTO BACKUP SC</b>\n📅 ${timestamp}\n📦 Full Source Code (Tanpa node_modules)`
          : `📦 <b>BACKUP SOURCE CODE</b>\n📅 ${timestamp}\n✅ Full Folder Zip`;

        await bot.telegram.sendDocument(config.ownerId, {
          source: backupPath,
          filename: backupName
        }, { caption: caption, parse_mode: "HTML" });

        fs.unlinkSync(backupPath);
        if (ctx) await ctx.reply("✅ <b>Backup Full SC Terkirim!</b>", { parse_mode: "HTML" });
        resolve(true);
      } catch (err) {
        console.error("[BACKUP FAIL]", err);
        if (ctx) await ctx.reply("❌ Gagal kirim backup.");
        reject(err);
      }
    });

    archive.on('error', (err) => reject(err));
    archive.pipe(output);

    archive.glob('**/*', {
      cwd: __dirname,
      ignore: [
        'node_modules/**', 
        '.git/**',
        'package-lock.json',
        '*.zip',
        'session/**'
      ]
    });

    archive.finalize();
  });
}

async function generateLocalQr(qrString) {
  try {
    return await QRCode.toBuffer(qrString, {
      type: 'png',
      width: 400,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });
  } catch (err) {
    console.error("QR Generate Error:", err);
    return null;
  }
}

async function sendStartInfoToChannel(user) {
  try {
    if (!TESTIMONI_CHANNEL) {
      console.log("[INFO] Channel testimoni belum diatur di config.js");
      return;
    }

    const cleanFirstName = cleanText(user.first_name || '');
    const cleanLastName = cleanText(user.last_name || '');
    const username = user.username ? `@${user.username}` : '-';
    const now = new Date();
    const options = { 
      timeZone: 'Asia/Jakarta', 
      weekday: 'long',
      year: 'numeric', 
      month: 'long', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    };
    const waktuWIB = now.toLocaleString('id-ID', options);
    
    const startInfo = `
🚀 𝗪𝗘𝗟𝗖𝗢𝗠𝗘 𝗡𝗘𝗪 𝗣𝗘𝗡𝗚𝗚𝗨𝗡𝗔 𝗕𝗢𝗧
❍━━━━━━━━━━━━━━━━━━━━━━❍
╭⌑ 👤 𝗡𝗮𝗺𝗲 : ${cleanFirstName} ${cleanLastName}
├⌑ 🆔 𝗜𝗱 : ${user.id}
├⌑ 📛 𝗨𝘀𝗲𝗿𝗻𝗮𝗺𝗲 : ${username}
╰⌑ ⏰ 𝗪𝗮𝗸𝘁𝘂 : ${waktuWIB} WIB
❍━━━━━━━━━━━━━━━━━━━━━━❍
🍂 𝗪𝗲𝗹𝗰𝗼𝗺𝗲 𝗧𝗼 𝗕𝗼𝘁 ${config.botName || "Bot"}!
    `;

    await bot.telegram.sendMessage(TESTIMONI_CHANNEL, startInfo, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🛒 𝐁𝐞𝐥𝐢 𝐬𝐞𝐤𝐚𝐫𝐚𝐧𝐠", url: `https://t.me/${bot.botInfo.username}` }]
        ]
      }
    });

    console.log("[SUCCESS] Info start user baru berhasil dikirim ke channel");
  } catch (error) {
    console.error("[ERROR] Gagal mengirim info start ke channel:", error.message);
    console.log("[INFO] Pastikan bot sudah jadi admin di channel:", TESTIMONI_CHANNEL);
  }
}

function cleanText(text) {
  if (!text) return '';
  return String(text)
    .replace(/\_/g, '\\_')
    .replace(/\*/g, '\\*')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\~/g, '\\~')
    .replace(/\`/g, '\\`')
    .replace(/\>/g, '\\>')
    .replace(/\#/g, '\\#')
    .replace(/\+/g, '\\+')
    .replace(/\-/g, '\\-')
    .replace(/\=/g, '\\=')
    .replace(/\|/g, '\\|')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\./g, '\\.')
    .replace(/\!/g, '\\!')
    .trim();
}

async function sendTestimoniKeChannel(userName, userId, productName, amount) {
  try {
    if (!TESTIMONI_CHANNEL) {
      console.log("[INFO] Channel testimoni belum diatur di config.js");
      return;
    }

    const now = new Date();
    const options = { 
      timeZone: 'Asia/Jakarta', 
      weekday: 'long',
      year: 'numeric', 
      month: 'long', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    };
    const waktuWIB = now.toLocaleString('id-ID', options);

    const testimoniText = `
📜 𝗦𝗧𝗥𝗨𝗞 𝗣𝗘𝗠𝗕𝗘𝗟𝗜𝗔𝗡 𝗣𝗥𝗢𝗗𝗨𝗞
❍━━━━━━━━━━━━━━━━━━━━━━❍
🪪 𝗜𝗗𝗘𝗡𝗧𝗜𝗧𝗔𝗦 𝗣𝗘𝗠𝗕𝗘𝗟𝗜
├⌑ 👤 𝗡𝗮𝗺𝗮 : ${userName}
╰⌑ 🆔 𝗜𝗗 : ${userId}
❍━━━━━━━━━━━━━━━━━━━━━━❍
🎀 𝗗𝗔𝗧𝗔 𝗣𝗥𝗢𝗗𝗨𝗞
├⌑ 🛒 𝗣𝗿𝗼𝗱𝘂𝗸 : ${productName}
├⌑ 💰 𝗛𝗮𝗿𝗴𝗮 : ${toRupiah(amount)}
╰⌑ ⏰ 𝗪𝗮𝗸𝘁𝘂 : ${waktuWIB} WIB
❍━━━━━━━━━━━━━━━━━━━━━━❍
📨 𝗧𝗲𝗿𝗶𝗺𝗮𝗸𝗮𝘀𝗶𝗵 𝗦𝘂𝗱𝗮𝗵 𝗕𝗲𝗹𝗮𝗻𝗷𝗮 𝗗𝗶 :
 ➥ ${config.botName} 𝗕𝗼𝘁
    `;

    await bot.telegram.sendMessage(TESTIMONI_CHANNEL, testimoniText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🛒 𝐁𝐞𝐥𝐢 𝐬𝐞𝐤𝐚𝐫𝐚𝐧𝐠", url: `https://t.me/${bot.botInfo.username}` }]
        ]
      }
    });

    console.log("[SUCCESS] Testimoni berhasil dikirim ke channel");
  } catch (error) {
    console.error("[ERROR] Gagal mengirim testimoni ke channel:", error.message);
    console.log("[INFO] Pastikan bot sudah jadi admin di channel:", TESTIMONI_CHANNEL);
  }
}


function getBotStats() {
  try {
    const users = loadUsers();
    const totalUsers = users.length;

    const uptime = Date.now() - botStartTime;
    const days = Math.floor(uptime / (1000 * 60 * 60 * 24));
    const hours = Math.floor((uptime % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));

    return {
      totalUsers,
      runtime: `${days}d ${hours}h ${minutes}m`,
      botName: config.botName || "BOT TELEGRAM",
      ownerName: config.ownerName || "Owner",
      backupCount: "Auto" 
    };
  } catch (e) {
    return {
      totalUsers: "Error",
      runtime: "Unknown",
      botName: config.botName || "BOT TELEGRAM",
      ownerName: config.ownerName || "Owner",
      backupCount: "-"
    };
  }
}

function formatUserCard(ctx, msg) {
  const username = ctx.from.username ? `@${ctx.from.username}` : '-';
  return `<b>📩 𝐏𝐞𝐬𝐚𝐧 𝐝𝐚𝐫𝐢 𝐮𝐬𝐞𝐫</b>\n<b>Username :</b> ${username}\n<b>ID User :</b> ${ctx.from.id}\n\n<b>Pesan :</b>\n${msg}`;
}


bot.command("pesan", async (ctx) => {
  const raw = ctx.message.text || "";
  const msg = raw.replace(/^\/pesan(@\w+)?\s*/i, "").trim();

  if (!msg) {
    liveChatState[ctx.from.id] = { step: "WAITING_MESSAGE" };
    return safeReply(ctx, "<blockquote>📝 <b>Silakan ketik pesan yang ingin dikirim ke owner.</b>\nKetik /batal untuk membatalkan.</blockquote>", { parse_mode: "HTML" });
  }

  return sendToOwner(ctx, msg);
});

bot.command("batal", (ctx) => {
  if (liveChatState[ctx.from.id]?.step === "WAITING_MESSAGE") {
    delete liveChatState[ctx.from.id];
    return safeReply(ctx, "❌ Pengiriman pesan dibatalkan.");
  }
  if (ownerReplyState[ctx.from.id]) {
    delete ownerReplyState[ctx.from.id];
    return safeReply(ctx, "❌ Mode balas owner dibatalkan.");
  }
  if (userState[ctx.from.id]?.step === "WAITING_BROADCAST" && ctx.from.id === config.ownerId) {
    delete userState[ctx.from.id];
    return safeReply(ctx, "❌ Broadcast dibatalkan.");
  }
  return; 
});

bot.on("text", async (ctx, next) => {
  try {
    const st = liveChatState[ctx.from.id];
    if (st && st.step === "WAITING_MESSAGE") {
      const text = ctx.message.text;
      delete liveChatState[ctx.from.id];
      return await sendToOwner(ctx, text);
    }
  } catch (e) {}
  return next();
});

async function sendToOwner(ctx, messageText) {
  try {
    const owner = config.ownerId;
    const layout = formatUserCard(ctx, messageText);
    await bot.telegram.sendMessage(owner, layout, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "💬 Balas Pesan", callback_data: `reply_${ctx.from.id}` }]
        ]
      }
    });
    await safeReply(ctx, "<blockquote>✅ <b>Pesan berhasil dikirim ke owner.</b></blockquote>", { parse_mode: "HTML" });
  } catch (err) {
    return safeReply(ctx, "❌ Gagal mengirim pesan ke owner.");
  }
}

bot.action(/reply_(\d+)/, async (ctx) => {
  try {
    if (String(ctx.from.id) !== String(config.ownerId)) {
      await ctx.answerCbQuery("❌ Hanya owner yang boleh membalas.", { show_alert: true });
      return;
    }
    const targetId = ctx.match[1];
    ownerReplyState[ctx.from.id] = { target: targetId, step: "WAITING_REPLY" };
    await ctx.answerCbQuery();
    await safeReply(ctx, "<blockquote>✉️ <b>Silakan kirim balasan Anda sekarang</b> (text / foto / voice / file).\nKetik /batal untuk batalkan.</blockquote>", { parse_mode: "HTML" });
  } catch (e) {}
});

async function forwardReplyToUser(ownerCtx, targetUserId, messageType, payload) {
  try {
    if (messageType === "text") {
      await bot.telegram.sendMessage(targetUserId, `<blockquote>💬 <b>Balasan dari Owner:</b>\n\n${payload}</blockquote>`, { parse_mode: "HTML" });
      await ownerCtx.reply("✅ Balasan terkirim sebagai teks.");
      return;
    }
  } catch (e) {
    await ownerCtx.reply("❌ Gagal mengirim balasan ke user.");
  }
}

bot.on("text", async (ctx, next) => {
  try {
    const st = ownerReplyState[ctx.from.id];
    if (st && st.step === "WAITING_REPLY") {
      const target = st.target;
      const text = ctx.message.text;
      delete ownerReplyState[ctx.from.id];
      await forwardReplyToUser(ctx, target, "text", text);
      return;
    }
  } catch (e) {}
  return next();
});



function loadUsers() {
  if (!fs.existsSync(USERS_DB)) {
    fs.writeFileSync(USERS_DB, JSON.stringify([]));
  }
  return JSON.parse(fs.readFileSync(USERS_DB));
}

function saveUsers(list) {
  fs.writeFileSync(USERS_DB, JSON.stringify(list, null, 2));
}

function checkAndAddUser(user) {
  const db = readDb(); // ambil database.json
  if (!db.users) db.users = {};

  const isNewUser = !db.users[user.id];

  if (isNewUser) {
    db.users[user.id] = {
      orders: [],          // jumlah order
      deposits: [],
      balance: 0,
      level: 1,
      name: user.first_name || "Pengguna",  // simpan nama asli
      username: user.username || "-"        // simpan username
    };
    saveDb(db);

    // kalau mau push ke list user di loadUsers()
    const users = loadUsers();
    users.push(user.id);
    saveUsers(users);

    sendStartInfoToChannel(user);
    return true;
  } else {
    // update nama & username kalau berubah
    db.users[user.id].name = user.first_name || db.users[user.id].name;
    db.users[user.id].username = user.username || db.users[user.id].username;
    saveDb(db);
  }

  return false;
}

bot.on("message", (ctx, next) => {
  try {
    checkAndAddUser(ctx.from);
  } catch (e) {
    console.error("[ERROR] Error adding user:", e);
  }
  return next();
});

// ===== USER HISTORY =====
function getUserHistory(userId) {
  const db = readDb();
  if (!db.users) db.users = {};
  if (!db.users[userId]) {
    db.users[userId] = { orders: [], deposits: [] };
    saveDb(db);
  }
  return db.users[userId];
}

function addOrderHistory(userId, data) {
  const db = readDb();
  if (!db.users) db.users = {};
  if (!db.users[userId]) db.users[userId] = { orders: [], deposits: [] };

  db.users[userId].orders.unshift({
    ...data,
    time: new Date().toISOString()
  });

  saveDb(db);
}

function addDepositHistory(userId, data) {
  const db = readDb();
  if (!db.users) db.users = {};
  if (!db.users[userId]) db.users[userId] = { orders: [], deposits: [] };

  db.users[userId].deposits.unshift({
    ...data,
    time: new Date().toISOString()
  });

  saveDb(db);
}

bot.start(async (ctx) => {
  const stats = getBotStats();
  
  const isNewUser = checkAndAddUser(ctx.from);
  
  const cleanFirstName = cleanText(ctx.from.first_name || 'Pengguna');
  
  const welcomeText = `<blockquote>( 🕊️ ) 𝖮𝗅𝖺𝖺 ☇ ${cleanFirstName}
𝐖𝐞𝐥𝐜𝐨𝐦𝐞 𝐓𝐨 𝐁𝐨𝐭𝐳 𝐀𝐮𝐭𝐨 𝐎𝐫𝐝𝐞𝐫 🛍️ 
━━━━━━━━━━━━━━━━━━━━━━
<b>𝗕𝗢𝗧 𝗜𝗡𝗙𝗢𝗥𝗠𝗔𝗧𝗜𝗢𝗡</b>
⬡ 𝖠𝗎𝗍𝗁𝗈𝗋 : ${stats.ownerName}
⬡ 𝖵𝖾𝗋𝗌𝗂𝗈𝗇 : 2.0.0
⬡ 𝖱𝗎𝗇𝗍𝗂𝗆𝖾 : ${stats.runtime}
⬡ 𝖳𝗈𝗍𝖺𝗅 𝖴𝗌𝖾r : ${stats.totalUsers}
━━━━━━━━━━━━━━━━━━━━━━
[ 𐚁 ] 𝐂𝐥𝐢𝐜𝐤 𝐁𝐮𝐭𝐭𝐨𝐧 𝐢𝐭𝐮 𝐮𝐧𝐭𝐮𝐤 𝐦𝐞𝐦𝐛𝐞𝐥𝐢 𝐏𝐫𝐨𝐝𝐮𝐤 𝐨𝐰𝐧𝐞𝐫 𝐁𝐨𝐭𝐳</blockquote>`;

  const menuKeyboard = {
    inline_keyboard: [
      [
        { text: "🛒 ☇ 𝐎𝐫𝐝𝐞𝐫 𝐍𝐨𝐤𝐨𝐬", callback_data: "choose_service" },
        { text: "🏦 ☇ 𝐃𝐞𝐩𝐨𝐬𝐢𝐭 ", callback_data: "topup_nokos" }
      ],
      [
       { text: "🏘 ☇ 𝐌𝐚𝐫𝐤𝐞𝐭𝐩𝐥𝐚𝐜𝐞", url: config.GroupOwner },
        { text: "🏠 ☇ 𝐂𝐡𝐚𝐧𝐧𝐞𝐥", url: config.ChannelOwner }
      ],
      [
      { text: "🏆 ☇ Top User", callback_data: "top_user" },
      { text: "👤 𝐏𝐫𝐨𝐟𝐢𝐥", callback_data: "menu_profil" }
      ],
      [{ text: "👑 ☇ 𝐎𝐰𝐧𝐞𝐫", callback_data: "menu_owner_contact" }]
    ]
  };

  if (config.startPhoto) {
    try {
      await ctx.replyWithPhoto(config.startPhoto, {
        caption: welcomeText,
        parse_mode: "HTML",
        reply_markup: menuKeyboard
      });
    } catch (e) {
      await safeReply(ctx, welcomeText, {
        parse_mode: "HTML",
        reply_markup: menuKeyboard
      });
    }
  } else {
    await safeReply(ctx, welcomeText, {
      parse_mode: "HTML",
      reply_markup: menuKeyboard
    });
  }

  if (config.startAudio && config.startAudio.trim() !== "") {
    try {
      await ctx.replyWithAudio(config.startAudio, {
        caption: config.startAudioCaption || "",
        parse_mode: "HTML"
      });
    } catch (audioError) {
      console.error("[ERROR] Failed to send start audio:", audioError.message);
    }
  }

  if (ctx.from.id === config.ownerId) {
    await safeReply(ctx, `<blockquote><b>👑 Selamat Datang Owner</b></blockquote>`, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "🔧 Menu Owner", callback_data: "menu_owner" }]]
      }
    });
  }
});

bot.action("top_user", async (ctx) => {
  try {
    const db = readDb(); // ambil database.json
    const users = db.users;

    // Ambil semua user yang pernah beli (orders > 0)
    const ranking = Object.keys(users)
      .map(id => {
        const u = users[id];
        const totalOrder = typeof u.orders === "number" ? u.orders : (u.orders?.length || 0);
        return { id, name: u.name || "-", username: u.username || "-", totalOrder };
      })
      .filter(u => u.totalOrder > 0); // filter yang belum beli

    if (ranking.length === 0) {
      return ctx.answerCbQuery("❌ Belum ada user yang membeli", { show_alert: true });
    }

    // Urutkan dari yang paling banyak beli
    ranking.sort((a, b) => b.totalOrder - a.totalOrder);

    // Ambil top 10
    const top10 = ranking.slice(0, 10);

    // Buat caption
    let caption = "<b>🏆 TOP 10 USER TERBANYAK MEMBELI NOMOR</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n";
    top10.forEach((u, i) => {
  caption += `<b>#${i + 1}</b> ${u.name} ${u.username ? "(@" + u.username + ")" : ""}\nID: ${u.id}\nTotal Order: ${u.totalOrder}\n━━━━━━━━━━━━━━\n`;
});

    // Tombol kembali
    const keyboard = {
      inline_keyboard: [
        [{ text: "⬅️ Kembali", callback_data: "back_home" }]
      ]
    };

    // Kirim gambar + caption + tombol
    const photoURL = config.Profil_pengguna;
    const message = ctx.update.callback_query.message;

    if (message.photo) {
      // edit caption aja biar tombol muncul
      await ctx.editMessageCaption(caption, {
        parse_mode: "HTML",
        reply_markup: keyboard
      });
    } else {
      // kirim foto baru kalau belum ada
      await ctx.replyWithPhoto(photoURL, {
        caption: caption,
        parse_mode: "HTML",
        reply_markup: keyboard
      });
    }

  } catch (e) {
    console.error("Error top_user:", e.message);
    await ctx.answerCbQuery("❌ Gagal menampilkan top user", { show_alert: true });
  }
});

bot.action("menu_profil", async (ctx) => {
  try {
    const user = ctx.from;
    const db = readDb();

    // Pastikan user ada di database
    if (!db.users[user.id]) {
      db.users[user.id] = { orders: [], deposits: [], balance: 0, level: 1 };
      saveDb(db);
    }

    const userData = db.users[user.id];

    // Foto profil dari config
    const photoURL = config.Profil_pengguna;

const saldo = getSaldo(user.id);

const text = `<blockquote>
<b>📊 PROFIL PENGGUNA</b>
━━━━━━━━━━━━━━━━━━━━━━
<b>👤 Informasi Akun</b>
Nama     : ${user.first_name || "-"}
Username : ${user.username ? "@" + user.username : "-"}
User ID  : ${user.id}
<b>💰 Saldo:</b> ${toRupiah(saldo)}
</blockquote>`;

    // Tombol inline
    const keyboard = {
      inline_keyboard: [
        [{ text: "⬅️ Kembali", callback_data: "back_home" }]
      ]
    };

    // Hapus pesan lama dulu biar aman
    try { await ctx.deleteMessage(); } catch(e){}

    // Kirim foto + caption + tombol
    await ctx.replyWithPhoto(photoURL, {
      caption: text,
      parse_mode: "HTML",
      reply_markup: keyboard
    });

  } catch (error) {
    console.error("[ERROR] menu_profil:", error.message);
    await safeReply(ctx, "❌ Gagal menampilkan profil.");
  }
});


bot.action("menu_owner_contact", async (ctx) => {
  await editMenuMessage(ctx,
    `<blockquote><b>📞「 𝗖𝗢𝗡𝗧𝗔𝗖𝗧 𝗢𝗪𝗡𝗘𝗥 𝗕𝗢𝗧 」</b>\n` +
    `<b>❍━━━━━━━━━━━━━━━━━━━━━━❍</b>\n` +
    `<b>🍂 𝗡𝗮𝗺𝗲 :</b> ${config.ownerName || "𝗔𝗱𝗺𝗶𝗻"}\n` +
    `<b>📲 𝗪𝗵𝗮𝘁𝘀𝗮𝗽𝗽 :</b> ${config.ownerWa}\n` +
    `<b>✈️ 𝗧𝗲𝗹𝗲𝗴𝗿𝗮𝗺 :</b> ${config.ownerUser}\n` +
    `<b>❍━━━━━━━━━━━━━━━━━━━━━━❍</b>\n` +
    `📩 𝗞𝗮𝗺𝘂 𝗟𝗶𝗺𝗶𝘁? 𝗦𝗶𝗹𝗮𝗵𝗸𝗮𝗻 𝗞𝗹𝗶𝗸 𝗖𝗼𝗺𝗺𝗮𝗻𝗱 𝗗𝗶𝘀𝗮𝗺𝗽𝗶𝗻𝗴 : /pesan</blockquote>\n`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "💬 Kirim Pesan ke Owner", callback_data: "send_message_owner" }],
          [{ text: "🔙 Kembali", callback_data: "back_home" }]
        ]
      }
    }
  );
});

bot.action("send_message_owner", async (ctx) => {
  liveChatState[ctx.from.id] = { step: "WAITING_MESSAGE" };
  await editMenuMessage(ctx, 
    "<blockquote>📝 <b>Silakan ketik pesan yang ingin dikirim ke owner.</b>\n\n<i>Ketik /batal untuk membatalkan</i></blockquote>",
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "❌ Batalkan", callback_data: "back_home" }]
        ]
      }
    }
  );
});

bot.action("back_home", async (ctx) => {
  const stats = getBotStats();
  
  const cleanFirstName = cleanText(ctx.from.first_name || 'Pengguna');
  
  const welcomeText = `<blockquote>( 🕊️ ) 𝖮𝗅𝖺𝖺 ☇ ${cleanFirstName}
𝐖𝐞𝐥𝐜𝐨𝐦𝐞 𝐓𝐨 𝐁𝐨𝐭𝐳 𝐀𝐮𝐭𝐨 𝐎𝐫𝐝𝐞𝐫 🛍️ 
━━━━━━━━━━━━━━━━━━━━━━
<b>𝗕𝗢𝗧 𝗜𝗡𝗙𝗢𝗥𝗠𝗔𝗧𝗜𝗢𝗡</b>
⬡ 𝖠𝗎𝗍𝗁𝗈𝗋 : ${stats.ownerName}
⬡ 𝖵𝖾𝗋𝗌𝗂𝗈𝗇 : 2.0.0
⬡ 𝖱𝗎𝗇𝗍𝗂𝗆𝖾 : ${stats.runtime}
⬡ 𝖳𝗈𝗍𝖺𝗅 𝖴𝗌𝖾r : ${stats.totalUsers}
━━━━━━━━━━━━━━━━━━━━━━
[ 𐚁 ] 𝐂𝐥𝐢𝐜𝐤 𝐁𝐮𝐭𝐭𝐨𝐧 𝐢𝐭𝐮 𝐮𝐧𝐭𝐮𝐤 𝐦𝐞𝐦𝐛𝐞𝐥𝐢 𝐏𝐫𝐨𝐝𝐮𝐤 𝐨𝐰𝐧𝐞𝐫 𝐁𝐨𝐭𝐳</blockquote>`;

  const menuKeyboard = {
    inline_keyboard: [
       [
        { text: "🛒 ☇ 𝐎𝐫𝐝𝐞𝐫 𝐍𝐨𝐤𝐨𝐬", callback_data: "choose_service" },
        { text: "🏦 ☇ 𝐃𝐞𝐩𝐨𝐬𝐢𝐭 ", callback_data: "topup_nokos" }
      ],
      [
       { text: "🏘 ☇ 𝐌𝐚𝐫𝐤𝐞𝐭𝐩𝐥𝐚𝐜𝐞", url: config.GroupOwner },
        { text: "🏠 ☇ 𝐂𝐡𝐚𝐧𝐧𝐞𝐥", url: config.ChannelOwner }
      ],
      [
      { text: "🏆 ☇ Top User", callback_data: "top_user" },
      { text: "👤 𝐏𝐫𝐨𝐟𝐢𝐥", callback_data: "menu_profil" }
      ],
      [{ text: "👑 ☇ 𝐎𝐰𝐧𝐞𝐫", callback_data: "menu_owner_contact" }]
    ]
  };

  if (config.startPhoto) {
    try {
      await editMenuMessageWithPhoto(ctx, config.startPhoto, welcomeText, {
        parse_mode: "HTML",
        reply_markup: menuKeyboard
      });
    } catch (e) {
      try {
        await editMenuMessage(ctx, welcomeText, {
          parse_mode: "HTML",
          reply_markup: menuKeyboard
        });
      } catch (err) {
        console.error("[ERROR] Failed to edit message in back_home:", err.message);
        await safeReply(ctx, welcomeText, {
          parse_mode: "HTML",
          reply_markup: menuKeyboard
        });
      }
    }
  } else {
    try {
      await editMenuMessage(ctx, welcomeText, {
        parse_mode: "HTML",
        reply_markup: menuKeyboard
      });
    } catch (err) {
      console.error("[ERROR] Failed to edit message in back_home (no photo):", err.message);
      await safeReply(ctx, welcomeText, {
        parse_mode: "HTML",
        reply_markup: menuKeyboard
      });
    }
  }
});

function showOwnerMenu(ctx) {
  if (ctx.from.id !== config.ownerId) 
    return safeReply(ctx, "<blockquote>🚫 𝗞𝗮𝗺𝘂 𝗕𝘂𝗸𝗮𝗻 𝗢𝘄𝗻𝗲𝗿 𝗕𝗼𝘁!</blockquote>", { parse_mode: "HTML" });
  safeReply(ctx, `<blockquote><b>👑 𝗠𝗘𝗡𝗨 𝗢𝗪𝗡𝗘𝗥</b>\n<b>𝖲𝗂𝗅𝖺𝗁𝗄𝖺𝗇 𝖳𝖾𝗄𝖺𝗇 𝖡𝗎𝗍𝗍𝗈𝗇 𝖣𝗂𝖻𝖺𝗐𝖺𝗁:</b></blockquote>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [ Markup.button.callback("𝐏𝐚𝐧𝐞𝐥 𝐎𝐧𝐥𝐢𝐧𝐞 / 𝐎𝐟𝐟𝐥𝐢𝐧𝐞", "owner_panel") ],
        [ Markup.button.callback("📢 𝐁𝐫𝐨𝐚𝐝𝐂𝐚𝐬𝐭", "owner_broadcast") ],
        [ Markup.button.callback("💰 𝐖𝐡𝐢𝐭𝐝𝐫𝐚𝐰 RumahOTP", "wd_rumahotp_start") ],
        [ Markup.button.callback("💸 𝐖𝐡𝐢𝐭𝐝𝐫𝐚𝐰 Atlantic", "menu_wd_info") ],
        [ Markup.button.callback("💾 𝐁𝐚𝐜𝐤𝐮𝐩 𝐒𝐜𝐫𝐢𝐩𝐭", "backup_database") ],
        [ Markup.button.callback("🔙 Kembali", "back_home") ]
      ])
    }
  );
}

bot.action("menu_owner", (ctx) => {
  ctx.answerCbQuery().catch(()=>{});
  showOwnerMenu(ctx);
});


bot.action("backup_database", async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner yang boleh backup!", { show_alert: true });
  }
  
  await ctx.answerCbQuery("⏳ Memproses Full Backup...", { show_alert: false });
  await safeReply(ctx, "<blockquote>📦 <b>Sedang mempacking seluruh Source Code & Database...</b>\n<i>Mohon tunggu, proses tergantung ukuran file.</i></blockquote>", { parse_mode: "HTML" });
  
  createAndSendFullBackup(ctx, false);
});


bot.action("owner_broadcast", (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  ctx.answerCbQuery().catch(()=>{});
  userState[ctx.from.id] = { step: "WAITING_BROADCAST" };
  safeReply(ctx, "<blockquote>📢 <b>Silakan kirim pesan broadcast (teks atau foto).</b>\nKetik /batal untuk membatalkan.</blockquote>", {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("❌ Batalkan Broadcast", "cancel_broadcast")]
    ])
  });
});

bot.action("cancel_broadcast", (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  if (userState[ctx.from.id]?.step === "WAITING_BROADCAST") {
    delete userState[ctx.from.id];
    safeReply(ctx, "❌ Broadcast dibatalkan.");
    showOwnerMenu(ctx);
  }
});

bot.action(/choose_service(_page_(\d+))?/, async (ctx) => {
  const page = ctx.match[2] ? parseInt(ctx.match[2]) : 1;
  const perPage = 8;
  const apiKey = config.RUMAHOTP;

  try {
    if (!ctx.match[2]) {
       await ctx.editMessageCaption("⏳ <b>Memuat daftar layanan...</b>", { parse_mode: "HTML" }).catch(() => {});
    }

    if (globalNokos.cachedServices.length === 0) {
      const res = await axios.get("https://www.rumahotp.com/api/v2/services", { headers: { "x-apikey": apiKey } });
      if (res.data.success) globalNokos.cachedServices = res.data.data;
    }

    const services = globalNokos.cachedServices;
    const totalPages = Math.ceil(services.length / perPage);
    const start = (page - 1) * perPage;
    const list = services.slice(start, start + perPage);

    const buttons = list.map(srv => [{
      text: `${srv.service_name}`,
      callback_data: `service_${srv.service_code}`
    }]);

    const nav = [];
    if (page > 1) nav.push({ text: "⬅️ Prev", callback_data: `choose_service_page_${page - 1}` });
    if (page < totalPages) nav.push({ text: "➡️ Next", callback_data: `choose_service_page_${page + 1}` });
    if (nav.length) buttons.push(nav);

    buttons.push([{ text: "🔙 Kembali", callback_data: "back_home" }]);

    const caption = `<b>📱 DAFTAR APLIKASI OTP</b>\n\nSilakan pilih aplikasi:\nHalaman ${page}/${totalPages}`;

    globalNokos.lastServicePhoto[ctx.from.id] = { chatId: ctx.chat.id, messageId: ctx.callbackQuery.message.message_id };

    if (config.ppthumb && !ctx.match[2]) {
       await editMenuMessageWithPhoto(ctx, config.ppthumb, caption, { reply_markup: { inline_keyboard: buttons } });
    } else {
       await ctx.editMessageCaption(caption, { parse_mode: "HTML", reply_markup: { inline_keyboard: buttons } });
    }

  } catch (error) {
    console.error(error);
    await ctx.answerCbQuery("❌ Gagal memuat layanan.");
  }
});

bot.action(/service_(.+)/, async (ctx) => {
  const serviceId = ctx.match[1];
  const apiKey = config.RUMAHOTP;

  await ctx.editMessageCaption("⏳ <b>Memuat negara...</b>", { parse_mode: "HTML" }).catch(() => {});

  try {
    if (!globalNokos.cachedCountries[serviceId]) {
      const res = await axios.get(`https://www.rumahotp.com/api/v2/countries?service_id=${serviceId}`, {
        headers: { "x-apikey": apiKey }
      });
      if (res.data.success) {
         globalNokos.cachedCountries[serviceId] = res.data.data.filter(x => x.pricelist && x.pricelist.length > 0);
      }
    }

    const countries = globalNokos.cachedCountries[serviceId] || [];
    if (countries.length === 0) return ctx.editMessageCaption("❌ Negara tidak tersedia.", { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{text: "🔙 Kembali", callback_data: "choose_service"}]] } });

    const slice = countries.slice(0, 20);
    
    const buttons = slice.map(c => [{
      text: `${c.name} (${c.stock_total})`,
      callback_data: `country_${serviceId}_${c.iso_code}_${c.number_id}`
    }]);

    buttons.push([{ text: "🔙 Kembali", callback_data: "choose_service" }]);

    await ctx.editMessageCaption(`<b>🌍 PILIH NEGARA</b>\nLayanan ID: ${serviceId}`, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (e) {
    ctx.answerCbQuery("Error memuat negara");
  }
});

bot.action(/country_(.+)_(.+)_(.+)/, async (ctx) => {
  const [_, serviceId, iso, numberId] = ctx.match;
  const apiKey = config.RUMAHOTP;
  const untung = config.UNTUNG_NOKOS || 500;

  await ctx.editMessageCaption("⏳ <b>Memuat harga...</b>", { parse_mode: "HTML" }).catch(() => {});

  try {
    let countryData = globalNokos.cachedCountries[serviceId]?.find(c => String(c.number_id) === String(numberId));
    
    if (!countryData) {
       const res = await axios.get(`https://www.rumahotp.com/api/v2/countries?service_id=${serviceId}`, { headers: { "x-apikey": apiKey } });
       countryData = res.data.data.find(c => String(c.number_id) === String(numberId));
    }

    if (!countryData) return ctx.answerCbQuery("Negara data error");

    const providers = (countryData.pricelist || [])
      .filter(p => p.available && p.stock > 0)
      .map(p => {
        const finalPrice = (parseInt(p.price) || 0) + untung;
        return { ...p, finalPrice };
      })
      .sort((a, b) => a.finalPrice - b.finalPrice);

    if (providers.length === 0) return ctx.editMessageCaption("❌ Stok kosong untuk negara ini.", { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{text: "🔙 Kembali", callback_data: `service_${serviceId}`}]] } });

    const buttons = providers.map(p => [{
      text: `${toRupiah(p.finalPrice)} (Stok: ${p.stock})`,
      callback_data: `buy_nokos_${numberId}_${p.provider_id}_${serviceId}_${p.finalPrice}`
    }]);

    buttons.push([{ text: "🔙 Kembali", callback_data: `service_${serviceId}` }]);

    await ctx.editMessageCaption(`<b>💵 PILIH HARGA</b>\nNegara: ${countryData.name}\n\nPilih harga terbaik:`, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons }
    });

  } catch (e) {
    ctx.answerCbQuery("Gagal memuat harga");
  }
});

bot.action(/buy_nokos_(.+)_(.+)_(.+)_(.+)/, async (ctx) => {
  const [_, numberId, providerId, serviceId, price] = ctx.match;
  
  const buttons = [
    [{ text: "✅ Konfirmasi Beli (Random Operator)", callback_data: `confirm_nokos_${numberId}_${providerId}_${serviceId}_any_${price}` }],
    [{ text: "📡 Pilih Operator Tertentu", callback_data: `operator_${numberId}_${providerId}_${serviceId}_${price}` }],
    [{ text: "🔙 Batal", callback_data: "choose_service" }]
  ];

  await ctx.editMessageCaption(`<b>🛒 KONFIRMASI ORDER</b>\n\n💰 Harga: ${toRupiah(price)}\n\nLanjutkan pembelian?`, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons }
  });
});

bot.action(/operator_(.+)_(.+)_(.+)_(.+)/, async (ctx) => {
  const [_, numberId, providerId, serviceId, price] = ctx.match;
  const apiKey = config.RUMAHOTP;

  try {
     const countryData = globalNokos.cachedCountries[serviceId]?.find(c => String(c.number_id) === String(numberId));
     if (!countryData) return ctx.answerCbQuery("Data negara hilang, ulangi dari awal.");

     const res = await axios.get(`https://www.rumahotp.com/api/v2/operators?country=${encodeURIComponent(countryData.name)}&provider_id=${providerId}`, { headers: { "x-apikey": apiKey } });
     
     const ops = res.data.data || [];
     if(ops.length === 0) return ctx.answerCbQuery("Operator spesifik tidak tersedia, gunakan random.");

     const buttons = ops.map(op => [{
        text: op.name,
        callback_data: `confirm_nokos_${numberId}_${providerId}_${serviceId}_${op.id}_${price}`
     }]);
     buttons.push([{text: "🔙 Kembali", callback_data: `buy_nokos_${numberId}_${providerId}_${serviceId}_${price}`}]);

     await ctx.editMessageCaption(`<b>📡 PILIH OPERATOR</b>\nProvider ID: ${providerId}`, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buttons }
     });

  } catch(e) {
     ctx.answerCbQuery("Gagal load operator");
  }
});

bot.action(/confirm_nokos_(.+)_(.+)_(.+)_(.+)_(.+)/, async (ctx) => {
  const [_, numberId, providerId, serviceId, operatorId, priceStr] = ctx.match;
  const price = parseInt(priceStr);
  const userId = ctx.from.id;
  const apiKey = config.RUMAHOTP;
  const dbPath = "./database/saldoOtp.json";

  const saldoData = JSON.parse(fs.readFileSync(dbPath, "utf8") || "{}");
  const userSaldo = saldoData[userId] || 0;

  if (userSaldo < price) {
    return ctx.answerCbQuery("❌ Saldo tidak cukup!", { show_alert: true });
  }

  await ctx.editMessageCaption("⏳ <b>Memproses order ke server...</b>", { parse_mode: "HTML" }).catch(()=>{});

  try {
    saldoData[userId] = userSaldo - price;
    fs.writeFileSync(dbPath, JSON.stringify(saldoData, null, 2));

    let url = `https://www.rumahotp.com/api/v2/orders?number_id=${numberId}&provider_id=${providerId}`;
    if (operatorId && operatorId !== 'any') {
        url += `&operator_id=${operatorId}`;
    }

    const res = await axios.get(url, { headers: { "x-apikey": apiKey } });

    if (!res.data.success) {
      saldoData[userId] += price;
      fs.writeFileSync(dbPath, JSON.stringify(saldoData, null, 2));
      
      const errMsg = res.data.message || "Stok habis / Gangguan Provider";
      return ctx.editMessageCaption(`❌ <b>Order Gagal:</b> ${errMsg}\n💰 Saldo dikembalikan.`, { 
          parse_mode: "HTML", 
          reply_markup: { inline_keyboard: [[{text:"🔙 Menu", callback_data:"choose_service"}]] } 
      });
    }

    const d = res.data.data;
    
    globalNokos.activeOrders[d.order_id] = {
      userId,
      price,
      messageId: ctx.callbackQuery.message.message_id,
      startTime: Date.now()
    };

    const text = `✅ <b>ORDER BERHASIL</b>\n\n🆔 ID: <code>${d.order_id}</code>\n📞 No: <code>${d.phone_number}</code>\n📱 App: ${d.service}\n💰 Harga: ${toRupiah(price)}\n\n⏳ <i>Menunggu SMS OTP...</i>`;

    await ctx.editMessageCaption(text, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📩 Cek Kode SMS", callback_data: `check_sms_${d.order_id}` }],
          [{ text: "❌ Batalkan Pesanan", callback_data: `cancel_sms_${d.order_id}` }]
        ]
      }
    });

    const expireTime = (d.expires_in_minute || 20) * 60 * 1000;
    
    setTimeout(async () => {
       if (globalNokos.activeOrders[d.order_id]) {
           try {
               const cek = await axios.get(`https://www.rumahotp.com/api/v1/orders/get_status?order_id=${d.order_id}`, { headers: { "x-apikey": apiKey } });
               const st = cek.data.data;

               if (st.status !== 'completed' && (!st.otp_code || st.otp_code === '-')) {
                   await axios.get(`https://www.rumahotp.com/api/v1/orders/set_status?order_id=${d.order_id}&status=cancel`, { headers: { "x-apikey": apiKey } });
                   
                   const curSaldo = JSON.parse(fs.readFileSync(dbPath, "utf8"));
                   curSaldo[userId] = (curSaldo[userId] || 0) + price;
                   fs.writeFileSync(dbPath, JSON.stringify(curSaldo, null, 2));

                   bot.telegram.sendMessage(userId, `⌛ <b>Order Expired/Timeout</b>\nID: ${d.order_id}\nSaldo Rp ${toRupiah(price)} dikembalikan.`, {parse_mode:"HTML"});
                   
                   delete globalNokos.activeOrders[d.order_id];
               }
           } catch(e) { console.log("Auto cancel error", e.message); }
       }
    }, expireTime);

  } catch (e) {
    console.error("Order Sys Error:", e);
    const curSaldo = JSON.parse(fs.readFileSync(dbPath, "utf8"));
    curSaldo[userId] = (curSaldo[userId] || 0) + price;
    fs.writeFileSync(dbPath, JSON.stringify(curSaldo, null, 2));
    ctx.editMessageCaption(`❌ <b>System Error:</b> ${e.message}`);
  }
});

bot.action(/check_sms_(.+)/, async (ctx) => {
  const orderId = ctx.match[1];
  const apiKey = config.RUMAHOTP;

  try {
    const res = await axios.get(`https://www.rumahotp.com/api/v1/orders/get_status?order_id=${orderId}`, {
       headers: { "x-apikey": apiKey }
    });

    const d = res.data.data;
    const status = d.status.toLowerCase();

    if (status === "completed" || (d.otp_code && d.otp_code !== "-")) {
       // ==============================
       // ==== TAMBAHAN FITUR LO ====
       // ==============================
       let orderPrice = 0;
       if (globalNokos.activeOrders[orderId]) {
          orderPrice = globalNokos.activeOrders[orderId].price || 0;
       }

       // SAVE TO database.json/orders
       const ordersPath = "./database/database.json";
       let ordersData = { orders: [] };
       try {
         if (fs.existsSync(ordersPath)) {
           const raw = fs.readFileSync(ordersPath, "utf8");
           ordersData = JSON.parse(raw);
           if (!ordersData.orders) ordersData.orders = [];
         }
       } catch (err) {
         console.error("Gagal baca database.json:", err.message);
       }

       const newOrder = {
         order_id: d.order_id,
         userId: ctx.from.id,
         userName: ctx.from.first_name || "",
         product: d.service,
         phone_number: d.phone_number,
         amount: orderPrice,
         otp_code: d.otp_code,
         timestamp: new Date().toISOString()
       };

       ordersData.orders.push(newOrder);

       try {
         fs.writeFileSync(ordersPath, JSON.stringify(ordersData, null, 2));
         console.log("[SUCCESS] Order tersimpan di database.json/orders");
       } catch (err) {
         console.error("Gagal simpan order ke database.json:", err.message);
       }

       // AUTO POST KE CHANNEL TESTIMONI
       sendTestimoniKeChannel(ctx.from.first_name || "User", ctx.from.id, d.service, newOrder.amount)
         .catch(err => console.error("Gagal kirim testimoni:", err.message));
       // ==============================

       if (globalNokos.activeOrders[orderId]) delete globalNokos.activeOrders[orderId];
       
       await ctx.editMessageCaption(
           `✅ <b>SMS DITERIMA!</b>\n\n📞 No: <code>${d.phone_number}</code>\n💬 <b>OTP:</b> <code>${d.otp_code}</code>\n\n<i>Transaksi Selesai.</i>`, 
           { parse_mode: "HTML" }
       );
       return;
    } 
    
    if (status === 'processing' || status === 'waiting' || status === 'pending') {
       const sisaWaktu = d.expires_in ? `(${d.expires_in}s)` : "";
       return ctx.answerCbQuery(`⏳ SMS Belum masuk.. Tunggu sebentar lagi! ${sisaWaktu}`, { show_alert: false });
    } 
    
    if (status === 'cancelled' || status === 'expired') {
       if (globalNokos.activeOrders[orderId]) delete globalNokos.activeOrders[orderId];
       await ctx.editMessageCaption(`❌ <b>Order Dibatalkan/Expired.</b>`, { parse_mode: "HTML" });
       return;
    }

    await ctx.answerCbQuery(`Status: ${status}`);

  } catch(e) {
    console.error("Check SMS Error:", e.message);
    ctx.answerCbQuery("⚠️ Gagal cek status API.");
  }
});

bot.action(/cancel_sms_(.+)/, async (ctx) => {
  const orderId = ctx.match[1];
  const apiKey = config.RUMAHOTP;
  const userId = ctx.from.id;

  let orderInfo = globalNokos.activeOrders[orderId];

  try {
    const res = await axios.get(`https://www.rumahotp.com/api/v1/orders/set_status?order_id=${orderId}&status=cancel`, {
       headers: { "x-apikey": apiKey }
    });

    if (res.data.success) {
       let msgRefund = "";

       if (orderInfo) {
          const dbPath = "./database/saldoOtp.json";
          const saldoData = JSON.parse(fs.readFileSync(dbPath, "utf8") || "{}");
          
          saldoData[userId] = (saldoData[userId] || 0) + orderInfo.price;
          fs.writeFileSync(dbPath, JSON.stringify(saldoData, null, 2));
          
          delete globalNokos.activeOrders[orderId];
          msgRefund = `\n💰 Saldo Rp ${toRupiah(orderInfo.price)} telah dikembalikan.`;
       } else {
          msgRefund = "\n⚠️ Data lokal hilang (bot restart), saldo tidak otomatis kembali. Hubungi Admin.";
       }

       await ctx.editMessageCaption(`✅ <b>Order Berhasil Dibatalkan.</b>${msgRefund}`, { 
           parse_mode: "HTML", 
           reply_markup: { inline_keyboard: [[{text:"🔙 Menu Utama", callback_data:"choose_service"}]] } 
       });

    } else {
       ctx.answerCbQuery("❌ Gagal cancel: " + (res.data.message || "Mungkin sudah expired/completed."));
    }
  } catch(e) {
    console.error("Cancel Error:", e.message);
    ctx.answerCbQuery("❌ Terjadi kesalahan API.");
  }
});

bot.action("topup_nokos", async (ctx) => {
  userState[ctx.from.id] = { step: "WAITING_TOPUP_RUMAHOTP" };
  await editMenuMessage(ctx, 
    "<b>💳 DEPOSIT QRIS</b>\n\nSilakan kirim nominal deposit (Hanya Angka).\nMinimal: Rp 2.000\nContoh: <code>10000</code>", 
    { 
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{text: "❌ Batal", callback_data: "back_home"}]] }
    }
  );
});

bot.action(/batal_depo_rumahotp_(.+)/, async (ctx) => {
   const depoId = ctx.match[1];
   const apiKey = config.RUMAHOTP;
   try {
     await axios.get(`https://www.rumahotp.com/api/v1/deposit/cancel?deposit_id=${depoId}`, { headers: { "x-apikey": apiKey } });
     await ctx.deleteMessage();
     await ctx.reply("✅ Deposit dibatalkan.", {reply_markup: {inline_keyboard: [[{text:"🔙 Menu", callback_data:"back_home"}]]}});
   } catch(e) {
     ctx.answerCbQuery("Gagal batal");
   }
});



bot.on('audio', async (ctx) => {
  console.log('Audio File ID:', ctx.message.audio.file_id);
  console.log('Audio Metadata:', {
    title: ctx.message.audio.title,
    performer: ctx.message.audio.performer,
    duration: ctx.message.audio.duration
  });
});

bot.on("text", async (ctx, next) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;

  if (["📁 ☇ 𝗦𝗰𝗿𝗶𝗽𝘁", "📱 ☇ 𝗔𝗽𝗽𝘀", "📡 ☇ 𝗣𝗮𝗻𝗲𝗹", "🛠 ☇ 𝗧𝗼𝗼𝗹𝘀", "🌸 ☇ 𝗢𝘄𝗻𝗲𝗿"].includes(text)) {
    return next();
  }
  if (userState[userId]?.step === "WAITING_WD_RUMAHOTP_NOMINAL") {
    const nominal = parseInt(text.replace(/[^0-9]/g, ''));

    if (isNaN(nominal) || nominal < 1000) {
      return safeReply(ctx, "<blockquote>❌ <b>Nominal tidak valid!</b>\nMasukkan angka saja (Min 1000).</blockquote>", { parse_mode: "HTML" });
    }

    delete userState[userId];

    const waitMsg = await safeReply(ctx, "⏳ <b>Sedang menembak API H2H RumahOTP...</b>", { parse_mode: "HTML" });

    try {
      const res = await rumahOtpTransfer(nominal, config);

      const trxId = res.data?.id || res.id || "Unknown";
      const status = res.data?.status || res.status || "Pending";
      const message = res.message || "Permintaan dikirim";

      let replyText = `<blockquote>✅ <b>WD SUKSES!</b>\n\n`;
      replyText += `<b>Nominal:</b> ${toRupiah(nominal)}\n`;
      replyText += `<b>Tujuan:</b> ${config.wd_balance.destination_number} (${config.wd_balance.bank_code})\n`;
      replyText += `<b>Trx ID:</b> <code>${trxId}</code>\n`;
      replyText += `<b>Status:</b> <code>${status.toUpperCase()}</code>\n`;
      replyText += `<b>Note:</b> ${message}</blockquote>`;

      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, replyText, {
        parse_mode: "HTML",
        reply_markup: {
            inline_keyboard: [[{ text: "🔙 Menu Owner", callback_data: "menu_owner" }]]
        }
      });

    } catch (err) {
      console.error("WD RumahOTP Fail:", err);

      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null,
        `<blockquote>❌ <b>GAGAL WD</b>\n\n<b>Error:</b> ${err.message}\n\n<i>Pastikan saldo RumahOTP cukup dan Endpoint API benar.</i></blockquote>`,
        {
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [[{ text: "🔙 Menu Owner", callback_data: "menu_owner" }]]
            }
        }
      );
    }
    return;
  }
  
  if (userState[userId]?.step === "WAITING_TOPUP_RUMAHOTP") {
    const amount = parseInt(text);
    if (isNaN(amount) || amount < 2000) {
       return safeReply(ctx, "❌ Minimal deposit Rp 2.000 dan harus angka!");
    }
    
    delete userState[userId];

    const loading = await safeReply(ctx, "🔄 <b>Membuat QRIS...</b>", { parse_mode: "HTML" });
    const apiKey = config.RUMAHOTP;
    const fee = config.UNTUNG_DEPOSIT || 500;
    const totalRequest = amount + fee;

        try {
       const res = await axios.get(`https://www.rumahotp.com/api/v2/deposit/create?amount=${totalRequest}&payment_id=qris`, {
          headers: { "x-apikey": apiKey }
       });
       
       await ctx.deleteMessage(loading.message_id).catch(()=>{});

       if (!res.data.success) {
          return safeReply(ctx, "❌ Gagal membuat QRIS. Coba lagi nanti.");
       }

       const d = res.data.data;
       const caption = `<b>💳 TAGIHAN DEPOSIT</b>\n\n🆔 ID: <code>${d.id}</code>\n💰 Total Bayar: <b>Rp ${toRupiah(d.total)}</b>\n(Termasuk biaya admin)\n\n📥 Masuk Saldo: Rp ${toRupiah(amount)}\n\n⚠️ <b>Bayar sesuai nominal TOTAL (sampai digit terakhir)!</b>\nOtomatis cek status...`;
       
       const msgQris = await ctx.replyWithPhoto(d.qr_image, {
          caption: caption,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{text: "❌ Batalkan", callback_data: `batal_depo_rumahotp_${d.id}`}]] }
       });

       let checks = 0;
       const maxChecks = 120;
       const checkInterval = setInterval(async () => {
          checks++;
          if (checks > maxChecks) {
             clearInterval(checkInterval);
             return;
          }

          try {
             const checkRes = await axios.get(`https://www.rumahotp.com/api/v2/deposit/get_status?deposit_id=${d.id}`, { headers: { "x-apikey": apiKey } });
             
             if (checkRes.data && checkRes.data.success) {
                 const status = checkRes.data.data.status;

                 if (status === 'success' || status === 'paid') {
                     clearInterval(checkInterval);
                     
                     const dbPath = "./database/saldoOtp.json";
                     let saldoDB = {};
                     try { saldoDB = JSON.parse(fs.readFileSync(dbPath, "utf8")); } catch(e){}
                     
                     saldoDB[userId] = (saldoDB[userId] || 0) + amount;
                     fs.writeFileSync(dbPath, JSON.stringify(saldoDB, null, 2));
                     
                     await ctx.deleteMessage(msgQris.message_id).catch(()=>{});
                     await ctx.reply(`✅ <b>DEPOSIT SUKSES!</b>\n\n💰 Diterima: Rp ${toRupiah(amount)}\n💼 Total Saldo: Rp ${toRupiah(saldoDB[userId])}`, { parse_mode: "HTML" });
                     
                     bot.telegram.sendMessage(config.ownerId, `🔔 User ${userId} Deposit Rp ${amount} via RumahOTP`).catch(()=>{});

                 } else if (status === 'cancelled' || status === 'failed') {
                     clearInterval(checkInterval);
                     await ctx.deleteMessage(msgQris.message_id).catch(()=>{});
                     await ctx.reply("❌ Deposit dibatalkan/gagal.");
                 }
             }
          } catch(e) { 
              console.log("Error cek deposit:", e.message);
          }
       }, 5000);

    } catch(e) {
       console.error(e);
       safeReply(ctx, "❌ Error API RumahOTP");
    }
    return;
  }
  
  
  if (userState[ctx.from.id]?.step === "WAITING_BROADCAST" && ctx.from.id === config.ownerId) {
    const users = loadUsers();
    let sent = 0;
    for (const uid of users) {
      try {
        if (ctx.message.photo) {
          await bot.telegram.sendPhoto(uid, ctx.message.photo[0].file_id, { caption: ctx.message.caption || "", parse_mode: "HTML" });
        } else if (ctx.message.document) {
          await bot.telegram.sendDocument(uid, ctx.message.document.file_id, { caption: ctx.message.caption || "", parse_mode: "HTML" });
        } else {
          await bot.telegram.sendMessage(uid, ctx.message.text);
        }
        sent++;
      } catch (e) {}
    }
    delete userState[ctx.from.id];
    return safeReply(ctx, `<blockquote>📢 <b>Broadcast selesai!</b> <b>Terkirim:</b> ${sent}</blockquote>`, { parse_mode: "HTML" });
  }

  return next();
});




bot.action("wd_rumahotp_start", async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;

  const infoWd = config.wd_balance || {};

  userState[ctx.from.id] = { step: "WAITING_WD_RUMAHOTP_NOMINAL" };

  await editMenuMessage(ctx,
    `<blockquote><b>🏦 CAIRKAN RUMAHOTP (H2H)</b>\n\n` +
    `<b>Tujuan WD (Config):</b>\n` +
    `Bank: <code>${infoWd.bank_code || '-'}</code>\n` +
    `No: <code>${infoWd.destination_number || '-'}</code>\n` +
    `A/N: <code>${infoWd.destination_name || '-'}</code>\n\n` +
    `<i>Silakan ketik nominal yang ingin dicairkan (Angka saja).</i>\n` +
    `<i>Contoh: 50000</i></blockquote>`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "❌ Batalkan", callback_data: "menu_owner" }]
        ]
      }
    }
  );
});

bot.command(["withdraw", "wd"], async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;

  const args = ctx.message.text.split(" ");
  const nominal = parseInt(args[1]);

  if (!nominal || isNaN(nominal) || nominal < 1000) {
    return ctx.reply("<blockquote>💰 <b>Gunakan:</b> <code>/withdraw [nominal]</code>\nMinimal Rp 1.000</blockquote>", { parse_mode: "HTML" });
  }

  try {
    const waitMsg = await ctx.reply("⏳ <b>Memproses withdraw...</b>", { parse_mode: "HTML" });
    
    const atlConfig = {
      apiAtlantic: config.ApikeyAtlantic,
      wd_balance: config.wd_balance
    };

    const res = await atlanticTransfer(nominal, atlConfig);

    if (!res.status) throw new Error(res.message);

    const data = res.data;
    const caption = `<blockquote>✅ <b>PERMINTAAN WITHDRAW DIBUAT</b>\n\n` +
      `<b>Reff ID:</b> <code>${data.reff_id}</code>\n` +
      `<b>Transfer ID:</b> <code>${data.id}</code>\n` +
      `<b>Tujuan:</b> ${data.nomor_tujuan} (${data.nama})\n` +
      `<b>Nominal:</b> ${toRupiah(data.nominal)}\n` +
      `<b>Fee:</b> ${toRupiah(data.fee)}\n\n` +
      `<i>Menunggu konfirmasi transfer...</i></blockquote>`;

    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, caption, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Cek Status WD", `check_wd_${data.id}`)]
      ])
    });

  } catch (err) {
    ctx.reply(`❌ <b>Error:</b> ${err.message}`, { parse_mode: "HTML" });
  }
});

bot.action(/check_wd_(.+)/, async (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("Bukan Owner!");
  const wdId = ctx.match[1];
  
  try {
    const res = await atlanticTransferStatus(wdId, config.ApikeyAtlantic);
    const status = res.data?.status || "processing";
    
    await ctx.answerCbQuery(`Status: ${status.toUpperCase()}`);
    
    if (status === "success") {
      await ctx.editMessageCaption(`<blockquote>✅ <b>WD BERHASIL!</b>\nID: <code>${wdId}</code>\nStatus: <b>SUCCESS</b></blockquote>`, { parse_mode: "HTML" });
    }
  } catch (e) {
    ctx.answerCbQuery("Gagal cek status.");
  }
});

bot.action("menu_wd_info", (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner yang bisa melihat info WD!", { show_alert: true });
  }
  
  function sensorString(input, visibleCount = 3, maskChar = 'X') {
    if (!input || input.length <= visibleCount) return input || "Tidak tersedia";
    const visiblePart = input.slice(0, visibleCount);
    const maskedPart = maskChar.repeat(input.length - visibleCount);
    return visiblePart + maskedPart;
  }
  
  function sensorWithSpace(str, visibleCount = 3, maskChar = 'X') {
    if (!str) return "Tidak tersedia";
    let result = '';
    let count = 0;
    for (let char of str) {
      if (char === ' ') {
        result += char;
      } else if (count < visibleCount) { 
        result += char; 
        count++; 
      } else {
        result += maskChar;
      }
    }
    return result;
  }
  
  const wdInfo = config.wd_balance || {};
  
  const infoText = `<blockquote><b>💰 INFO WITHDRAW</b>\n\n` +
    `<b>Bank/E-Wallet:</b> ${wdInfo.bank_code || "Belum diatur"}\n` +
    `<b>Tujuan:</b> ${sensorString(wdInfo.destination_number)}\n` +
    `<b>Nama:</b> ${sensorWithSpace(wdInfo.destination_name)}\n\n` +
    `Ketik <code>/withdraw [jumlah]</code> untuk menarik saldo.\n` +
    `<b>Contoh:</b> <code>/withdraw 50000</code>\n` +
    `<b>Minimal:</b> Rp 1.000</blockquote>`;
  
  ctx.editMessageText(infoText, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔙 Kembali", callback_data: "menu_owner" }]
      ]
    }
  }).catch(() => {
    ctx.reply(infoText, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Kembali", callback_data: "menu_owner" }]
        ]
      }
    });
  });
  
  ctx.answerCbQuery();
});

bot.command("cancel", (ctx) => cancelTransaction(ctx));
bot.action("cancel_trx", (ctx) => cancelTransaction(ctx));
async function cancelTransaction(ctx) {
  const userId = ctx.from.id;
  
  if (activeTransactions[userId]) {
    try {
      if (activeTransactions[userId].messageId) {
        await ctx.deleteMessage(activeTransactions[userId].messageId).catch(() => {});
      }
    } catch (e) {}
    
    delete activeTransactions[userId];
    
    if (userState[userId]) {
      delete userState[userId];
    }
    
    await safeReply(ctx, "<blockquote>✅ <b>Transaksi dibatalkan.</b></blockquote>", { parse_mode: "HTML" });
  } else {
    await safeReply(ctx, "<blockquote>⚠️ <b>Tidak ada transaksi aktif.</b></blockquote>", { parse_mode: "HTML" });
  }
  
  if (ctx.updateType === 'callback_query') {
    try {
      await ctx.answerCbQuery();
    } catch (e) {}
  }
}




bot.catch((err, ctx) => {
    console.error("Bot Error:", err);
    safeReply(ctx, "<blockquote>❌ <b>Terjadi kesalahan.</b></blockquote>", { parse_mode: "HTML" });
});

bot.launch().then(() => {
  console.log("🤖 Bot Berjalan!");
  
  setTimeout(() => {
    console.log("[INFO] Mengirim backup startup ke owner...");
    createAndSendFullBackup(null, true);
  }, 10000);

  const INTERVAL_BACKUP = 2 * 60 * 60 * 1000; 
  
  setInterval(() => {
    console.log("[INFO] Menjalankan Auto Backup Berkala...");
    createAndSendFullBackup(null, true);
  }, INTERVAL_BACKUP);
});

process.once('SIGINT', () => bot.stop('SIGINT')); 
process.once('SIGTERM', () => bot.stop('SIGTERM'));