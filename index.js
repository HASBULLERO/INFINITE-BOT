// ========================== IMPORTS ==========================
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

// ========================== CONFIG ==========================
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const OWNER_ID = process.env.OWNER_ID;

const STAFF_ROLE_IDS = [
  "1405183233293025382",
  "1405183143501103236",
  "1405183318688796803",
];

const LOGS_CHANNEL_ID = process.env.LOGS_CHANNEL_ID || null;

const STRIPE_PRICE_IDS = {
  lifetime: "price_1SSkvlLbqLRphi0MhFwCpLWI",
  monthly: "price_1SSkuhLbqLRphi0MPO5ToNxV",
};

// ========================== CLIENT ==========================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildPresences,
  ],
  partials: [Partials.Channel, Partials.GuildMember],
});

// ========================== WEB SERVER ==========================
const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (_req, res) => res.send("Bot activo con sistema Premium"));

app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook error:", err.message);
    return res.status(400).send("Webhook Error: " + err.message);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId = session.metadata.userId;
    const tier = session.metadata.tier;

    if (userId && tier) {
      await activatePremium(userId, tier);
      console.log("Premium activado para " + userId + " (" + tier + ")");
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.listen(PORT, () => console.log("Web escuchando en puerto " + PORT));

// ========================== PERSISTENCIA ==========================
const ECON_PATH = path.join(__dirname, "economy.json");
const XP_PATH = path.join(__dirname, "xp.json");
const PREMIUM_PATH = path.join(__dirname, "premium.json");
const WARNS_PATH = path.join(__dirname, "warnings.json");

let economy = {};
let levels = {};
let premiumUsers = {};
let warnings = {};

function loadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error("Error leyendo " + file, e);
  }
  return fallback;
}

function saveJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Error guardando " + file, e);
  }
}

economy = loadJSON(ECON_PATH, {});
levels = loadJSON(XP_PATH, {});
premiumUsers = loadJSON(PREMIUM_PATH, {});
warnings = loadJSON(WARNS_PATH, {});

// ========================== PREMIUM ==========================
function isPremium(userId) {
  const user = premiumUsers[userId];
  if (!user) return false;
  if (user.tier === "lifetime") return true;
  if (user.tier === "monthly" && user.expiresAt > Date.now()) return true;
  return false;
}

async function activatePremium(userId, tier) {
  premiumUsers[userId] = {
    tier,
    activatedAt: Date.now(),
    expiresAt: tier === "monthly" ? Date.now() + 30 * 24 * 60 * 60 * 1000 : null,
  };
  saveJSON(PREMIUM_PATH, premiumUsers);
}

async function createCheckoutSession(userId, tier) {
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    line_items: [{ price: STRIPE_PRICE_IDS[tier], quantity: 1 }],
    mode: tier === "monthly" ? "subscription" : "payment",
    success_url: "https://discord.com/channels/@me",
    cancel_url: "https://discord.com/channels/@me",
    metadata: { userId, tier },
  });
  return session.url;
}

// ========================== ECONOMIA ==========================
function ensureUserEconomy(userId) {
  if (!economy[userId]) economy[userId] = { money: 200, lastDaily: 0, lastWork: 0, bank: 0 };
  return economy[userId];
}

function getBalance(userId) {
  return ensureUserEconomy(userId).money;
}

function addMoney(userId, amount) {
  const u = ensureUserEconomy(userId);
  u.money += amount;
  if (u.money < 0) u.money = 0;
  saveJSON(ECON_PATH, economy);
}

function canUseCooldown(last, ms) {
  const now = Date.now();
  const diff = now - last;
  return { ok: diff >= ms, left: Math.max(0, ms - diff) };
}

function fmtMs(ms) {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h + "h " + m + "m " + ss + "s";
}

// ========================== XP ==========================
function ensureUserLevel(userId) {
  if (!levels[userId]) levels[userId] = { xp: 0, level: 1, lastGain: 0 };
  return levels[userId];
}

function neededXP(level) {
  return 100 * level;
}

function tryAddXP(userId, channel) {
  const u = ensureUserLevel(userId);
  const now = Date.now();
  if (now - u.lastGain < 60_000) return;

  let gain = Math.floor(Math.random() * 11) + 5;
  if (isPremium(userId)) gain *= 2;

  u.xp += gain;
  u.lastGain = now;

  const need = neededXP(u.level);
  if (u.xp >= need) {
    u.level += 1;
    u.xp = 0;
    channel?.send("<@" + userId + "> subio a nivel " + u.level);
  }
  saveJSON(XP_PATH, levels);
}

// ========================== WARNS ==========================
function addWarn(userId, guildId, reason, moderatorId) {
  const key = guildId + "-" + userId;
  if (!warnings[key]) warnings[key] = [];
  warnings[key].push({ reason, moderatorId, timestamp: Date.now() });
  saveJSON(WARNS_PATH, warnings);
  return warnings[key].length;
}

