"use strict";

/**
 * BIKA Character Catcher Bot —
 */

require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const { Telegraf, Markup } = require("telegraf");

// -------------------- ENV --------------------
const BOT_TOKEN = String(process.env.BOT_TOKEN || "").trim();
const MONGODB_URI = String(process.env.MONGODB_URI || "").trim();
const OWNER_ID = Number(process.env.OWNER_ID || 0);
const OWNER_USERNAME = String(process.env.OWNER_USERNAME || "@Official_Bika").trim();
const PORT = Number(process.env.PORT || 8080);
const NODE_ENV = String(process.env.NODE_ENV || "production").trim();
const MESSAGE_DROP_COUNT = Math.max(1, Number(process.env.MESSAGE_DROP_COUNT || 50));
const HAREM_PAGE_SIZE = Math.max(1, Number(process.env.HAREM_PAGE_SIZE || 5));
const ADMIN_IDS = String(process.env.ADMIN_IDS || "")
  .split(",")
  .map((x) => Number(String(x).trim()))
  .filter((x) => Number.isFinite(x) && x > 0);

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN in .env");
if (!MONGODB_URI) throw new Error("Missing MONGODB_URI in .env");
if (!OWNER_ID) throw new Error("Missing OWNER_ID in .env");

// -------------------- APP / BOT --------------------
const app = express();
app.use(express.json({ limit: "1mb" }));

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 60_000 });
const START_TIME = Date.now();

// -------------------- CONSTANTS --------------------
const RARITY_ORDER = [
  "Supreme",
  "Cataphract",
  "CrossVerse",
  "Divine",
  "Mystical",
  "Legendary",
  "Rare",
  "Uncommon",
  "Common",
];

const RARITY_EMOJI = {
  Supreme: "🪞",
  Cataphract: "✨",
  CrossVerse: "⚡",
  Divine: "⚜️",
  Mystical: "🌸",
  Legendary: "🟡",
  Rare: "🟠",
  Uncommon: "🟣",
  Common: "🔵",
};

const RARITY_EXP = {
  Supreme: 100,
  Cataphract: 60,
  CrossVerse: 35,
  Divine: 20,
  Mystical: 12,
  Legendary: 7,
  Rare: 4,
  Uncommon: 2,
  Common: 1,
};

// -------------------- HELPERS --------------------
function isOwner(userId) {
  return Number(userId) === OWNER_ID;
}

function isAdmin(userId) {
  return isOwner(userId) || ADMIN_IDS.includes(Number(userId));
}

function escapeHtml(text = "") {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function mentionUser(user) {
  const first = escapeHtml(user?.first_name || user?.username || "User");
  return `<a href="tg://user?id=${user?.id}">${first}</a>`;
}

function normalizeName(text = "") {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s\-]/g, "");
}

function safeChatTitle(chat) {
  return chat?.title || chat?.username || String(chat?.id || "Unknown");
}

