const axios = require("axios");
const qs = require("qs");

const APIGATEWAY_ORKUT = "https://api-ralzz.vercel.app/orderkuota";
const ATL_BASE = "https://atlantich2h.com";

const toRupiah = (angka) => {
  return Number(angka).toLocaleString("id-ID", {
    style: "currency",
    currency: "IDR",
    minimumFractionDigits: 0
  }).replace("IDR", "Rp").trim();
};

function generateReffId() {
  const rand = Math.random().toString(36).slice(2, 10).toUpperCase();
  return `TRX-${Date.now()}-${rand}`;
}

async function downloadQrisImage(url) {
  try {
    if (!url || !url.startsWith('http')) return null;
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'arraybuffer',
      timeout: 10000, 
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://atlantich2h.com/'
      }
    });
    return Buffer.from(response.data);
  } catch (error) {
    return null;
  }
}

async function jembud(id, config) {
  try {
    console.log(`[DEBUG] Triggering Instant Check for ID: ${id}`);
    await axios.post(
      `${ATL_BASE}/deposit/instant`,
      qs.stringify({
        api_key: config.apiAtlantic,
        id: String(id),
        action: 'true'
      }),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 5000
      }
    );
  } catch (e) {
    console.log(`[DEBUG] Instant Check Trigger Fail (Normal if already success)`);
  }
}

async function createdQris(harga, config) {
  const amount = Number(harga);

  // ================= ATLANTIC =================
  if (config.method === "atlantic") {
    try {
      const reffId = generateReffId();
      const body = {
        api_key: config.apiAtlantic,
        reff_id: reffId,
        nominal: amount,
        type: "ewallet",
        metode: "QRIS",
      };

      const res = await axios.post(
        `${ATL_BASE}/deposit/create`,
        qs.stringify(body),
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          timeout: 15000
        }
      );

      if (!res.data?.data) return null;

      const d = res.data.data;
      
      return {
        idtransaksi: d.id, 
        jumlah: amount,
        imageqris: d.qr_image || "",
        qr_string: d.qr_string || "",
        nominal: amount,
      };

    } catch (e) {
      console.error("[ATLANTIC CREATE ERROR]", e.response?.data || e.message);
      return null;
    }
  }

  // ================= ORKUT =================
  try {
    const url = `${APIGATEWAY_ORKUT}/createpayment?apikey=${config.apikey}&amount=${amount}&username=${config.username}&token=${config.token}`;
    const { data } = await axios.get(url);

    if (!data?.result) return null;

    return {
      idtransaksi: data.result.idtransaksi,
      jumlah: data.result.jumlah,
      imageqris: data.result.imageqris?.url || "",
      qr_string: data.result.qr_string || "",
      nominal: amount,
    };
  } catch (e) {
    console.error("[ORKUT CREATE ERROR]", e.message);
    return null;
  }
}

// ================= CEK STATUS (SUDAH DIPERBAIKI) =================
async function cekStatus(id, amount, config) {

  // ================= ATLANTIC =================
  if (config.method === "atlantic") {
    try {
      const res = await axios.post(
        `${ATL_BASE}/deposit/status`,
        qs.stringify({
          api_key: config.apiAtlantic,
          id: String(id),
        }),
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          timeout: 10000
        }
      );

      const status = res.data?.data?.status?.toLowerCase();
      console.log(`[DEBUG] Status Atlantic ID ${id}: ${status}`);

      if (status === "success") {
        return true;
      }

      if (status === "processing") {
        await jembud(id, config);
        return false; 
      }

      return false;

    } catch (e) {
      console.error("[ATLANTIC STATUS ERROR]", e.message);
      return false;
    }
  }

  // ================= ORKUT =================
  try {
    const url = `${APIGATEWAY_ORKUT}/mutasiqr?apikey=${config.apikey}&username=${config.username}&token=${config.token}`;
    const { data } = await axios.get(url);

    const list = data?.result;
    if (!Array.isArray(list)) return false;

    return list.some(i => {
      const kredit = parseInt(i.kredit.toString().replace(/[^0-9]/g, ""));
      return kredit === parseInt(amount);
    });

  } catch (e) {
    return false;
  }
}

module.exports = {
  createdQris,
  cekStatus,
  toRupiah,
  downloadQrisImage 
};