function getWarns(userId, guildId) {
  const key = guildId + "-" + userId;
  return warnings[key] || [];
}

function clearWarns(userId, guildId) {
  const key = guildId + "-" + userId;
  delete warnings[key];
  saveJSON(WARNS_PATH, warnings);
}

// ========================== LOGS ==========================
async function sendLog(guild, embed) {
  if (!LOGS_CHANNEL_ID) return;
  const logChannel = guild.channels.cache.get(LOGS_CHANNEL_ID);
  if (logChannel) await logChannel.send({ embeds: [embed] });
}

// ========================== COMANDOS ==========================
const slashDefs = [
  new SlashCommandBuilder().setName("ping").setDescription("Responde con Pong").setIntegrationTypes([0, 1]).setContexts([0, 1, 2]),
  new SlashCommandBuilder().setName("avatar").setDescription("Muestra el avatar de un usuario").addUserOption(o => o.setName("usuario").setDescription("Usuario")).setIntegrationTypes([0, 1]).setContexts([0, 1, 2]),
  new SlashCommandBuilder().setName("userinfo").setDescription("Informacion de un usuario").addUserOption(o => o.setName("usuario").setDescription("Usuario")).setIntegrationTypes([0, 1]).setContexts([0, 1, 2]),
  new SlashCommandBuilder().setName("serverinfo").setDescription("Informacion del servidor").setIntegrationTypes([0]).setContexts([0]),
  new SlashCommandBuilder().setName("balance").setDescription("Muestra tu saldo").setIntegrationTypes([0, 1]).setContexts([0, 1, 2]),
  new SlashCommandBuilder().setName("depositar").setDescription("Deposita dinero en el banco").addIntegerOption(o => o.setName("cantidad").setDescription("Cantidad").setRequired(true)).setIntegrationTypes([0, 1]).setContexts([0, 1, 2]),
  new SlashCommandBuilder().setName("retirar").setDescription("Retira dinero del banco").addIntegerOption(o => o.setName("cantidad").setDescription("Cantidad").setRequired(true)).setIntegrationTypes([0, 1]).setContexts([0, 1, 2]),
  new SlashCommandBuilder().setName("daily").setDescription("Reclama tu recompensa diaria").setIntegrationTypes([0, 1]).setContexts([0, 1, 2]),
  new SlashCommandBuilder().setName("trabajar").setDescription("Trabaja para ganar dinero").setIntegrationTypes([0, 1]).setContexts([0, 1, 2]),
  new SlashCommandBuilder().setName("apostar").setDescription("Apuesta dinero").addIntegerOption(o => o.setName("cantidad").setDescription("Cantidad").setRequired(true)).setIntegrationTypes([0, 1]).setContexts([0, 1, 2]),
  new SlashCommandBuilder().setName("transferir").setDescription("Transfiere dinero").addUserOption(o => o.setName("usuario").setDescription("Usuario").setRequired(true)).addIntegerOption(o => o.setName("cantidad").setDescription("Cantidad").setRequired(true)).setIntegrationTypes([0, 1]).setContexts([0, 1, 2]),
  new SlashCommandBuilder().setName("coinflip").setDescription("Cara o cruz").addStringOption(o => o.setName("eleccion").setDescription("Elige").setRequired(true).addChoices({ name: "cara", value: "cara" }, { name: "cruz", value: "cruz" })).addIntegerOption(o => o.setName("cantidad").setDescription("Cantidad").setRequired(true)).setIntegrationTypes([0, 1]).setContexts([0, 1, 2]),
  new SlashCommandBuilder().setName("slots").setDescription("Tragaperras").addIntegerOption(o => o.setName("cantidad").setDescription("Cantidad").setRequired(true)).setIntegrationTypes([0, 1]).setContexts([0, 1, 2]),
  new SlashCommandBuilder().setName("leaderboard").setDescription("Top usuarios por dinero o nivel").addStringOption(o => o.setName("tipo").setDescription("Tipo").setRequired(true).addChoices({ name: "Dinero", value: "money" }, { name: "Nivel", value: "level" })).setIntegrationTypes([0, 1]).setContexts([0, 1, 2]),
  new SlashCommandBuilder().setName("8ball").setDescription("Pregunta a la bola magica").addStringOption(o => o.setName("pregunta").setDescription("Tu pregunta").setRequired(true)).setIntegrationTypes([0, 1]).setContexts([0, 1, 2]),
  new SlashCommandBuilder().setName("dado").setDescription("Lanza un dado").addIntegerOption(o => o.setName("caras").setDescription("Numero de caras")).setIntegrationTypes([0, 1]).setContexts([0, 1, 2]),
  new SlashCommandBuilder().setName("meme").setDescription("Muestra un meme aleatorio").setIntegrationTypes([0, 1]).setContexts([0, 1, 2]),
  new SlashCommandBuilder().setName("kick").setDescription("Expulsa a un usuario").addUserOption(o => o.setName("usuario").setDescription("Usuario").setRequired(true)).addStringOption(o => o.setName("razon").setDescription("Razon")).setDefaultMemberPermissions(PermissionFlagsBits.KickMembers).setIntegrationTypes([0]).setContexts([0]),
  new SlashCommandBuilder().setName("ban").setDescription("Banea a un usuario").addUserOption(o => o.setName("usuario").setDescription("Usuario").setRequired(true)).addStringOption(o => o.setName("razon").setDescription("Razon")).setDefaultMemberPermissions(PermissionFlagsBits.BanMembers).setIntegrationTypes([0]).setContexts([0]),
  new SlashCommandBuilder().setName("warn").setDescription("Advierte a un usuario").addUserOption(o => o.setName("usuario").setDescription("Usuario").setRequired(true)).addStringOption(o => o.setName("razon").setDescription("Razon").setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers).setIntegrationTypes([0]).setContexts([0]),
  new SlashCommandBuilder().setName("warnings").setDescription("Ver advertencias de un usuario").addUserOption(o => o.setName("usuario").setDescription("Usuario").setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers).setIntegrationTypes([0]).setContexts([0]),
  new SlashCommandBuilder().setName("clearwarns").setDescription("Limpia advertencias de un usuario").addUserOption(o => o.setName("usuario").setDescription("Usuario").setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers).setIntegrationTypes([0]).setContexts([0]),
  new SlashCommandBuilder().setName("timeout").setDescription("Silencia a un usuario").addUserOption(o => o.setName("usuario").setDescription("Usuario").setRequired(true)).addIntegerOption(o => o.setName("minutos").setDescription("Minutos").setRequired(true)).addStringOption(o => o.setName("razon").setDescription("Razon")).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers).setIntegrationTypes([0]).setContexts([0]),
  new SlashCommandBuilder().setName("clear").setDescription("Elimina mensajes").addIntegerOption(o => o.setName("cantidad").setDescription("Cantidad (1-100)").setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages).setIntegrationTypes([0]).setContexts([0]),
  new SlashCommandBuilder().setName("premium").setDescription("Informacion sobre Premium").setIntegrationTypes([0, 1]).setContexts([0, 1, 2]),
  new SlashCommandBuilder().setName("buypremium").setDescription("Compra Premium").addStringOption(o => o.setName("plan").setDescription("Plan").setRequired(true).addChoices({ name: "Mensual - $9.99/mes", value: "monthly" }, { name: "De por vida - $49.99", value: "lifetime" })).setIntegrationTypes([0, 1]).setContexts([0, 1, 2]),
  new SlashCommandBuilder().setName("premiumdaily").setDescription("[PREMIUM] Recompensa diaria mejorada").setIntegrationTypes([0, 1]).setContexts([0, 1, 2]),
  new SlashCommandBuilder().setName("megaslots").setDescription("[PREMIUM] Slots con multiplicador x5").addIntegerOption(o => o.setName("cantidad").setDescription("Cantidad").setRequired(true)).setIntegrationTypes([0, 1]).setContexts([0, 1, 2]),
  new SlashCommandBuilder().setName("givepremium").setDescription("[OWNER] Da Premium a un usuario manualmente").addUserOption(o => o.setName("usuario").setDescription("Usuario").setRequired(true)).addStringOption(o => o.setName("plan").setDescription("Tipo de Premium").setRequired(true).addChoices({ name: "Mensual (30 dias)", value: "monthly" }, { name: "De por vida (Permanente)", value: "lifetime" })).setIntegrationTypes([0, 1]).setContexts([0, 1, 2]),
].map(cmd => cmd.toJSON());