function uptimeText(ms) {
  const sec = Math.floor(ms / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${d}d ${h}h ${m}m ${s}s`;
}

function getLevelFromExp(exp) {
  const total = Math.max(0, Number(exp || 0));
  let level = 1;
  let need = 30;
  let used = 0;

  while (total >= used + need) {
    used += need;
    level += 1;
    need = 30 + (level - 1) * 20;
  }

  const currentInto = total - used;
  const currentNeed = need;
  return {
    level,
    currentInto,
    currentNeed,
    progressPercent: Math.max(0, Math.min(100, Math.floor((currentInto / currentNeed) * 100))),
  };
}

function makeProgressBar(percent, size = 10) {
  const filled = Math.max(0, Math.min(size, Math.round((percent / 100) * size)));
  return "█".repeat(filled) + "░".repeat(size - filled);
}

function parseForwardCharacter(rawText = "") {
  const text = String(rawText || "")
    .replace(/\r/g, "")
    .replace(/\u00A0/g, " ")
    .trim();

  if (!text) return null;

  const lines = text
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

  let anime = "";
  let cardId = "";
  let name = "";
  let rarity = "";

  let idLineIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^(\d+)\s*[:：]\s*(.+)$/);
    if (m) {
      cardId = m[1].trim();
      name = m[2].trim();
      idLineIndex = i;
      break;
    }
  }

  if (idLineIndex > 0) {
    for (let i = idLineIndex - 1; i >= 0; i -= 1) {
      const lower = lines[i].toLowerCase();
      if (
        lower.includes("owo! check out this character") ||
        lower.includes("caught how many times") ||
        lower.includes("rarity")
      ) {
        continue;
      }
      anime = lines[i].trim();
      break;
    }
  }

  for (const line of lines) {
    for (const r of RARITY_ORDER) {
      if (new RegExp(`\\b${r}\\b`, "i").test(line)) {
        rarity = r;
        break;
      }
    }
    if (rarity) break;
  }

  if (!anime || !cardId || !name || !rarity) return null;
  return { anime, cardId, name, rarity };
}

function parseAddCaption(caption = "") {
  const firstLine = String(caption).split("\n")[0].trim();
  if (!firstLine.toLowerCase().startsWith("/add")) return null;

  const body = firstLine.slice(4).trim();
  const parts = body.split("|").map((x) => x.trim()).filter(Boolean);
  if (parts.length < 4) return null;

  const [cardIdRaw, name, rarityRaw, anime] = parts;
  const cardId = String(cardIdRaw).trim();
  const rarityNorm = RARITY_ORDER.find(
    (r) => r.toLowerCase() === String(rarityRaw).trim().toLowerCase()
  );

  if (!cardId || !name || !anime || !rarityNorm) return null;
  return { cardId, name, rarity: rarityNorm, anime };
}

function getRarityEmoji(rarity) {
  return RARITY_EMOJI[rarity] || "🎴";
}

async function getGlobalCardStats(cardId) {
  const users = await User.find(
    { "cards.cardId": String(cardId) },
    { userId: 1, username: 1, firstName: 1, cards: 1 }
  ).lean();

  let totalOwned = 0;
  const catchers = [];

  for (const u of users) {
    const card = (u.cards || []).find((c) => c.cardId === String(cardId));
    if (!card) continue;

    const count = Number(card.count || 0);
    totalOwned += count;

    const displayName =
      u.username ? `@${u.username}` :
      u.firstName ? u.firstName :
      `Unknown User (${u.userId})`;

    catchers.push({
      userId: u.userId,
      name: displayName,
      count,
    });
  }

  catchers.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    totalOwned,
    topCatchers: catchers.slice(0, 10),
  };
}

function buildCheckCaption(photoDoc, stats) {
  const rarityEmoji = getRarityEmoji(photoDoc.rarity);

  const lines = [
    `OwO! Check out this character!`,
    ``,
    `${photoDoc.anime}`,
    `${photoDoc.cardId}: ${photoDoc.name}`,
    `(${rarityEmoji} RARITY: ${photoDoc.rarity})`,
    ``,
    `🌍 CAUGHT GLOBALLY: ${stats.totalOwned} TIMES`,
    ``,
    `🏅 TOP 10 CATCHERS OF THIS CHARACTER!`,
  ];

  if (!stats.topCatchers.length) {
    lines.push(`↪ No catch data yet`);
  } else {
    for (const c of stats.topCatchers) {
      lines.push(`↪ ${c.name} x${c.count}`);
    }
  }

  return lines.join("\n");
}

function getRandomItem(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function commandTextMatches(text = "", cmd = "") {
  const t = String(text || "").trim();
  return new RegExp(`^\\/${cmd}(?:@\\w+)?(?:\\s|$)`, "i").test(t);
}

function buildHaremLines(cards = []) {
  const animeMap = new Map();
  for (const c of cards) {
    const anime = c.anime || "Unknown";
    if (!animeMap.has(anime)) animeMap.set(anime, []);
    animeMap.get(anime).push(c);
  }
  return Array.from(animeMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
}

function chunkArray(arr = [], size = 5) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function getFavoriteOrRandomCard(userDoc) {
  const cards = Array.isArray(userDoc?.cards) ? userDoc.cards : [];
  if (!cards.length) return null;
  const fav = userDoc.favoriteCardId
    ? cards.find((c) => c.cardId === String(userDoc.favoriteCardId))
    : null;
  return fav || getRandomItem(cards);
}

function buildHaremCaption(userDoc, page = 1, pageSize = HAREM_PAGE_SIZE) {
  const cards = Array.isArray(userDoc?.cards) ? userDoc.cards : [];
  const grouped = buildHaremLines(cards);
  const pages = chunkArray(grouped, pageSize);
  const totalPages = Math.max(1, pages.length);
  const safePage = Math.max(1, Math.min(page, totalPages));
  const current = pages[safePage - 1] || [];

  const headerName = userDoc?.firstName || userDoc?.username || `User ${userDoc?.userId || ""}`;
  const totalCardsOwned = cards.reduce((a, b) => a + Number(b.count || 0), 0);

  const lines = [];
  lines.push(`📘 ${headerName}'s RECENT CHARACTERS - PAGE: ${safePage}/${totalPages}`);
  lines.push(`🎴 Total Cards: ${totalCardsOwned} | 📚 Total Series: ${grouped.length}`);
  if (userDoc?.favoriteCardId) {
    const fav = cards.find((c) => c.cardId === String(userDoc.favoriteCardId));
    if (fav) lines.push(`💖 Favourite: ${fav.name} [${fav.cardId}]`);
  }
  lines.push("");

  if (!current.length) {
    lines.push("No cards yet.");
  } else {
    for (const [anime, animeCards] of current) {
      const uniqueCount = animeCards.length;
      const totalCount = animeCards.reduce((a, b) => a + Number(b.count || 0), 0);
      lines.push(`⚜️ ${anime} (${uniqueCount}/${totalCount})`);
      lines.push("─────────────────");
      for (const card of animeCards.sort((a, b) => Number(a.cardId) - Number(b.cardId))) {
        const emoji = getRarityEmoji(card.rarity);
        const suffix = Number(card.count || 1) > 1 ? ` × ${Number(card.count || 1)}` : "";
        lines.push(`🍀 ${card.cardId} | ${emoji} | ${card.name}${suffix}`);
      }
      lines.push("");
    }
  }

  return { caption: lines.join("\n").trim(), totalPages, safePage };
}

function buildProfileText(userDoc, totalPhotoCount = 0) {
  const cards = Array.isArray(userDoc?.cards) ? userDoc.cards : [];
  const totalOwned = cards.reduce((a, b) => a + Number(b.count || 0), 0);
  const uniqueOwned = cards.length;
  const haremPercent = totalPhotoCount > 0
    ? ((uniqueOwned / totalPhotoCount) * 100).toFixed(3)
    : "0.000";

  const exp = Number(userDoc?.exp || 0);
  const lv = getLevelFromExp(exp);
  const bar = makeProgressBar(lv.progressPercent, 10);
  const rarityCounts = {};
  for (const r of RARITY_ORDER) rarityCounts[r] = { unique: 0, total: 0 };
  for (const c of cards) {
    const r = c.rarity || "Common";
    if (!rarityCounts[r]) rarityCounts[r] = { unique: 0, total: 0 };
    rarityCounts[r].unique += 1;
    rarityCounts[r].total += Number(c.count || 1);
  }

  const username = userDoc?.username ? `@${userDoc.username}` : (userDoc?.firstName || "Unknown");
  const fav = userDoc?.favoriteCardId
    ? cards.find((c) => c.cardId === String(userDoc.favoriteCardId))
    : null;

  const lines = [
    `🎗BIKA CATCHER PROFILE🎗`,
    ``,
    `👤 USER: ${username}`,
    `🆔 USER ID: ${userDoc?.userId || "-"}`,
    `⚡ TOTAL CHARACTER: ${totalOwned} (${uniqueOwned})`,
    `🫧 HAREM: ${uniqueOwned}/${totalPhotoCount} (${haremPercent}%)`,
    `ℹ️ EXPERIENCE LEVEL: ${lv.level}`,
    `📈 PROGRESS BAR: ${bar}`,
    fav ? `💖 FAVOURITE: ${fav.name} [${fav.cardId}]` : `💖 FAVOURITE: Not set`,
    ``,
  ];

  for (const r of RARITY_ORDER) {
    const em = getRarityEmoji(r);
    const data = rarityCounts[r] || { unique: 0, total: 0 };
    lines.push(`${em} RARITY ${r}: ${data.unique} (${data.total})`);
  }

  return lines.join("\n");
}

function buildCatchSuccessText(card, claimer) {
  const emoji = getRarityEmoji(card.rarity);
  return [
    `🎉 YOU GOT A NEW CHARACTER!`,
    ``,
    `👤 Claimed by: ${claimer}`,
    `${emoji} Name: ${card.name}`,
    `🆔 ID: ${card.cardId}`,
    `🏷 RARITY: ${card.rarity}`,
    `🌴 ANIME: ${card.anime}`,
    ``,
    `❄️ CHECK YOUR /harem !`,
  ].join("\n");
}

function buildAlreadyCaughtText(caughtByName = "Someone") {
  return [
    `❌ CHARACTER ALREADY CAUGHT`,
    ``,
    `Caught by: ${caughtByName}`,
    `🥤 Wait for new character to spawn.`,
  ].join("\n");
}

function buildWrongNameText(guess) {
  return [
    `❌ CHARACTER NAME ${String(guess || "").toLowerCase()} IS INCORRECT`,
    ``,
    `⬆️ CHARACTER is still available.`,
  ].join("\n");
}

// -------------------- MONGOOSE --------------------
mongoose.set("strictQuery", true);

const photoSchema = new mongoose.Schema({
  cardId: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true, trim: true, index: true },
  normalizedName: { type: String, required: true, index: true },
  rarity: { type: String, required: true, default: "Common", index: true },
  anime: { type: String, required: true, trim: true, index: true },
  fileId: { type: String, required: true },
  addedBy: { type: Number, required: true },
}, { timestamps: true });

