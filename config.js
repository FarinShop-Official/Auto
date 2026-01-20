const fs = require("fs");
const chalk = require("chalk");

module.exports = {
TOKEN: "8084526858:AAHGZ2hVK_7mzO-eMBnirdG-WqSEkK-n9Oo", // Token dari @BotFather
OWNER_ID: "7355538049", // ID Telegram owner
urladmin: "https://t.me/farinmodssv2",
urlchannel: "https://t.me/farinmods",
idchannel: "-1003516831914", // isi id channel untung notifikasi
botName: "Farin Shop Auto Order",
version: "1.0.0",
authorName: "@FarinShop_bot",
ownerName: "Farin",
  
//==============================================[ SETTING IMAGE ]=======//
ppthumb: "https://i.ibb.co/pjDfdk9d/file-000000002ae072078ebda61e55840b15.png",       // Foto utama bot (/start)
id_channel_price: "-1003032034957",
//==============================================[ SETTING OTPNUM ]=======//
RUMAHOTPV2: "otp_nzlMXdTwupWlVJTL", //token sama seperti di bawah 
RUMAHOTP: "otp_nzlMXdTwupWlVJTL",
nomor_pencairan_RUMAHOTP: "hh", // masi dalam masa percobaan
type_ewallet_RUMAHOTP: "dana", // masi dalam masa percobaan
atas_nama_ewallet_RUMAHOTP: "aisyah", // masi dalam masa percobaan
UNTUNG_NOKOS: 1000,
UNTUNG_DEPOSIT: 450,

};

// 🔁 Auto reload jika file config.js diubah
let file = require.resolve(__filename);
fs.watchFile(file, () => {
  fs.unwatchFile(file);
  console.log(chalk.blue(">> Update File :"), chalk.black.bgWhite(`${__filename}`));
  delete require.cache[file];
  require(file);
});