// ========================== REGISTRO ==========================
const rest = new REST({ version: "10" }).setToken(TOKEN);

async function registerCommands() {
  try {
    console.log("Registrando comandos globales...");
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: slashDefs });
    console.log("Comandos registrados");
  } catch (e) {
    console.error("Error registrando comandos:", e);
  }
}

// ========================== EVENTOS ==========================
client.once("ready", () => {
  console.log("Conectado como " + client.user.tag);
  client.user.setActivity("Sistema Premium activo", { type: 3 });
});

client.on("messageCreate", (msg) => {
  if (!msg.guild || msg.author.bot) return;
  tryAddXP(msg.author.id, msg.channel);
});

client.on("guildMemberAdd", async (member) => {
  const embed = new EmbedBuilder()
    .setTitle("Miembro nuevo")
    .setDescription(member.user.tag + " se unio al servidor")
    .setThumbnail(member.user.displayAvatarURL())
    .setColor("Green")
    .setTimestamp();
  await sendLog(member.guild, embed);
});

client.on("guildMemberRemove", async (member) => {
  const embed = new EmbedBuilder()
    .setTitle("Miembro salio")
    .setDescription(member.user.tag + " salio del servidor")
    .setThumbnail(member.user.displayAvatarURL())
    .setColor("Red")
    .setTimestamp();
  await sendLog(member.guild, embed);
});