const userCardSchema = new mongoose.Schema({
  cardId: { type: String, required: true },
  name: { type: String, required: true },
  normalizedName: { type: String, required: true },
  rarity: { type: String, required: true },
  anime: { type: String, required: true },
  fileId: { type: String, required: true },
  count: { type: Number, required: true, default: 1 },
}, { _id: false });

const userSchema = new mongoose.Schema({
  userId: { type: Number, required: true, unique: true, index: true },
  username: { type: String, default: "" },
  firstName: { type: String, default: "" },
  exp: { type: Number, default: 0 },
  favoriteCardId: { type: String, default: "" },
  cards: { type: [userCardSchema], default: [] },
}, { timestamps: true });

const activeDropSchema = new mongoose.Schema({
  cardId: { type: String, default: "" },
  name: { type: String, default: "" },
  normalizedName: { type: String, default: "" },
  rarity: { type: String, default: "Common" },
  anime: { type: String, default: "" },
  fileId: { type: String, default: "" },
  messageId: { type: Number, default: 0 },
  isClaimed: { type: Boolean, default: false },
  claimedByUserId: { type: Number, default: 0 },
  claimedByName: { type: String, default: "" },
  droppedAt: { type: Date, default: null },
}, { _id: false });

const groupSchema = new mongoose.Schema({
  groupId: { type: Number, required: true, unique: true, index: true },
  title: { type: String, default: "" },
  username: { type: String, default: "" },
  isApproved: { type: Boolean, default: false, index: true },
  approvedBy: { type: Number, default: 0 },
  approvedAt: { type: Date, default: null },
  messageCount: { type: Number, default: 0 },
  activeDrop: { type: activeDropSchema, default: null },
}, { timestamps: true });

const transferSchema = new mongoose.Schema({
  fromUserId: { type: Number, required: true, index: true },
  toUserId: { type: Number, required: true, index: true },
  cardId: { type: String, required: true },
  name: { type: String, required: true },
  rarity: { type: String, required: true },
  anime: { type: String, required: true },
  qty: { type: Number, required: true, default: 1 },
}, { timestamps: true });

const Photo = mongoose.model("Photo", photoSchema);
const User = mongoose.model("User", userSchema);
const Group = mongoose.model("Group", groupSchema);
const Transfer = mongoose.model("Transfer", transferSchema);

