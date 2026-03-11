"use strict";

/**
 * BIKA Character Catcher Bot 
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

const bot = new Telegraf(BOT_TOKEN, {
  handlerTimeout: 60_000,
});

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

function mentionUser(user) {
  const first = escapeHtml(user?.first_name || user?.username || "User");
  return `<a href="tg://user?id=${user?.id}">${first}</a>`;
}

function escapeHtml(text = "") {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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

function parseAddCaption(caption = "") {
  // Expected:
  // /add 1001 | Rem | Legendary | Re:Zero
  // /add 1001|Rem|Legendary|Re:Zero
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

  return {
    cardId,
    name,
    rarity: rarityNorm,
    anime,
  };
}

function getRarityEmoji(rarity) {
  return RARITY_EMOJI[rarity] || "🎴";
}

function getRandomItem(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function commandTextMatches(text = "", cmd = "") {
  // Supports /harem or /harem@BotName
  const t = String(text || "").trim();
  return new RegExp(`^\\/${cmd}(?:@\\w+)?(?:\\s|$)`, "i").test(t);
}

function buildHaremLines(cards = []) {
  // group by anime
  const animeMap = new Map();

  for (const c of cards) {
    const anime = c.anime || "Unknown";
    if (!animeMap.has(anime)) animeMap.set(anime, []);
    animeMap.get(anime).push(c);
  }

  const groups = Array.from(animeMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  return groups;
}

function chunkArray(arr = [], size = 5) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
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
  lines.push("");

  if (!current.length) {
    lines.push("No cards yet.");
  } else {
    for (const [anime, animeCards] of current) {
      const uniqueCount = animeCards.length;
      const totalCount = animeCards.reduce((a, b) => a + Number(b.count || 0), 0);
      lines.push(`⚜️ ${anime} (${uniqueCount}/${totalCount})`);
      lines.push("────────────────────────");

      for (const card of animeCards.sort((a, b) => Number(a.cardId) - Number(b.cardId))) {
        const emoji = getRarityEmoji(card.rarity);
        lines.push(`🍀 ${card.cardId} | ${emoji} | ${card.name} (x${Number(card.count || 1)})`);
      }
      lines.push("");
    }
  }

  return {
    caption: lines.join("\n").trim(),
    totalPages,
    safePage,
  };
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

  const lines = [
    `🎗 CATCHER PROFILE 🎗`,
    ``,
    `👤 USER: ${username}`,
    `🆔 USER ID: ${userDoc?.userId || "-"}`,
    `⚡ TOTAL CHARACTER: ${totalOwned} (${uniqueOwned})`,
    `🫧 HAREM: ${uniqueOwned}/${totalPhotoCount} (${haremPercent}%)`,
    `ℹ️ EXPERIENCE LEVEL: ${lv.level}`,
    `📈 PROGRESS BAR: ${bar}`,
    ``,
  ];

  for (const r of RARITY_ORDER) {
    const em = getRarityEmoji(r);
    const data = rarityCounts[r] || { unique: 0, total: 0 };
    lines.push(`${em} RARITY ${r}: ${data.unique} (${data.total})`);
  }

  return lines.join("\n");
}

// -------------------- MONGOOSE --------------------
mongoose.set("strictQuery", true);

const photoSchema = new mongoose.Schema(
  {
    cardId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, trim: true, index: true },
    normalizedName: { type: String, required: true, index: true },
    rarity: { type: String, required: true, default: "Common", index: true },
    anime: { type: String, required: true, trim: true, index: true },
    fileId: { type: String, required: true },
    addedBy: { type: Number, required: true },
  },
  { timestamps: true }
);

const userCardSchema = new mongoose.Schema(
  {
    cardId: { type: String, required: true },
    name: { type: String, required: true },
    normalizedName: { type: String, required: true },
    rarity: { type: String, required: true },
    anime: { type: String, required: true },
    fileId: { type: String, required: true },
    count: { type: Number, required: true, default: 1 },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    userId: { type: Number, required: true, unique: true, index: true },
    username: { type: String, default: "" },
    firstName: { type: String, default: "" },
    exp: { type: Number, default: 0 },
    cards: { type: [userCardSchema], default: [] },
  },
  { timestamps: true }
);

const activeDropSchema = new mongoose.Schema(
  {
    cardId: { type: String, default: "" },
    name: { type: String, default: "" },
    normalizedName: { type: String, default: "" },
    rarity: { type: String, default: "Common" },
    anime: { type: String, default: "" },
    fileId: { type: String, default: "" },
    messageId: { type: Number, default: 0 },
    isClaimed: { type: Boolean, default: false },
    droppedAt: { type: Date, default: null },
  },
  { _id: false }
);

const groupSchema = new mongoose.Schema(
  {
    groupId: { type: Number, required: true, unique: true, index: true },
    title: { type: String, default: "" },
    username: { type: String, default: "" },
    isApproved: { type: Boolean, default: false, index: true },
    approvedBy: { type: Number, default: 0 },
    approvedAt: { type: Date, default: null },
    messageCount: { type: Number, default: 0 },
    activeDrop: { type: activeDropSchema, default: null },
  },
  { timestamps: true }
);

const transferSchema = new mongoose.Schema(
  {
    fromUserId: { type: Number, required: true, index: true },
    toUserId: { type: Number, required: true, index: true },
    cardId: { type: String, required: true },
    name: { type: String, required: true },
    rarity: { type: String, required: true },
    anime: { type: String, required: true },
    qty: { type: Number, required: true, default: 1 },
  },
  { timestamps: true }
);

const Photo = mongoose.model("Photo", photoSchema);
const User = mongoose.model("User", userSchema);
const Group = mongoose.model("Group", groupSchema);
const Transfer = mongoose.model("Transfer", transferSchema);

// -------------------- DB HELPERS --------------------
async function ensureUserDoc(tgUser) {
  if (!tgUser?.id) return null;

  const update = {
    username: tgUser.username || "",
    firstName: tgUser.first_name || "",
  };

  const doc = await User.findOneAndUpdate(
    { userId: tgUser.id },
    { $set: update, $setOnInsert: { exp: 0, cards: [] } },
    { new: true, upsert: true }
  );

  return doc;
}

async function ensureGroupDoc(chat) {
  if (!chat?.id) return null;

  const update = {
    title: safeChatTitle(chat),
    username: chat.username || "",
  };

  const doc = await Group.findOneAndUpdate(
    { groupId: chat.id },
    { $set: update, $setOnInsert: { isApproved: false, messageCount: 0, activeDrop: null } },
    { new: true, upsert: true }
  );

  return doc;
}

async function addCardToUser(tgUser, photoDoc, qty = 1) {
  const userDoc = await ensureUserDoc(tgUser);
  if (!userDoc || !photoDoc) return null;

  const count = Math.max(1, Number(qty || 1));
  const idx = userDoc.cards.findIndex((c) => c.cardId === photoDoc.cardId);

  if (idx >= 0) {
    userDoc.cards[idx].count += count;
  } else {
    userDoc.cards.push({
      cardId: photoDoc.cardId,
      name: photoDoc.name,
      normalizedName: photoDoc.normalizedName,
      rarity: photoDoc.rarity,
      anime: photoDoc.anime,
      fileId: photoDoc.fileId,
      count,
    });
  }

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
  if (Number(userDoc.cards[index].count || 0) < count) {
    return { ok: false, reason: "Not enough quantity." };
  }

  userDoc.cards[index].count -= count;
  const removedCardSnapshot = { ...userDoc.cards[index].toObject() };

  if (userDoc.cards[index].count <= 0) {
    userDoc.cards.splice(index, 1);
  }

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
      if (ctx.chat?.type === "private") {
        await ctx.reply("⚠️ Something went wrong. Please try again.");
      }
    } catch (_) {}
  }
});

// -------------------- START --------------------
bot.start(async (ctx) => {
  const me = await bot.telegram.getMe().catch(() => null);
  const name = me?.first_name || "BIKA Catcher Bot";

  if (ctx.chat?.type === "private") {
    await ensureUserDoc(ctx.from);

    return ctx.reply(
      [
        `👋 Welcome to ${name}`,
        ``,
        `Owner DM add format:`,
        `/add 1001 | Rem | Legendary | Re:Zero`,
        `(attach photo with the caption above)`,
        ``,
        `Commands:`,
        `/profile`,
        `/harem`,
        `/admin`,
      ].join("\n")
    );
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

  return ctx.reply(
    `✅ Group approved.\n\nTitle: ${safeChatTitle(ctx.chat)}\nGroup ID: ${ctx.chat.id}`
  );
});

// -------------------- OWNER ADD PHOTO IN DM --------------------
bot.on("photo", async (ctx, next) => {
  if (ctx.chat?.type !== "private") return next();
  if (!isOwner(ctx.from?.id)) return next();

  const caption = String(ctx.message?.caption || "");
  if (!caption.toLowerCase().startsWith("/add")) return next();

  const parsed = parseAddCaption(caption);
  if (!parsed) {
    return ctx.reply(
      [
        "❌ Invalid add format.",
        "Use this exact caption with photo:",
        "/add 1001 | Rem | Legendary | Re:Zero",
        "",
        "Allowed rarities:",
        RARITY_ORDER.join(", "),
      ].join("\n")
    );
  }

  const photos = ctx.message?.photo || [];
  const best = photos[photos.length - 1];
  const fileId = best?.file_id;

  if (!fileId) {
    return ctx.reply("❌ No photo file_id found.");
  }

  const normalizedName = normalizeName(parsed.name);

  try {
    const existing = await Photo.findOne({ cardId: parsed.cardId });
    if (existing) {
      existing.name = parsed.name;
      existing.normalizedName = normalizedName;
      existing.rarity = parsed.rarity;
      existing.anime = parsed.anime;
      existing.fileId = fileId;
      existing.addedBy = ctx.from.id;
      await existing.save();

      return ctx.reply(
        `♻️ Card updated.\nID: ${parsed.cardId}\nName: ${parsed.name}\nRarity: ${parsed.rarity}\nAnime: ${parsed.anime}`
      );
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

    return ctx.reply(
      `✅ Card added.\nID: ${parsed.cardId}\nName: ${parsed.name}\nRarity: ${parsed.rarity}\nAnime: ${parsed.anime}`
    );
  } catch (err) {
    console.error("ADD PHOTO ERROR:", err);
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
  for (const g of groups) {
    lines.push(`• ${g.title || g.groupId} | ${g.groupId} | ${g.isApproved ? "APPROVED" : "PENDING"}`);
  }

  return ctx.reply(lines.join("\n"));
});

bot.command("admin_photos", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return;
  const photos = await Photo.find().sort({ createdAt: -1 }).limit(20).lean();

  if (!photos.length) return ctx.reply("No photos.");

  const lines = ["🖼 PHOTO LIST", ""];
  for (const p of photos) {
    lines.push(`• ${p.cardId} | ${p.name} | ${p.rarity} | ${p.anime}`);
  }

  return ctx.reply(lines.join("\n"));
});

// -------------------- PROFILE --------------------
bot.hears(/^\/profile(?:@\w+)?$/i, async (ctx) => {
  await ensureUserDoc(ctx.from);

  const [userDoc, totalPhotoCount] = await Promise.all([
    User.findOne({ userId: ctx.from.id }).lean(),
    Photo.countDocuments(),
  ]);

  if (!userDoc) return ctx.reply("No profile yet.");

  return ctx.reply(buildProfileText(userDoc, totalPhotoCount));
});

// -------------------- HAREM --------------------
async function sendHaremPage(ctx, targetUserId, page = 1, isCallback = false) {
  const userDoc = await User.findOne({ userId: targetUserId }).lean();
  if (!userDoc || !Array.isArray(userDoc.cards) || !userDoc.cards.length) {
    const msg = "You don't have any cards yet.";
    if (isCallback) {
      return ctx.answerCbQuery("No cards.");
    }
    return ctx.reply(msg);
  }

  const randomCover = getRandomItem(userDoc.cards);
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
      await ctx.editMessageMedia(
        {
          type: "photo",
          media: randomCover.fileId,
          caption,
        },
        { reply_markup: keyboard.reply_markup }
      );
    } catch (e) {
      try {
        await ctx.editMessageCaption(caption, { reply_markup: keyboard.reply_markup });
      } catch (_) {}
    }
    return ctx.answerCbQuery();
  }

  return ctx.replyWithPhoto(randomCover.fileId, {
    caption,
    ...keyboard,
  });
}

bot.hears(/^\/harem(?:@\w+)?$/i, async (ctx) => {
  if (["group", "supergroup"].includes(ctx.chat?.type)) {
    const approved = await isApprovedGroup(ctx.chat.id);
    if (!approved) {
      return ctx.reply(`❌ This group is not approved.\nOwner approval required: ${OWNER_USERNAME}`);
    }
  }

  await ensureUserDoc(ctx.from);
  return sendHaremPage(ctx, ctx.from.id, 1, false);
});

bot.action(/^harem:(\d+):(-?\d+)$/, async (ctx) => {
  const targetUserId = Number(ctx.match[1]);
  let page = Number(ctx.match[2]);

  if (ctx.from?.id !== targetUserId && !isAdmin(ctx.from?.id)) {
    return ctx.answerCbQuery("Not allowed.", { show_alert: false });
  }

  const userDoc = await User.findOne({ userId: targetUserId }).lean();
  if (!userDoc || !userDoc.cards?.length) {
    return ctx.answerCbQuery("No cards.");
  }

  const totalPages = Math.max(1, chunkArray(buildHaremLines(userDoc.cards), HAREM_PAGE_SIZE).length);
  if (page < 1) page = totalPages;
  if (page > totalPages) page = 1;

  return sendHaremPage(ctx, targetUserId, page, true);
});

bot.action("noop", async (ctx) => {
  return ctx.answerCbQuery();
});

// -------------------- GIFT --------------------
bot.hears(/^\.gift\s+(\S+)(?:\s+(\d+))?$/i, async (ctx) => {
  if (!["group", "supergroup"].includes(ctx.chat?.type)) return;
  const approved = await isApprovedGroup(ctx.chat.id);
  if (!approved) {
    return ctx.reply(`❌ This group is not approved.\nOwner approval required: ${OWNER_USERNAME}`);
  }

  const replyTo = ctx.message?.reply_to_message;
  if (!replyTo?.from?.id) {
    return ctx.reply("❌ Reply to the target user's message.\nExample: .gift 1001");
  }

  const senderId = ctx.from?.id;
  const receiverId = replyTo.from.id;

  if (!senderId || !receiverId) return;
  if (senderId === receiverId) return ctx.reply("❌ You can't gift to yourself.");

  const cardId = String(ctx.match[1]).trim();
  const qty = Math.max(1, Number(ctx.match[2] || 1));

  const senderUser = await ensureUserDoc(ctx.from);
  const receiverUser = await ensureUserDoc(replyTo.from);

  if (!senderUser || !receiverUser) {
    return ctx.reply("❌ Failed to load users.");
  }

  const removal = await removeCardFromUser(senderId, cardId, qty);
  if (!removal.ok) {
    return ctx.reply(`❌ ${removal.reason}`);
  }

  const card = removal.removedCardSnapshot;
  const receiverDoc = await User.findOne({ userId: receiverId });
  const idx = receiverDoc.cards.findIndex((c) => c.cardId === card.cardId);

  if (idx >= 0) {
    receiverDoc.cards[idx].count += qty;
  } else {
    receiverDoc.cards.push({
      cardId: card.cardId,
      name: card.name,
      normalizedName: card.normalizedName,
      rarity: card.rarity,
      anime: card.anime,
      fileId: card.fileId,
      count: qty,
    });
  }

  await receiverDoc.save();

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

  return ctx.replyWithHTML(
    `🎁 ${mentionUser(ctx.from)} gifted ${emoji} <b>${escapeHtml(card.name)}</b> (x${qty}) to ${mentionUser(replyTo.from)}`
  );
});

// -------------------- CLAIM --------------------
bot.hears(/^\/bika(?:@\w+)?\s+(.+)$/i, async (ctx) => {
  if (!["group", "supergroup"].includes(ctx.chat?.type)) return;
  const approved = await isApprovedGroup(ctx.chat.id);

  if (!approved) {
    return ctx.reply(`❌ This group is not approved.\nOwner approval required: ${OWNER_USERNAME}`);
  }

  const guessRaw = String(ctx.match[1] || "").trim();
  if (!guessRaw) return;

  const groupDoc = await ensureGroupDoc(ctx.chat);
  if (!groupDoc?.activeDrop || !groupDoc.activeDrop.cardId || groupDoc.activeDrop.isClaimed) {
    return;
  }

  const guess = normalizeName(guessRaw);
  const target = groupDoc.activeDrop.normalizedName;

  if (guess !== target) return;

  const photoDoc = await Photo.findOne({ cardId: groupDoc.activeDrop.cardId });
  if (!photoDoc) {
    groupDoc.activeDrop = null;
    await groupDoc.save();
    return ctx.reply("❌ Drop data missing.");
  }

  groupDoc.activeDrop.isClaimed = true;
  await groupDoc.save();

  await addCardToUser(ctx.from, photoDoc, 1);
  const emoji = getRarityEmoji(photoDoc.rarity);

  return ctx.replyWithHTML(
    `🎉 ${mentionUser(ctx.from)} caught ${emoji} <b>${escapeHtml(photoDoc.name)}</b>\n` +
    `ID: <b>${escapeHtml(photoDoc.cardId)}</b>\n` +
    `Rarity: <b>${escapeHtml(photoDoc.rarity)}</b>\n` +
    `Anime: <b>${escapeHtml(photoDoc.anime)}</b>`
  );
});

// -------------------- MESSAGE COUNTER / RANDOM DROP --------------------
async function maybeDropCharacter(ctx) {
  if (!["group", "supergroup"].includes(ctx.chat?.type)) return;
  if (!ctx.message?.text && !ctx.message?.caption) return;

  const text = String(ctx.message?.text || ctx.message?.caption || "");
  if (!text.trim()) return;

  // ignore commands
  if (/^[/.!]/.test(text.trim())) return;

  const approved = await isApprovedGroup(ctx.chat.id);
  if (!approved) return;

  const groupDoc = await ensureGroupDoc(ctx.chat);
  if (!groupDoc) return;

  // active unclaimed drop exists => do not spawn another
  if (groupDoc.activeDrop && groupDoc.activeDrop.cardId && !groupDoc.activeDrop.isClaimed) {
    return;
  }

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
    `${emoji} A CHARACTER HAS SPAWNED IN THE CHAT!`,
    ``,
    `Rarity: ${photoDoc.rarity}`,
    `Anime: ${photoDoc.anime}`,
    `Catch using /bika [name]`,
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
    // ensure docs quietly
    if (ctx.from?.id) await ensureUserDoc(ctx.from);
    if (["group", "supergroup"].includes(ctx.chat?.type)) await ensureGroupDoc(ctx.chat);
  } catch (_) {}

  await next();
});

bot.on("text", async (ctx, next) => {
  // Warning in non-approved groups for commands except /approve
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

bot.on("message", async (ctx) => {
  return maybeDropCharacter(ctx);
});

// -------------------- HEALTH --------------------
app.get("/", (_, res) => {
  res.status(200).send(`BIKA Catcher Bot is running. Uptime: ${uptimeText(Date.now() - START_TIME)}`);
});

// -------------------- LAUNCH --------------------
async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log("MongoDB connected");

  await bot.launch();
  console.log("Bot launched");

  app.listen(PORT, () => {
    console.log(`HTTP server running on :${PORT} [${NODE_ENV}]`);
  });
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