client.on("messageDelete", async (message) => {
  if (!message.guild || message.author?.bot) return;
  const embed = new EmbedBuilder()
    .setTitle("Mensaje eliminado")
    .setDescription("Autor: " + message.author?.tag + "\nCanal: " + message.channel + "\nContenido: " + (message.content || "Sin contenido"))
    .setColor("Orange")
    .setTimestamp();
  await sendLog(message.guild, embed);
});

// ========================== COMANDOS ==========================
client.on("interactionCreate", async (i) => {
  if (i.isChatInputCommand()) {
    const name = i.commandName;

    if (name === "ping") return i.reply("Pong! Latencia: **" + client.ws.ping + "ms**");

    if (name === "avatar") {
      const user = i.options.getUser("usuario") || i.user;
      const embed = new EmbedBuilder().setTitle("Avatar de " + user.username).setImage(user.displayAvatarURL({ size: 1024 })).setColor("Blue");
      return i.reply({ embeds: [embed] });
    }

    if (name === "userinfo") {
      const user = i.options.getUser("usuario") || i.user;
      if (!i.guild) return i.reply({ content: "Este comando solo funciona en servidores", ephemeral: true });
      const member = await i.guild.members.fetch(user.id);
      const embed = new EmbedBuilder()
        .setTitle("Info de " + user.username)
        .setThumbnail(user.displayAvatarURL())
        .addFields(
          { name: "ID", value: user.id, inline: true },
          { name: "Creado", value: "<t:" + Math.floor(user.createdTimestamp / 1000) + ":R>", inline: true },
          { name: "Se unio", value: "<t:" + Math.floor(member.joinedTimestamp / 1000) + ":R>", inline: true },
          { name: "Roles", value: member.roles.cache.map(r => r.name).join(", ") || "Ninguno" }
        )
        .setColor("Purple");
      return i.reply({ embeds: [embed] });
    }

    if (name === "serverinfo") {
      if (!i.guild) return i.reply({ content: "Este comando solo funciona en servidores", ephemeral: true });
      const guild = i.guild;
      const embed = new EmbedBuilder()
        .setTitle(guild.name)
        .setThumbnail(guild.iconURL())
        .addFields(
          { name: "Miembros", value: String(guild.memberCount), inline: true },
          { name: "Creado", value: "<t:" + Math.floor(guild.createdTimestamp / 1000) + ":R>", inline: true },
          { name: "Owner", value: "<@" + guild.ownerId + ">", inline: true },
          { name: "Canales", value: String(guild.channels.cache.size), inline: true },
          { name: "Roles", value: String(guild.roles.cache.size), inline: true }
        )
        .setColor("Gold");
      return i.reply({ embeds: [embed] });
    }

    if (name === "balance") {
      const u = ensureUserEconomy(i.user.id);
      const embed = new EmbedBuilder()
        .setTitle("Balance de " + i.user.username)
        .addFields(
          { name: "Efectivo", value: String(u.money), inline: true },
          { name: "Banco", value: String(u.bank || 0), inline: true },
          { name: "Total", value: String(u.money + (u.bank || 0)), inline: true }
        )
        .setColor("Green");
      if (isPremium(i.user.id)) embed.setFooter({ text: "Usuario Premium" });
      return i.reply({ embeds: [embed] });
    }

    if (name === "depositar") {
      const cantidad = i.options.getInteger("cantidad");
      if (cantidad <= 0) return i.reply({ content: "Cantidad invalida", ephemeral: true });
      const u = ensureUserEconomy(i.user.id);
      if (u.money < cantidad) return i.reply({ content: "No tienes suficiente efectivo", ephemeral: true });
      u.money -= cantidad;
      u.bank = (u.bank || 0) + cantidad;
      saveJSON(ECON_PATH, economy);
      return i.reply("Depositaste **" + cantidad + "**. Banco: **" + u.bank + "**");
    }

    if (name === "retirar") {
      const cantidad = i.options.getInteger("cantidad");
      if (cantidad <= 0) return i.reply({ content: "Cantidad invalida", ephemeral: true });
      const u = ensureUserEconomy(i.user.id);
      if ((u.bank || 0) < cantidad) return i.reply({ content: "No tienes suficiente en el banco", ephemeral: true });
      u.bank -= cantidad;
      u.money += cantidad;
      saveJSON(ECON_PATH, economy);
      return i.reply("Retiraste **" + cantidad + "**. Efectivo: **" + u.money + "**");
    }

    if (name === "daily") {
      const u = ensureUserEconomy(i.user.id);
      const cd = canUseCooldown(u.lastDaily, 24 * 60 * 60 * 1000);
      if (!cd.ok) return i.reply({ content: "Vuelve en **" + fmtMs(cd.left) + "**", ephemeral: true });
      let amount = Math.floor(Math.random() * 201) + 100;
      if (isPremium(i.user.id)) amount = Math.floor(amount * 1.5);
      u.lastDaily = Date.now();
      addMoney(i.user.id, amount);
      return i.reply("Daily: **+" + amount + "**" + (isPremium(i.user.id) ? " (Bonus Premium)" : "") + ". Saldo: **" + getBalance(i.user.id) + "**");
    }

    if (name === "trabajar") {
      const u = ensureUserEconomy(i.user.id);
      const cd = canUseCooldown(u.lastWork, 30 * 60 * 1000);
      if (!cd.ok) return i.reply({ content: "Podras trabajar en **" + fmtMs(cd.left) + "**", ephemeral: true });
      let amount = Math.floor(Math.random() * 251) + 50;
      if (isPremium(i.user.id)) amount = Math.floor(amount * 1.5);
      u.lastWork = Date.now();
      addMoney(i.user.id, amount);
      return i.reply("Trabajaste: **+" + amount + "**" + (isPremium(i.user.id) ? " (Bonus Premium)" : "") + ". Saldo: **" + getBalance(i.user.id) + "**");
    }

    if (name === "apostar") {
      const cantidad = i.options.getInteger("cantidad");
      if (cantidad <= 0) return i.reply({ content: "Cantidad invalida", ephemeral: true });
      if (getBalance(i.user.id) < cantidad) return i.reply({ content: "No tienes suficiente", ephemeral: true });
      const win = Math.random() < 0.5;
      if (win) {
        addMoney(i.user.id, cantidad);
        return i.reply("Ganaste **+" + cantidad + "**. Saldo: **" + getBalance(i.user.id) + "**");
      } else {
        addMoney(i.user.id, -cantidad);
        return i.reply("Perdiste **-" + cantidad + "**. Saldo: **" + getBalance(i.user.id) + "**");
      }
    }

    if (name === "transferir") {
      const target = i.options.getUser("usuario");
      const cantidad = i.options.getInteger("cantidad");
      if (target.bot || target.id === i.user.id) return i.reply({ content: "No valido", ephemeral: true });
      if (cantidad <= 0) return i.reply({ content: "Cantidad invalida", ephemeral: true });
      if (getBalance(i.user.id) < cantidad) return i.reply({ content: "No tienes suficiente", ephemeral: true });
      addMoney(i.user.id, -cantidad);
      addMoney(target.id, cantidad);
      return i.reply("Transferiste **" + cantidad + "** a **" + target.username + "**. Tu saldo: **" + getBalance(i.user.id) + "**");
    }

    if (name === "coinflip") {
      const eleccion = i.options.getString("eleccion");
      const cantidad = i.options.getInteger("cantidad");
      if (cantidad <= 0) return i.reply({ content: "Cantidad invalida", ephemeral: true });
      if (getBalance(i.user.id) < cantidad) return i.reply({ content: "No tienes suficiente", ephemeral: true });
      const resultado = Math.random() < 0.5 ? "cara" : "cruz";
      const win = resultado === eleccion;
      if (win) addMoney(i.user.id, cantidad);
      else addMoney(i.user.id, -cantidad);
      return i.reply("Moneda: **" + resultado + "**. " + (win ? "Ganaste" : "Perdiste") + " **" + cantidad + "**. Saldo: **" + getBalance(i.user.id) + "**");
    }

    if (name === "slots") {
      const cantidad = i.options.getInteger("cantidad");
      if (cantidad <= 0) return i.reply({ content: "Cantidad invalida", ephemeral: true });
      if (getBalance(i.user.id) < cantidad) return i.reply({ content: "No tienes suficiente", ephemeral: true });
      const symbols = ["cereza", "limon", "campana", "estrella", "siete"];
      const r = () => symbols[Math.floor(Math.random() * symbols.length)];
      const res = [r(), r(), r()];
      let win = false;
      let ganho = 0;
      if (res[0] === res[1] && res[1] === res[2]) {
        win = true;
        ganho = cantidad * 3;
      }
      addMoney(i.user.id, win ? ganho : -cantidad);
      return i.reply("Slots: " + res.join(" | ") + "\n" + (win ? "Ganaste" : "Perdiste") + " " + (win ? ganho : cantidad) + ". Saldo: **" + getBalance(i.user.id) + "**");
    }

    if (name === "leaderboard") {
      const tipo = i.options.getString("tipo");
      let data = [];

      if (tipo === "money") {
        data = Object.entries(economy)
          .map(([id, u]) => ({ id, value: u.money + (u.bank || 0) }))
          .sort((a, b) => b.value - a.value)
          .slice(0, 10);
      } else {
        data = Object.entries(levels)
          .map(([id, u]) => ({ id, value: u.level }))
          .sort((a, b) => b.value - a.value)
          .slice(0, 10);
      }

      const description = data.map((d, idx) => {
        const valor = tipo === "money" ? "Dinero: " + d.value : "Nivel " + d.value;
        return "**" + (idx + 1) + ".** <@" + d.id + "> - " + valor;
      }).join("\n") || "Sin datos";

      const embed = new EmbedBuilder()
        .setTitle("Top " + (tipo === "money" ? "Dinero" : "Niveles"))
        .setDescription(description)
        .setColor("Gold");
      return i.reply({ embeds: [embed] });
    }

    if (name === "8ball") {
      const pregunta = i.options.getString("pregunta");
      const respuestas = [
        "Si", "No", "Tal vez", "Definitivamente", "No lo creo",
        "Pregunta de nuevo", "Sin duda", "No cuentes con ello",
        "Es probable", "No es seguro", "Mis fuentes dicen que no",
        "Es cierto", "Mejor no decirte ahora", "Concentrate y pregunta de nuevo"
      ];
      const respuesta = respuestas[Math.floor(Math.random() * respuestas.length)];
      return i.reply("**Pregunta:** " + pregunta + "\n**Respuesta:** " + respuesta);
    }

    if (name === "dado") {
      const caras = i.options.getInteger("caras") || 6;
      if (caras < 2 || caras > 100) return i.reply({ content: "Entre 2 y 100 caras", ephemeral: true });
      const resultado = Math.floor(Math.random() * caras) + 1;
      return i.reply("Lanzaste un dado de " + caras + " caras: **" + resultado + "**");
    }

    if (name === "meme") {
      const memes = [
        "https://i.imgur.com/2Z8QZ0M.jpg",
        "https://i.imgur.com/7gFqrNs.jpg",
        "https://i.imgur.com/xGQ4k2l.jpg",
        "https://i.imgur.com/YxhkAWZ.jpg",
        "https://i.imgur.com/5FM9rJV.jpg",
      ];
      const meme = memes[Math.floor(Math.random() * memes.length)];
      const embed = new EmbedBuilder()
        .setTitle("Meme Aleatorio")
        .setImage(meme)
        .setColor("Random");
      return i.reply({ embeds: [embed] });
    }

    if (name === "kick") {
      if (!i.guild) return i.reply({ content: "Este comando solo funciona en servidores", ephemeral: true });
      const target = i.options.getUser("usuario");
      const razon = i.options.getString("razon") || "Sin razon";
      const member = await i.guild.members.fetch(target.id);

      if (!member.kickable) return i.reply({ content: "No puedo expulsar a este usuario", ephemeral: true });

      await member.kick(razon);

      const embed = new EmbedBuilder()
        .setTitle("Usuario Expulsado")
        .addFields(
          { name: "Usuario", value: target.tag },
          { name: "Moderador", value: i.user.tag },
          { name: "Razon", value: razon }
        )
        .setColor("Orange")
        .setTimestamp();

      await sendLog(i.guild, embed);
      return i.reply({ embeds: [embed] });
    }

    if (name === "ban") {
      if (!i.guild) return i.reply({ content: "Este comando solo funciona en servidores", ephemeral: true });
      const target = i.options.getUser("usuario");
      const razon = i.options.getString("razon") || "Sin razon";
      const member = await i.guild.members.fetch(target.id).catch(() => null);

      if (member && !member.bannable) return i.reply({ content: "No puedo banear a este usuario", ephemeral: true });

      await i.guild.members.ban(target.id, { reason: razon });

      const embed = new EmbedBuilder()
        .setTitle("Usuario Baneado")
        .addFields(
          { name: "Usuario", value: target.tag },
          { name: "Moderador", value: i.user.tag },
          { name: "Razon", value: razon }
        )
        .setColor("Red")
        .setTimestamp();

      await sendLog(i.guild, embed);
      return i.reply({ embeds: [embed] });
    }

    if (name === "warn") {
      if (!i.guild) return i.reply({ content: "Este comando solo funciona en servidores", ephemeral: true });
      const target = i.options.getUser("usuario");
      const razon = i.options.getString("razon");

      if (target.bot) return i.reply({ content: "No puedes advertir a bots", ephemeral: true });

      const warnCount = addWarn(target.id, i.guild.id, razon, i.user.id);

      const embed = new EmbedBuilder()
        .setTitle("Usuario Advertido")
        .addFields(
          { name: "Usuario", value: target.tag },
          { name: "Moderador", value: i.user.tag },
          { name: "Razon", value: razon },
          { name: "Advertencias totales", value: String(warnCount) }
        )
        .setColor("Yellow")
        .setTimestamp();

      await sendLog(i.guild, embed);
      return i.reply({ embeds: [embed] });
    }

    if (name === "warnings") {
      if (!i.guild) return i.reply({ content: "Este comando solo funciona en servidores", ephemeral: true });
      const target = i.options.getUser("usuario");
      const warns = getWarns(target.id, i.guild.id);

      if (warns.length === 0) {
        return i.reply({ content: target.username + " no tiene advertencias", ephemeral: true });
      }

      const description = warns.map((w, idx) =>
        "**" + (idx + 1) + ".** <@" + w.moderatorId + "> - " + w.reason + "\n<t:" + Math.floor(w.timestamp / 1000) + ":R>"
      ).join("\n\n");

      const embed = new EmbedBuilder()
        .setTitle("Advertencias de " + target.username)
        .setDescription(description)
        .setColor("Yellow");

      return i.reply({ embeds: [embed], ephemeral: true });
    }

    if (name === "clearwarns") {
      if (!i.guild) return i.reply({ content: "Este comando solo funciona en servidores", ephemeral: true });
      const target = i.options.getUser("usuario");
      clearWarns(target.id, i.guild.id);
      return i.reply("Advertencias de " + target.username + " limpiadas");
    }

    if (name === "timeout") {
      if (!i.guild) return i.reply({ content: "Este comando solo funciona en servidores", ephemeral: true });
      const target = i.options.getUser("usuario");
      const minutos = i.options.getInteger("minutos");
      const razon = i.options.getString("razon") || "Sin razon";

      if (minutos < 1 || minutos > 40320) return i.reply({ content: "Entre 1 min y 28 dias", ephemeral: true });

      const member = await i.guild.members.fetch(target.id);
      if (!member.moderatable) return i.reply({ content: "No puedo silenciar a este usuario", ephemeral: true });

      await member.timeout(minutos * 60 * 1000, razon);

      const embed = new EmbedBuilder()
        .setTitle("Usuario Silenciado")
        .addFields(
          { name: "Usuario", value: target.tag },
          { name: "Moderador", value: i.user.tag },
          { name: "Duracion", value: minutos + " minutos" },
          { name: "Razon", value: razon }
        )
        .setColor("DarkRed")
        .setTimestamp();

      await sendLog(i.guild, embed);
      return i.reply({ embeds: [embed] });
    }

    if (name === "clear") {
      if (!i.guild) return i.reply({ content: "Este comando solo funciona en servidores", ephemeral: true });
      const cantidad = i.options.getInteger("cantidad");
      if (cantidad < 1 || cantidad > 100) return i.reply({ content: "Entre 1 y 100", ephemeral: true });

      const deleted = await i.channel.bulkDelete(cantidad, true);
      return i.reply({ content: "Eliminados **" + deleted.size + "** mensajes", ephemeral: true });
    }

    if (name === "premium") {
      const status = isPremium(i.user.id);
      const userData = premiumUsers[i.user.id];

      const embed = new EmbedBuilder()
        .setTitle("Sistema Premium")
        .setDescription(status
          ? "Eres usuario Premium!\n\nPlan: " + (userData.tier === "monthly" ? "Mensual" : "De por vida") + "\n" + (userData.tier === "monthly" ? "Expira: <t:" + Math.floor(userData.expiresAt / 1000) + ":R>" : "Duracion: Permanente")
          : "No tienes Premium activo")
        .addFields(
          { name: "Beneficios Premium", value: "2x XP en mensajes\n50% mas recompensas (daily/work)\nComando /premiumdaily exclusivo\nComando /megaslots con x5 multiplicador\nBadge especial en comandos" },
          { name: "Planes", value: "Mensual: $9.99/mes\nDe por vida: $49.99 (pago unico)" },
          { name: "Activar", value: "Usa /buypremium para empezar" }
        )
        .setColor(status ? "Gold" : "Grey");

      return i.reply({ embeds: [embed] });
    }

    if (name === "buypremium") {
      const plan = i.options.getString("plan");

      try {
        const url = await createCheckoutSession(i.user.id, plan);

        const embed = new EmbedBuilder()
          .setTitle("Checkout de Premium")
          .setDescription("Haz clic en el boton de abajo para completar tu compra.\n\nPlan: " + (plan === "monthly" ? "Mensual ($9.99/mes)" : "De por vida ($49.99)") + "\n\nUna vez completado el pago, tu Premium se activara automaticamente")
          .setColor("Gold");

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel("Ir al Checkout")
            .setStyle(ButtonStyle.Link)
            .setURL(url)
        );

        return i.reply({ embeds: [embed], components: [row], ephemeral: true });
      } catch (error) {
        console.error("Error creando checkout:", error);
        return i.reply({ content: "Error al crear la sesion de pago. Contacta al soporte", ephemeral: true });
      }
    }

    if (name === "premiumdaily") {
      if (!isPremium(i.user.id)) {
        return i.reply({
          content: "Este comando es exclusivo para usuarios Premium. Usa /premium para mas info",
          ephemeral: true
        });
      }

      const u = ensureUserEconomy(i.user.id);
      const cd = canUseCooldown(u.lastDaily, 12 * 60 * 60 * 1000);
      if (!cd.ok) return i.reply({ content: "Vuelve en **" + fmtMs(cd.left) + "**", ephemeral: true });

      const amount = Math.floor(Math.random() * 401) + 300;
      u.lastDaily = Date.now();
      addMoney(i.user.id, amount);

      return i.reply("Premium Daily: **+" + amount + "**! (12h cooldown) Saldo: **" + getBalance(i.user.id) + "**");
    }

    if (name === "megaslots") {
      if (!isPremium(i.user.id)) {
        return i.reply({
          content: "Este comando es exclusivo para usuarios Premium. Usa /premium para mas info",
          ephemeral: true
        });
      }

      const cantidad = i.options.getInteger("cantidad");
      if (cantidad <= 0) return i.reply({ content: "Cantidad invalida", ephemeral: true });
      if (getBalance(i.user.id) < cantidad) return i.reply({ content: "No tienes suficiente", ephemeral: true });

      const symbols = ["diamante", "estrella", "corona", "fuego", "dinero"];
      const r = () => symbols[Math.floor(Math.random() * symbols.length)];
      const res = [r(), r(), r()];

      let multiplier = 0;
      if (res[0] === res[1] && res[1] === res[2]) {
        multiplier = 5;
      } else if (res[0] === res[1] || res[1] === res[2] || res[0] === res[2]) {
        multiplier = 2;
      }

      const ganancia = multiplier > 0 ? cantidad * multiplier : -cantidad;
      addMoney(i.user.id, ganancia);

      return i.reply("MEGA SLOTS\nSlots: " + res.join(" | ") + "\n\n" + (multiplier > 0 ? "GANASTE x" + multiplier + "! +" + ganancia : "Perdiste -" + cantidad) + "\n\nSaldo: **" + getBalance(i.user.id) + "**");
    }

    if (name === "givepremium") {
      if (i.user.id !== OWNER_ID) {
        return i.reply({
          content: "Este comando es exclusivo del creador del bot",
          ephemeral: true
        });
      }

      const target = i.options.getUser("usuario");
      const plan = i.options.getString("plan");

      await activatePremium(target.id, plan);

      const embed = new EmbedBuilder()
        .setTitle("Premium Otorgado")
        .setDescription("Premium activado exitosamente para " + target.username)
        .addFields(
          { name: "Usuario", value: "<@" + target.id + ">", inline: true },
          { name: "Plan", value: plan === "monthly" ? "Mensual (30 dias)" : "De por vida", inline: true },
          { name: "Otorgado por", value: "<@" + i.user.id + ">", inline: true }
        )
        .setColor("Gold")
        .setTimestamp()
        .setFooter({ text: "Sistema Premium" });

      console.log("Premium otorgado: " + target.tag + " (" + target.id + ") - " + plan + " - Por: " + i.user.tag);

      return i.reply({ embeds: [embed], ephemeral: true });
    }
  }

  if (i.isButton() && (i.customId === "support_es" || i.customId === "support_en")) {
    if (!i.guild) return i.reply({ content: "Este comando solo funciona en servidores", ephemeral: true });

    const channel = await i.guild.channels.create({
      name: "ticket-" + i.user.username,
      type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: i.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: i.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
          ],
        },
        ...STAFF_ROLE_IDS.map(id => ({
          id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        })),
      ],
    });

    const closeButton = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("close_ticket")
        .setLabel("Cerrar Ticket")
        .setStyle(ButtonStyle.Danger)
    );

    await channel.send({
      content: "<@" + i.user.id + ">",
      embeds: [
        new EmbedBuilder()
          .setTitle(i.customId === "support_es" ? "Ticket de Soporte" : "Support Ticket")
          .setDescription(
            i.customId === "support_es"
              ? "Gracias por crear un ticket. El equipo te atendera pronto.\n\nDescribe tu problema o pregunta."
              : "Thanks for creating a ticket. The support team will assist you shortly.\n\nDescribe your issue or question."
          )
          .setColor("Green")
          .setTimestamp(),
      ],
      components: [closeButton],
    });

    await i.reply({ content: "Ticket creado: " + channel, ephemeral: true });
  }

  if (i.isButton() && i.customId === "close_ticket") {
    const hasStaffRole = i.member.roles.cache.some(role => STAFF_ROLE_IDS.includes(role.id));
    if (!hasStaffRole && !i.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return i.reply({ content: "Solo el staff puede cerrar tickets", ephemeral: true });
    }

    await i.reply("Cerrando ticket en 5 segundos...");
    setTimeout(() => i.channel.delete(), 5000);
  }
});

(async () => {
  await registerCommands();
  await client.login(TOKEN);
})();
</artifact>