// -------------------- DB HELPERS --------------------
async function ensureUserDoc(tgUser) {
  if (!tgUser?.id) return null;
  const update = { username: tgUser.username || "", firstName: tgUser.first_name || "" };
  return User.findOneAndUpdate(
    { userId: tgUser.id },
    { $set: update, $setOnInsert: { exp: 0, favoriteCardId: "", cards: [] } },
    { new: true, upsert: true }
  );
}

async function ensureGroupDoc(chat) {
  if (!chat?.id) return null;
  const update = { title: safeChatTitle(chat), username: chat.username || "" };
  return Group.findOneAndUpdate(
    { groupId: chat.id },
    { $set: update, $setOnInsert: { isApproved: false, messageCount: 0, activeDrop: null } },
    { new: true, upsert: true }
  );
}

async function addCardToUser(tgUser, photoDoc, qty = 1) {
  const userDoc = await ensureUserDoc(tgUser);
  if (!userDoc || !photoDoc) return null;

  const count = Math.max(1, Number(qty || 1));
  const idx = userDoc.cards.findIndex((c) => c.cardId === photoDoc.cardId);
  if (idx >= 0) userDoc.cards[idx].count += count;
  else userDoc.cards.push({
    cardId: photoDoc.cardId,
    name: photoDoc.name,
    normalizedName: photoDoc.normalizedName,
    rarity: photoDoc.rarity,
    anime: photoDoc.anime,
    fileId: photoDoc.fileId,
    count,
  });

  userDoc.exp = Number(userDoc.exp || 0) + (Number(RARITY_EXP[photoDoc.rarity] || 1) * count);
  await userDoc.save();
  return userDoc;
}

async function removeCardFromUser(userId, cardId, qty = 1) {
  const userDoc = await User.findOne({ userId });
  if (!userDoc) return { ok: false, reason: "User not found." };

  const index = userDoc.cards.findIndex((c) => c.cardId === String(cardId));
  if (index < 0) return { ok: false, reason: "Card not found in inventory." };

  const count = Math.max(1, Number(qty || 1));
  if (Number(userDoc.cards[index].count || 0) < count) return { ok: false, reason: "Not enough quantity." };

  userDoc.cards[index].count -= count;
  const removedCardSnapshot = { ...userDoc.cards[index].toObject() };
  if (userDoc.favoriteCardId && userDoc.favoriteCardId === String(cardId) && userDoc.cards[index].count <= 0) {
    userDoc.favoriteCardId = "";
  }
  if (userDoc.cards[index].count <= 0) userDoc.cards.splice(index, 1);

  await userDoc.save();
  return { ok: true, userDoc, removedCardSnapshot };
}

async function isApprovedGroup(chatId) {
  const group = await Group.findOne({ groupId: chatId }).lean();
  return !!group?.isApproved;
}

// -------------------- MIDDLEWARE --------------------
bot.use(async (ctx, next) => {
  try {
    return await next();
  } catch (err) {
    console.error("BOT ERROR:", err);
    try {
      if (ctx.chat?.type === "private") await ctx.reply("⚠️ Something went wrong. Please try again.");
    } catch (_) {}
  }
});

// -------------------- START --------------------
bot.start(async (ctx) => {
  const me = await bot.telegram.getMe().catch(() => null);
  const name = me?.first_name || "BIKA Catcher Bot";

  if (ctx.chat?.type === "private") {
    await ensureUserDoc(ctx.from);
    return ctx.reply([
      `👋 Welcome to ${name}`,
      ``,
      `Owner Commands:`,
      `/add`,
      `/admin`,
      ``,
      `Commands:`,
      `/profile`,
      `/harem`,
      `/fav <id>`,
      `/bika <name>`,
    ].join("\n"));
  }

  return ctx.reply("✅ Bot is alive.");
});

// -------------------- APPROVE --------------------
bot.command("approve", async (ctx) => {
  if (!["group", "supergroup"].includes(ctx.chat?.type)) return;
  if (!isOwner(ctx.from?.id)) return;

  const groupDoc = await ensureGroupDoc(ctx.chat);
  if (!groupDoc) return ctx.reply("❌ Failed to initialize group.");

  groupDoc.isApproved = true;
  groupDoc.approvedBy = ctx.from.id;
  groupDoc.approvedAt = new Date();
  await groupDoc.save();

  return ctx.reply(`✅ Group approved.\n\nTitle: ${safeChatTitle(ctx.chat)}\nGroup ID: ${ctx.chat.id}`);
});

// -------------------- OWNER ADD PHOTO IN DM --------------------
bot.on("photo", async (ctx, next) => {
  try {
    if (ctx.chat?.type !== "private") return next();
    if (!isOwner(ctx.from?.id)) return next();

    const caption = String(ctx.message?.caption || "").trim();
    const photos = ctx.message?.photo || [];
    const best = photos[photos.length - 1];
    const fileId = best?.file_id;
    if (!fileId) return next();

    if (caption.toLowerCase().startsWith("/add")) {
      const parsed = parseAddCaption(caption);
      if (!parsed) {
        return ctx.reply([
          "❌ Invalid add format.",
          "Use this exact caption with photo:",
          "/add 1001 | Rem | Legendary | Re:Zero",
          "",
          "Allowed rarities:",
          RARITY_ORDER.join(", "),
        ].join("\n"));
      }

      const normalizedName = normalizeName(parsed.name);
      const existing = await Photo.findOne({ cardId: parsed.cardId });
      if (existing) {
        existing.name = parsed.name;
        existing.normalizedName = normalizedName;
        existing.rarity = parsed.rarity;
        existing.anime = parsed.anime;
        existing.fileId = fileId;
        existing.addedBy = ctx.from.id;
        await existing.save();
        return ctx.reply(`♻️ Card updated.\nID: ${parsed.cardId}\nName: ${parsed.name}\nRarity: ${parsed.rarity}\nAnime: ${parsed.anime}`);
      }

      await Photo.create({
        cardId: parsed.cardId,
        name: parsed.name,
        normalizedName,
        rarity: parsed.rarity,
        anime: parsed.anime,
        fileId,
        addedBy: ctx.from.id,
      });
      return ctx.reply(`✅ Card added.\nID: ${parsed.cardId}\nName: ${parsed.name}\nRarity: ${parsed.rarity}\nAnime: ${parsed.anime}`);
    }

    const autoParsed = parseForwardCharacter(caption);
    if (!autoParsed) {
      console.log("FORWARD CAPTION RAW =>", JSON.stringify(caption));
      return ctx.reply("❌ Forward parse failed.\n\nCaption received:\n\n" + caption);
    }

    const normalizedName = normalizeName(autoParsed.name);
    const existing = await Photo.findOne({ cardId: autoParsed.cardId });
    if (existing) {
      existing.name = autoParsed.name;
      existing.normalizedName = normalizedName;
      existing.rarity = autoParsed.rarity;
      existing.anime = autoParsed.anime;
      existing.fileId = fileId;
      existing.addedBy = ctx.from.id;
      await existing.save();
      return ctx.reply(`♻️ Forward card updated.\nID: ${autoParsed.cardId}\nName: ${autoParsed.name}\nRarity: ${autoParsed.rarity}\nAnime: ${autoParsed.anime}`);
    }

    await Photo.create({
      cardId: autoParsed.cardId,
      name: autoParsed.name,
      normalizedName,
      rarity: autoParsed.rarity,
      anime: autoParsed.anime,
      fileId,
      addedBy: ctx.from.id,
    });
    return ctx.reply(`✅ Forward card added.\nID: ${autoParsed.cardId}\nName: ${autoParsed.name}\nRarity: ${autoParsed.rarity}\nAnime: ${autoParsed.anime}`);
  } catch (err) {
    console.error("PHOTO ADD / FORWARD PARSE ERROR:", err);
    return ctx.reply("❌ Failed to save card.");
  }
});

// -------------------- ADMIN --------------------
bot.command("admin", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return;

  const [userCount, groupCount, approvedCount, photoCount, transferCount] = await Promise.all([
    User.countDocuments(),
    Group.countDocuments(),
    Group.countDocuments({ isApproved: true }),
    Photo.countDocuments(),
    Transfer.countDocuments(),
  ]);

  const text = [
    `⚙️ BIKA ADMIN DASHBOARD`,
    ``,
    `👤 Users: ${userCount}`,
    `👥 Groups: ${groupCount}`,
    `✅ Approved Groups: ${approvedCount}`,
    `🖼 Photo List: ${photoCount}`,
    `🎁 Transfers: ${transferCount}`,
    `🗄 DB Stats: estimated`,
    `⏱ Uptime: ${uptimeText(Date.now() - START_TIME)}`,
    `💾 Memory: ${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)} MB`,
    ``,
    `Use:`,
    `/admin_users`,
    `/admin_groups`,
    `/admin_photos`,
  ].join("\n");

  return ctx.reply(text);
});

bot.command("admin_users", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return;
  const users = await User.find().sort({ updatedAt: -1 }).limit(20).lean();
  if (!users.length) return ctx.reply("No users.");

  const lines = ["👤 USER LIST", ""];
  for (const u of users) {
    const total = (u.cards || []).reduce((a, b) => a + Number(b.count || 0), 0);
    lines.push(`• ${u.firstName || u.username || u.userId} | ID: ${u.userId} | Cards: ${total}`);
  }
  return ctx.reply(lines.join("\n"));
});

bot.command("admin_groups", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return;
  const groups = await Group.find().sort({ updatedAt: -1 }).limit(20).lean();
  if (!groups.length) return ctx.reply("No groups.");

  const lines = ["👥 GROUP LIST", ""];
  for (const g of groups) lines.push(`• ${g.title || g.groupId} | ${g.groupId} | ${g.isApproved ? "APPROVED" : "PENDING"}`);
  return ctx.reply(lines.join("\n"));
});

bot.command("admin_photos", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return;
  const photos = await Photo.find().sort({ createdAt: -1 }).limit(20).lean();
  if (!photos.length) return ctx.reply("No photos.");

  const lines = ["🖼 PHOTO LIST", ""];
  for (const p of photos) lines.push(`• ${p.cardId} | ${p.name} | ${p.rarity} | ${p.anime}`);
  return ctx.reply(lines.join("\n"));
});

bot.hears(/^\/check(?:@\w+)?\s+(\S+)$/i, async (ctx) => {
  const cardId = String(ctx.match[1] || "").trim();
  if (!cardId) return;

  const photoDoc = await Photo.findOne({ cardId }).lean();
  if (!photoDoc) {
    return ctx.reply(`❌ Character ID ${cardId} not found.`);
  }

  const stats = await getGlobalCardStats(cardId);
  const caption = buildCheckCaption(photoDoc, stats);

  return ctx.replyWithPhoto(photoDoc.fileId, { caption });
});

// -------------------- PROFILE --------------------
bot.hears(/^\/profile(?:@\w+)?$/i, async (ctx) => {
  await ensureUserDoc(ctx.from);
  const [userDoc, totalPhotoCount] = await Promise.all([
    User.findOne({ userId: ctx.from.id }).lean(),
    Photo.countDocuments(),
  ]);
  if (!userDoc) return ctx.reply("No profile yet.");

  const cover = getFavoriteOrRandomCard(userDoc);
  const text = buildProfileText(userDoc, totalPhotoCount);
  if (cover?.fileId) return ctx.replyWithPhoto(cover.fileId, { caption: text });
  return ctx.reply(text);
});

// -------------------- HAREM --------------------
async function sendHaremPage(ctx, targetUserId, page = 1, isCallback = false) {
  const userDoc = await User.findOne({ userId: targetUserId }).lean();
  if (!userDoc || !Array.isArray(userDoc.cards) || !userDoc.cards.length) {
    if (isCallback) return ctx.answerCbQuery("No cards.");
    return ctx.reply("You don't have any cards yet.");
  }

  const cover = getFavoriteOrRandomCard(userDoc);
  const { caption, safePage, totalPages } = buildHaremCaption(userDoc, page, HAREM_PAGE_SIZE);
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback("⬅ Back", `harem:${targetUserId}:${safePage - 1}`),
      Markup.button.callback(`Page ${safePage}/${totalPages}`, "noop"),
      Markup.button.callback("Next ➡", `harem:${targetUserId}:${safePage + 1}`),
    ],
  ]);

  if (isCallback) {
    try {
      await ctx.editMessageMedia({ type: "photo", media: cover.fileId, caption }, { reply_markup: keyboard.reply_markup });
    } catch {
      try { await ctx.editMessageCaption(caption, { reply_markup: keyboard.reply_markup }); } catch (_) {}
    }
    return ctx.answerCbQuery();
  }

  return ctx.replyWithPhoto(cover.fileId, { caption, ...keyboard });
}

bot.hears(/^\/harem(?:@\w+)?$/i, async (ctx) => {
  if (["group", "supergroup"].includes(ctx.chat?.type)) {
    const approved = await isApprovedGroup(ctx.chat.id);
    if (!approved) return ctx.reply(`❌ This group is not approved.\nOwner approval required: ${OWNER_USERNAME}`);
  }
  await ensureUserDoc(ctx.from);
  return sendHaremPage(ctx, ctx.from.id, 1, false);
});

bot.action(/^harem:(\d+):(-?\d+)$/, async (ctx) => {
  const targetUserId = Number(ctx.match[1]);
  let page = Number(ctx.match[2]);
  if (ctx.from?.id !== targetUserId && !isAdmin(ctx.from?.id)) return ctx.answerCbQuery("Not allowed.");

  const userDoc = await User.findOne({ userId: targetUserId }).lean();
  if (!userDoc || !userDoc.cards?.length) return ctx.answerCbQuery("No cards.");

  const totalPages = Math.max(1, chunkArray(buildHaremLines(userDoc.cards), HAREM_PAGE_SIZE).length);
  if (page < 1) page = totalPages;
  if (page > totalPages) page = 1;
  return sendHaremPage(ctx, targetUserId, page, true);
});

bot.action("noop", async (ctx) => ctx.answerCbQuery());

// -------------------- FAVOURITE --------------------
bot.hears(/^\/fav(?:@\w+)?\s+(\S+)$/i, async (ctx) => {
  const cardId = String(ctx.match[1] || "").trim();
  if (!cardId) return;

  const userDoc = await ensureUserDoc(ctx.from);
  const card = userDoc.cards.find((c) => c.cardId === cardId);

  if (!card) {
    return ctx.reply("This character does not exist in your collection.");
  }

  const text = [
    `DO YOU WANT TO SET THIS CHARACTER AS YOUR FAVOURITE?`,
    `↪ ${card.name} (${card.anime})`,
  ].join("\n");

  return ctx.replyWithPhoto(card.fileId, {
    caption: text,
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback("🟢 Yes", `fav_yes:${ctx.from.id}:${card.cardId}`),
        Markup.button.callback("🔴 No", `fav_no:${ctx.from.id}`),
      ],
    ]),
  });
});

bot.action(/^fav_yes:(\d+):(.+)$/, async (ctx) => {
  const userId = Number(ctx.match[1]);
  const cardId = String(ctx.match[2]);
  if (ctx.from?.id !== userId) return ctx.answerCbQuery("Not your action.");

  const userDoc = await User.findOne({ userId });
  if (!userDoc) return ctx.answerCbQuery("User not found.");

  const card = userDoc.cards.find((c) => c.cardId === cardId);
  if (!card) {
    try { await ctx.editMessageCaption("This character does not exist in your collection."); } catch (_) {}
    return ctx.answerCbQuery("Card missing.");
  }

  userDoc.favoriteCardId = card.cardId;
  await userDoc.save();
  try { await ctx.editMessageCaption(`💖 Favourite set to ${card.name} [${card.cardId}]`); } catch (_) {}
  return ctx.answerCbQuery("Favourite updated.");
});

bot.action(/^fav_no:(\d+)$/, async (ctx) => {
  const userId = Number(ctx.match[1]);
  if (ctx.from?.id !== userId) return ctx.answerCbQuery("Not your action.");
  try { await ctx.editMessageCaption("❌ Favourite update cancelled."); } catch (_) {}
  return ctx.answerCbQuery("Cancelled.");
});

// -------------------- GIFT WITH CONFIRM / CANCEL --------------------
bot.hears(/^\.gift\s+(\S+)(?:\s+(\d+))?$/i, async (ctx) => {
  if (!["group", "supergroup"].includes(ctx.chat?.type)) return;
  const approved = await isApprovedGroup(ctx.chat.id);
  if (!approved) return ctx.reply(`❌ This group is not approved.\nOwner approval required: ${OWNER_USERNAME}`);

  const replyTo = ctx.message?.reply_to_message;
  if (!replyTo?.from?.id) return ctx.reply("❌ Reply to the target user's message.\nExample: .gift 1001");

  const senderId = ctx.from?.id;
  const receiverId = replyTo.from.id;
  if (!senderId || !receiverId) return;
  if (senderId === receiverId) return ctx.reply("❌ You can't gift to yourself.");

  const cardId = String(ctx.match[1]).trim();
  const qty = Math.max(1, Number(ctx.match[2] || 1));

  const senderUser = await ensureUserDoc(ctx.from);
  await ensureUserDoc(replyTo.from);
  if (!senderUser) return ctx.reply("❌ Failed to load sender.");

  const card = senderUser.cards.find((c) => c.cardId === cardId);
  if (!card) return ctx.reply("❌ Card not found in your inventory.");
  if (Number(card.count || 0) < qty) return ctx.reply("❌ Not enough quantity.");

  const emoji = getRarityEmoji(card.rarity);
  const previewText = [
    `🎁 GIFT PREVIEW`,
    ``,
    `From: ${ctx.from.first_name || ctx.from.username || ctx.from.id}`,
    `To: ${replyTo.from.first_name || replyTo.from.username || replyTo.from.id}`,
    `Card: ${emoji} ${card.name}`,
    `ID: ${card.cardId}`,
    `Anime: ${card.anime}`,
    `Qty: ${qty}`,
    ``,
    `Are you sure you want to send this card?`,
  ].join("\n");

  const payload = [senderId, receiverId, card.cardId, qty].join(":");
  return ctx.reply(previewText, Markup.inlineKeyboard([
    [
      Markup.button.callback("✅ Confirm", `gift_confirm:${payload}`),
      Markup.button.callback("❌ Cancel", `gift_cancel:${senderId}`),
    ],
  ]));
});

bot.action(/^gift_confirm:(\d+):(\d+):([^:]+):(\d+)$/, async (ctx) => {
  const senderId = Number(ctx.match[1]);
  const receiverId = Number(ctx.match[2]);
  const cardId = String(ctx.match[3]);
  const qty = Math.max(1, Number(ctx.match[4] || 1));

  if (ctx.from?.id !== senderId) return ctx.answerCbQuery("Not your gift action.");

  const senderUser = await User.findOne({ userId: senderId });
  const receiverUser = await User.findOne({ userId: receiverId });
  if (!senderUser || !receiverUser) return ctx.answerCbQuery("User data missing.", { show_alert: true });

  const removal = await removeCardFromUser(senderId, cardId, qty);
  if (!removal.ok) return ctx.editMessageText(`❌ ${removal.reason}`);

  const card = removal.removedCardSnapshot;
  const idx = receiverUser.cards.findIndex((c) => c.cardId === card.cardId);
  if (idx >= 0) receiverUser.cards[idx].count += qty;
  else receiverUser.cards.push({
    cardId: card.cardId,
    name: card.name,
    normalizedName: card.normalizedName,
    rarity: card.rarity,
    anime: card.anime,
    fileId: card.fileId,
    count: qty,
  });
  await receiverUser.save();

  await Transfer.create({
    fromUserId: senderId,
    toUserId: receiverId,
    cardId: card.cardId,
    name: card.name,
    rarity: card.rarity,
    anime: card.anime,
    qty,
  });

  const emoji = getRarityEmoji(card.rarity);
  await ctx.editMessageText(`✅ Gift sent successfully.\n\nCard: ${emoji} ${card.name}\nID: ${card.cardId}\nQty: ${qty}`);
  return ctx.answerCbQuery("Gift confirmed.");
});

bot.action(/^gift_cancel:(\d+)$/, async (ctx) => {
  const senderId = Number(ctx.match[1]);
  if (ctx.from?.id !== senderId) return ctx.answerCbQuery("Not your cancel action.");
  await ctx.editMessageText("❌ Gift cancelled.");
  return ctx.answerCbQuery("Cancelled.");
});

// -------------------- CLAIM --------------------
async function handleClaim(ctx, guessRaw) {
  if (!["group", "supergroup"].includes(ctx.chat?.type)) return;
  const approved = await isApprovedGroup(ctx.chat.id);
  if (!approved) return ctx.reply(`❌ This group is not approved.\nOwner approval required: ${OWNER_USERNAME}`);

  const guessText = String(guessRaw || "").trim();
  if (!guessText) return;

  const groupDoc = await ensureGroupDoc(ctx.chat);
  if (!groupDoc?.activeDrop || !groupDoc.activeDrop.cardId) return;

  if (groupDoc.activeDrop.isClaimed) {
    return ctx.reply(buildAlreadyCaughtText(groupDoc.activeDrop.claimedByName || "Someone"));
  }

  const guess = normalizeName(guessText);
  const target = groupDoc.activeDrop.normalizedName;
  if (guess !== target) {
    return ctx.reply(buildWrongNameText(guessText));
  }

  const updated = await Group.findOneAndUpdate(
    {
      groupId: ctx.chat.id,
      "activeDrop.cardId": groupDoc.activeDrop.cardId,
      "activeDrop.isClaimed": false,
    },
    {
      $set: {
        "activeDrop.isClaimed": true,
        "activeDrop.claimedByUserId": ctx.from.id,
        "activeDrop.claimedByName": ctx.from.first_name || ctx.from.username || String(ctx.from.id),
      },
    },
    { new: true }
  );

  if (!updated?.activeDrop?.isClaimed || Number(updated.activeDrop.claimedByUserId) !== Number(ctx.from.id)) {
    const latest = await Group.findOne({ groupId: ctx.chat.id }).lean();
    return ctx.reply(buildAlreadyCaughtText(latest?.activeDrop?.claimedByName || "Someone"));
  }

  const photoDoc = await Photo.findOne({ cardId: updated.activeDrop.cardId });
  if (!photoDoc) {
    await Group.findOneAndUpdate({ groupId: ctx.chat.id }, { $set: { activeDrop: null } });
    return ctx.reply("❌ Drop data missing.");
  }

  await addCardToUser(ctx.from, photoDoc, 1);
  const claimer = ctx.from.first_name || ctx.from.username || String(ctx.from.id);
  return ctx.reply(buildCatchSuccessText(photoDoc, claimer));
}

bot.hears(/^\/bika(?:@\w+)?\s+(.+)$/i, async (ctx) => handleClaim(ctx, ctx.match[1]));

// -------------------- MESSAGE COUNTER / RANDOM DROP --------------------
async function maybeDropCharacter(ctx) {
  if (!["group", "supergroup"].includes(ctx.chat?.type)) return;
  if (!ctx.message?.text && !ctx.message?.caption) return;

  const text = String(ctx.message?.text || ctx.message?.caption || "").trim();
  if (!text) return;

  const approved = await isApprovedGroup(ctx.chat.id);
  if (!approved) return;

  const groupDoc = await ensureGroupDoc(ctx.chat);
  if (!groupDoc) return;

  groupDoc.messageCount = Number(groupDoc.messageCount || 0) + 1;
  if (groupDoc.messageCount < MESSAGE_DROP_COUNT) {
    await groupDoc.save();
    return;
  }

  groupDoc.messageCount = 0;

  const totalCards = await Photo.countDocuments();
  if (totalCards <= 0) {
    await groupDoc.save();
    return;
  }

  const randomIndex = Math.floor(Math.random() * totalCards);
  const photoDoc = await Photo.findOne().skip(randomIndex).lean();
  if (!photoDoc) {
    await groupDoc.save();
    return;
  }

  const emoji = getRarityEmoji(photoDoc.rarity);
  const caption = [
    `${emoji} A NEW CHARACTER HAS SPAWNED IN THE CHAT!`,
    ``,
    `Old unclaimed drop has expired.`,
    
    `Rarity: ${photoDoc.rarity}`,
    
    `Anime: ${photoDoc.anime}`,
    
    `ʜᴀʀᴇᴍ ᴜsɪɴɢ /bika [name] `,
    
  ].join("\n");

  try {
    const sent = await ctx.replyWithPhoto(photoDoc.fileId, { caption });
    groupDoc.activeDrop = {
      cardId: photoDoc.cardId,
      name: photoDoc.name,
      normalizedName: photoDoc.normalizedName,
      rarity: photoDoc.rarity,
      anime: photoDoc.anime,
      fileId: photoDoc.fileId,
      messageId: sent.message_id,
      isClaimed: false,
      claimedByUserId: 0,
      claimedByName: "",
      droppedAt: new Date(),
    };
    await groupDoc.save();
  } catch (err) {
    console.error("DROP ERROR:", err);
    await groupDoc.save();
  }
}

bot.on("message", async (ctx, next) => {
  try {
    if (ctx.from?.id) await ensureUserDoc(ctx.from);
    if (["group", "supergroup"].includes(ctx.chat?.type)) await ensureGroupDoc(ctx.chat);
  } catch (_) {}
  await next();
});

bot.on("text", async (ctx, next) => {
  if (["group", "supergroup"].includes(ctx.chat?.type)) {
    const text = String(ctx.message?.text || "").trim();
    if (text.startsWith("/")) {
      const approved = await isApprovedGroup(ctx.chat.id);
      if (!approved && !commandTextMatches(text, "approve")) {
        return ctx.reply(`❌ This group is not approved.\nOwner approval required: ${OWNER_USERNAME}`);
      }
    }
  }
  await next();
});

bot.on("message", async (ctx) => maybeDropCharacter(ctx));

// -------------------- MENU COMMANDS --------------------
async function registerCommands() {
  try {
    await bot.telegram.setMyCommands([
      { command: "harem", description: "Display your harem" },
      { command: "profile", description: "See your profile" },
      { command: "fav", description: "Set favourite by ID" },
      { command: "check", description: "Check character by ID" },
    ]);
  } catch (err) {
    console.error("SET COMMANDS ERROR:", err);
  }
}

// -------------------- HEALTH --------------------
app.get("/", (_, res) => {
  res.status(200).send(`BIKA Catcher Bot is running. Uptime: ${uptimeText(Date.now() - START_TIME)}`);
});

// -------------------- LAUNCH --------------------
async function main() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("MongoDB connected");

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`HTTP server running on :${PORT} [${NODE_ENV}]`);
    });

    await bot.telegram.deleteWebhook({ drop_pending_updates: false });
    console.log("Webhook deleted / polling mode ready");

    await bot.launch();
    await registerCommands();
    console.log("Bot launched");
  } catch (err) {
    console.error("MAIN ERROR:", err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});

// -------------------- SHUTDOWN --------------------
process.once("SIGINT", async () => {
  try {
    await bot.stop("SIGINT");
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(0);
});

process.once("SIGTERM", async () => {
  try {
    await bot.stop("SIGTERM");
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(0);
});
