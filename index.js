// ========================== IMPORTS ==========================
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
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
const MONGO_URI = process.env.MONGO_URI;

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

// ========================== MONGODB SCHEMAS ==========================
const economySchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  money: { type: Number, default: 200 },
  bank: { type: Number, default: 0 },
  lastDaily: { type: Number, default: 0 },
  lastWork: { type: Number, default: 0 },
});

const levelSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  xp: { type: Number, default: 0 },
  level: { type: Number, default: 1 },
  lastGain: { type: Number, default: 0 },
});

const premiumUserSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  tier: { type: String, required: true },
  activatedAt: { type: Number, required: true },
  expiresAt: { type: Number, default: null },
});

const warningSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  warnings: [{
    reason: String,
    moderatorId: String,
    timestamp: Number,
  }],
});

// ========================== MODELS ==========================
const Economy = mongoose.model("Economy", economySchema);
const Level = mongoose.model("Level", levelSchema);
const PremiumUser = mongoose.model("PremiumUser", premiumUserSchema);
const Warning = mongoose.model("Warning", warningSchema);

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

app.get("/", (_req, res) => res.send("Bot activo con MongoDB"));

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

// ========================== DATABASE CONNECTION ==========================
mongoose.connect(MONGO_URI)
  .then(() => console.log("Conectado a MongoDB"))
  .catch(err => {
    console.error("Error conectando a MongoDB:", err);
    process.exit(1);
  });

// ========================== PREMIUM HELPERS ==========================
async function isPremium(userId) {
  const user = await PremiumUser.findOne({ userId });
  if (!user) return false;
  if (user.tier === "lifetime") return true;
  if (user.tier === "monthly" && user.expiresAt > Date.now()) return true;
  return false;
}

async function activatePremium(userId, tier) {
  await PremiumUser.findOneAndUpdate(
    { userId },
    {
      userId,
      tier,
      activatedAt: Date.now(),
      expiresAt: tier === "monthly" ? Date.now() + 30 * 24 * 60 * 60 * 1000 : null,
    },
    { upsert: true }
  );
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

// ========================== ECONOMIA HELPERS ==========================
async function ensureUserEconomy(userId) {
  let user = await Economy.findOne({ userId });
  if (!user) {
    user = await Economy.create({ userId, money: 200, bank: 0, lastDaily: 0, lastWork: 0 });
  }
  return user;
}

async function getBalance(userId) {
  const user = await ensureUserEconomy(userId);
  return user.money;
}

async function addMoney(userId, amount) {
  const user = await ensureUserEconomy(userId);
  user.money += amount;
  if (user.money < 0) user.money = 0;
  await user.save();
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

// ========================== XP HELPERS ==========================
async function ensureUserLevel(userId) {
  let user = await Level.findOne({ userId });
  if (!user) {
    user = await Level.create({ userId, xp: 0, level: 1, lastGain: 0 });
  }
  return user;
}

function neededXP(level) {
  return 100 * level;
}

async function tryAddXP(userId, channel) {
  const u = await ensureUserLevel(userId);
  const now = Date.now();
  if (now - u.lastGain < 60_000) return;

  let gain = Math.floor(Math.random() * 11) + 5;
  if (await isPremium(userId)) gain *= 2;

  u.xp += gain;
  u.lastGain = now;

  const need = neededXP(u.level);
  if (u.xp >= need) {
    u.level += 1;
    u.xp = 0;
    channel?.send("<@" + userId + "> subio a nivel " + u.level);
  }
  await u.save();
}

// ========================== WARNS HELPERS ==========================
async function addWarn(userId, guildId, reason, moderatorId) {
  const key = guildId + "-" + userId;
  let doc = await Warning.findOne({ key });

  if (!doc) {
    doc = await Warning.create({ key, warnings: [] });
  }

  doc.warnings.push({ reason, moderatorId, timestamp: Date.now() });
  await doc.save();
  return doc.warnings.length;
}

async function getWarns(userId, guildId) {
  const key = guildId + "-" + userId;
  const doc = await Warning.findOne({ key });
  return doc ? doc.warnings : [];
}

async function clearWarns(userId, guildId) {
  const key = guildId + "-" + userId;
  await Warning.deleteOne({ key });
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
  new SlashCommandBuilder().setName("setup").setDescription("[ADMIN] Configurar sistema de tickets").addChannelOption(o => o.setName("canal").setDescription("Canal donde aparecera el panel de tickets").setRequired(true).addChannelTypes(ChannelType.GuildText)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator).setIntegrationTypes([0]).setContexts([0]),
  new SlashCommandBuilder().setName("announce").setDescription("[ADMIN] Enviar anuncio desde el bot").addChannelOption(o => o.setName("canal").setDescription("Canal donde enviar el anuncio").setRequired(true).addChannelTypes(ChannelType.GuildText)).addStringOption(o => o.setName("mensaje").setDescription("Mensaje del anuncio").setRequired(true)).addStringOption(o => o.setName("titulo").setDescription("Titulo del anuncio (opcional)")).setDefaultMemberPermissions(PermissionFlagsBits.Administrator).setIntegrationTypes([0]).setContexts([0]),
  new SlashCommandBuilder().setName("info").setDescription("Informacion completa sobre el bot y sus funciones").setIntegrationTypes([0, 1]).setContexts([0, 1, 2]),
].map(cmd => cmd.toJSON());

// ========================== REGISTRO ==========================
const rest = new REST({ version: "10" }).setToken(TOKEN);

async function registerCommands() {
  try {
    console.log("Registrando comandos globales...");
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: slashDefs });
    console.log("Comandos registrados exitosamente");
  } catch (e) {
    console.error("Error registrando comandos:", e);
  }
}

// ========================== EVENTOS ==========================
client.once("ready", () => {
  console.log("Bot conectado como " + client.user.tag);
  client.user.setActivity("Ayudando a los mejores servers", { type: 3 });
  client.user.setStatus("online");
});

client.on("messageCreate", async (msg) => {
  if (!msg.guild || msg.author.bot) return;
  await tryAddXP(msg.author.id, msg.channel);
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
      const u = await ensureUserEconomy(i.user.id);
      const embed = new EmbedBuilder()
        .setTitle("Balance de " + i.user.username)
        .addFields(
          { name: "Efectivo", value: String(u.money), inline: true },
          { name: "Banco", value: String(u.bank || 0), inline: true },
          { name: "Total", value: String(u.money + (u.bank || 0)), inline: true }
        )
        .setColor("Green");
      if (await isPremium(i.user.id)) embed.setFooter({ text: "Usuario Premium" });
      return i.reply({ embeds: [embed] });
    }

    if (name === "depositar") {
      const cantidad = i.options.getInteger("cantidad");
      if (cantidad <= 0) return i.reply({ content: "Cantidad invalida", ephemeral: true });
      const u = await ensureUserEconomy(i.user.id);
      if (u.money < cantidad) return i.reply({ content: "No tienes suficiente efectivo", ephemeral: true });
      u.money -= cantidad;
      u.bank = (u.bank || 0) + cantidad;
      await u.save();
      return i.reply("Depositaste **" + cantidad + "**. Banco: **" + u.bank + "**");
    }

    if (name === "retirar") {
      const cantidad = i.options.getInteger("cantidad");
      if (cantidad <= 0) return i.reply({ content: "Cantidad invalida", ephemeral: true });
      const u = await ensureUserEconomy(i.user.id);
      if ((u.bank || 0) < cantidad) return i.reply({ content: "No tienes suficiente en el banco", ephemeral: true });
      u.bank -= cantidad;
      u.money += cantidad;
      await u.save();
      return i.reply("Retiraste **" + cantidad + "**. Efectivo: **" + u.money + "**");
    }

    if (name === "daily") {
      const u = await ensureUserEconomy(i.user.id);
      const cd = canUseCooldown(u.lastDaily, 24 * 60 * 60 * 1000);
      if (!cd.ok) return i.reply({ content: "Vuelve en **" + fmtMs(cd.left) + "**", ephemeral: true });
      let amount = Math.floor(Math.random() * 201) + 100;
      if (await isPremium(i.user.id)) amount = Math.floor(amount * 1.5);
      u.lastDaily = Date.now();
      await u.save();
      await addMoney(i.user.id, amount);
      return i.reply("Daily: **+" + amount + "**" + (await isPremium(i.user.id) ? " (Bonus Premium)" : "") + ". Saldo: **" + (await getBalance(i.user.id)) + "**");
    }

    if (name === "trabajar") {
      const u = await ensureUserEconomy(i.user.id);
      const cd = canUseCooldown(u.lastWork, 30 * 60 * 1000);
      if (!cd.ok) return i.reply({ content: "Podras trabajar en **" + fmtMs(cd.left) + "**", ephemeral: true });
      let amount = Math.floor(Math.random() * 251) + 50;
      if (await isPremium(i.user.id)) amount = Math.floor(amount * 1.5);
      u.lastWork = Date.now();
      await u.save();
      await addMoney(i.user.id, amount);
      return i.reply("Trabajaste: **+" + amount + "**" + (await isPremium(i.user.id) ? " (Bonus Premium)" : "") + ". Saldo: **" + (await getBalance(i.user.id)) + "**");
    }

    if (name === "apostar") {
      const cantidad = i.options.getInteger("cantidad");
      if (cantidad <= 0) return i.reply({ content: "Cantidad invalida", ephemeral: true });
      if ((await getBalance(i.user.id)) < cantidad) return i.reply({ content: "No tienes suficiente", ephemeral: true });
      const win = Math.random() < 0.5;
      if (win) {
        await addMoney(i.user.id, cantidad);
        return i.reply("Ganaste **+" + cantidad + "**. Saldo: **" + (await getBalance(i.user.id)) + "**");
      } else {
        await addMoney(i.user.id, -cantidad);
        return i.reply("Perdiste **-" + cantidad + "**. Saldo: **" + (await getBalance(i.user.id)) + "**");
      }
    }

    if (name === "transferir") {
      const target = i.options.getUser("usuario");
      const cantidad = i.options.getInteger("cantidad");
      if (target.bot || target.id === i.user.id) return i.reply({ content: "No valido", ephemeral: true });
      if (cantidad <= 0) return i.reply({ content: "Cantidad invalida", ephemeral: true });
      if ((await getBalance(i.user.id)) < cantidad) return i.reply({ content: "No tienes suficiente", ephemeral: true });
      await addMoney(i.user.id, -cantidad);
      await addMoney(target.id, cantidad);
      return i.reply("Transferiste **" + cantidad + "** a **" + target.username + "**. Tu saldo: **" + (await getBalance(i.user.id)) + "**");
    }

    if (name === "coinflip") {
      const eleccion = i.options.getString("eleccion");
      const cantidad = i.options.getInteger("cantidad");
      if (cantidad <= 0) return i.reply({ content: "Cantidad invalida", ephemeral: true });
      if ((await getBalance(i.user.id)) < cantidad) return i.reply({ content: "No tienes suficiente", ephemeral: true });
      const resultado = Math.random() < 0.5 ? "cara" : "cruz";
      const win = resultado === eleccion;
      if (win) await addMoney(i.user.id, cantidad);
      else await addMoney(i.user.id, -cantidad);
      return i.reply("Moneda: **" + resultado + "**. " + (win ? "Ganaste" : "Perdiste") + " **" + cantidad + "**. Saldo: **" + (await getBalance(i.user.id)) + "**");
    }

    if (name === "slots") {
      const cantidad = i.options.getInteger("cantidad");
      if (cantidad <= 0) return i.reply({ content: "Cantidad invalida", ephemeral: true });
      if ((await getBalance(i.user.id)) < cantidad) return i.reply({ content: "No tienes suficiente", ephemeral: true });
      const symbols = ["cereza", "limon", "campana", "estrella", "siete"];
      const r = () => symbols[Math.floor(Math.random() * symbols.length)];
      const res = [r(), r(), r()];
      let win = false;
      let ganho = 0;
      if (res[0] === res[1] && res[1] === res[2]) {
        win = true;
        ganho = cantidad * 3;
      }
      await addMoney(i.user.id, win ? ganho : -cantidad);
      return i.reply("Slots: " + res.join(" | ") + "\n" + (win ? "Ganaste +" : "Perdiste -") + (win ? ganho : cantidad) + ". Saldo: **" + (await getBalance(i.user.id)) + "**");
    }

    if (name === "leaderboard") {
      const tipo = i.options.getString("tipo");
      let data = [];

      if (tipo === "money") {
        const users = await Economy.find({}).sort({ money: -1 }).limit(10);
        data = users.map(u => ({ id: u.userId, value: u.money + (u.bank || 0) }));
      } else {
        const users = await Level.find({}).sort({ level: -1 }).limit(10);
        data = users.map(u => ({ id: u.userId, value: u.level }));
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
      const embed = new EmbedBuilder()
        .setTitle("Bola Magica")
        .addFields(
          { name: "Pregunta", value: pregunta },
          { name: "Respuesta", value: respuesta }
        )
        .setColor("Purple");
      return i.reply({ embeds: [embed] });
    }

    if (name === "dado") {
      const caras = i.options.getInteger("caras") || 6;
      if (caras < 2 || caras > 100) return i.reply({ content: "Entre 2 y 100 caras", ephemeral: true });
      const resultado = Math.floor(Math.random() * caras) + 1;
      return i.reply("Lanzaste un dado de **" + caras + "** caras: **" + resultado + "**");
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

      const warnCount = await addWarn(target.id, i.guild.id, razon, i.user.id);

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
      const warns = await getWarns(target.id, i.guild.id);

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
      await clearWarns(target.id, i.guild.id);
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
      const status = await isPremium(i.user.id);
      const userData = await PremiumUser.findOne({ userId: i.user.id });

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
        .setColor(status ? "Gold" : "Grey")
        .setFooter({ text: "Premium te da ventajas exclusivas" });

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
      if (!(await isPremium(i.user.id))) {
        return i.reply({
          content: "Este comando es exclusivo para usuarios Premium. Usa /premium para mas info",
          ephemeral: true
        });
      }

      const u = await ensureUserEconomy(i.user.id);
      const cd = canUseCooldown(u.lastDaily, 12 * 60 * 60 * 1000);
      if (!cd.ok) return i.reply({ content: "Vuelve en **" + fmtMs(cd.left) + "**", ephemeral: true });

      const amount = Math.floor(Math.random() * 401) + 300;
      u.lastDaily = Date.now();
      await u.save();
      await addMoney(i.user.id, amount);

      return i.reply("Premium Daily: **+" + amount + "**! (12h cooldown)\nSaldo: **" + (await getBalance(i.user.id)) + "**");
    }

    if (name === "megaslots") {
      if (!(await isPremium(i.user.id))) {
        return i.reply({
          content: "Este comando es exclusivo para usuarios Premium. Usa /premium para mas info",
          ephemeral: true
        });
      }

      const cantidad = i.options.getInteger("cantidad");
      if (cantidad <= 0) return i.reply({ content: "Cantidad invalida", ephemeral: true });
      if ((await getBalance(i.user.id)) < cantidad) return i.reply({ content: "No tienes suficiente", ephemeral: true });

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
      await addMoney(i.user.id, ganancia);

      const embed = new EmbedBuilder()
        .setTitle("MEGA SLOTS")
        .setDescription("Resultado: " + res.join(" | "))
        .addFields(
          { name: "Resultado", value: multiplier > 0 ? "GANASTE x" + multiplier + "! +" + ganancia : "Perdiste -" + cantidad },
          { name: "Saldo", value: "**" + (await getBalance(i.user.id)) + "**" }
        )
        .setColor(multiplier > 0 ? "Green" : "Red");

      return i.reply({ embeds: [embed] });
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

    if (name === "setup") {
      if (!i.guild) return i.reply({ content: "Este comando solo funciona en servidores", ephemeral: true });

      const canalId = i.options.get("canal").value;
      const canal = await i.guild.channels.fetch(canalId).catch(() => null);

      if (!canal || canal.type !== ChannelType.GuildText) {
        return i.reply({ content: "Canal invalido. Debe ser un canal de texto", ephemeral: true });
      }

      const embed = new EmbedBuilder()
        .setTitle("Sistema de Tickets")
        .setDescription("Haz clic en el boton de abajo para crear un ticket de soporte.\n\nUn miembro del staff te atendera lo antes posible.")
        .setColor("Blue")
        .setFooter({ text: "Sistema de Soporte" })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("create_ticket")
          .setLabel("Crear Ticket")
          .setStyle(ButtonStyle.Primary)
      );

      try {
        await canal.send({ embeds: [embed], components: [row] });
        return i.reply({ content: "Panel de tickets creado en " + canal.toString(), ephemeral: true });
      } catch (error) {
        console.error("Error creando panel:", error);
        return i.reply({ content: "Error al crear el panel de tickets. Verifica que el bot tenga permisos", ephemeral: true });
      }
    }

    if (name === "announce") {
      if (!i.guild) return i.reply({ content: "Este comando solo funciona en servidores", ephemeral: true });

      const canalId = i.options.get("canal").value;
      const mensaje = i.options.getString("mensaje");
      const titulo = i.options.getString("titulo");

      const canal = await i.guild.channels.fetch(canalId).catch(() => null);

      if (!canal || canal.type !== ChannelType.GuildText) {
        return i.reply({ content: "Canal invalido. Debe ser un canal de texto", ephemeral: true });
      }

      const embed = new EmbedBuilder()
        .setDescription(mensaje)
        .setColor("Blue")
        .setTimestamp()
        .setFooter({ text: "Anuncio por " + i.user.username, iconURL: i.user.displayAvatarURL() });

      if (titulo) {
        embed.setTitle(titulo);
      }

      try {
        await canal.send({ embeds: [embed] });
        return i.reply({ content: "Anuncio enviado en " + canal.toString(), ephemeral: true });
      } catch (error) {
        console.error("Error enviando anuncio:", error);
        return i.reply({ content: "Error al enviar el anuncio. Verifica que el bot tenga permisos", ephemeral: true });
      }
    }

    if (name === "info") {
      const embed = new EmbedBuilder()
        .setTitle("Informacion del Bot")
        .setDescription("Bot multifuncional con economia, moderacion, juegos y sistema Premium")
        .setThumbnail(client.user.displayAvatarURL())
        .addFields(
          {
            name: "Economia",
            value: "/balance - Ver tu dinero\n/daily - Recompensa diaria\n/trabajar - Gana dinero\n/depositar / /retirar - Banco\n/transferir - Enviar dinero\n/leaderboard - Top usuarios"
          },
          {
            name: "Juegos",
            value: "/apostar - Apuesta dinero\n/coinflip - Cara o cruz\n/slots - Tragaperras\n/8ball - Bola magica\n/dado - Lanza un dado\n/meme - Memes aleatorios"
          },
          {
            name: "Moderacion",
            value: "/kick - Expulsar usuario\n/ban - Banear usuario\n/warn - Advertir usuario\n/warnings - Ver advertencias\n/clearwarns - Limpiar warns\n/timeout - Silenciar usuario\n/clear - Borrar mensajes"
          },
          {
            name: "Premium",
            value: "/premium - Info Premium\n/buypremium - Comprar Premium\n/premiumdaily - Daily mejorado\n/megaslots - Slots x5\nBeneficios: 2x XP, 50% mas recompensas"
          },
          {
            name: "Sistema de Tickets",
            value: "/setup - Crear panel de tickets\nLos usuarios pueden crear tickets privados\nStaff puede gestionar y cerrar tickets"
          },
          {
            name: "Utilidades",
            value: "/ping - Ver latencia\n/avatar - Ver avatar\n/userinfo - Info de usuario\n/serverinfo - Info del servidor\n/announce - Enviar anuncios\n/info - Este mensaje"
          },
          {
            name: "Sistema de Niveles",
            value: "Gana XP escribiendo mensajes\nSube de nivel automaticamente\nPremium obtiene 2x XP\n/leaderboard nivel - Top niveles"
          },
          {
            name: "Administracion",
            value: "Logs automaticos de eventos\nSistema de advertencias\nModeracion completa\nSistema de tickets personalizable"
          }
        )
        .setColor("Blue")
        .setFooter({ text: "Servidor: " + (i.guild ? i.guild.name : "DM") + " | Latencia: " + client.ws.ping + "ms" })
        .setTimestamp();

      return i.reply({ embeds: [embed] });
    }
  }

  if (i.isButton() && i.customId === "create_ticket") {
    if (!i.guild) return i.reply({ content: "Este comando solo funciona en servidores", ephemeral: true });

    const existingTicket = i.guild.channels.cache.find(
      c => c.name === "ticket-" + i.user.id && c.type === ChannelType.GuildText
    );

    if (existingTicket) {
      return i.reply({ content: "Ya tienes un ticket abierto: " + existingTicket.toString(), ephemeral: true });
    }

    const channel = await i.guild.channels.create({
      name: "ticket-" + i.user.id,
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
          .setTitle("Ticket de Soporte")
          .setDescription("Gracias por crear un ticket. El equipo te atendera pronto.\n\nDescribe tu problema o pregunta.")
          .setColor("Green")
          .setTimestamp(),
      ],
      components: [closeButton],
    });

    await i.reply({ content: "Ticket creado: " + channel.toString(), ephemeral: true });
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

// ========================== INICIO ==========================
(async () => {
  try {
    console.log("Iniciando bot...");
    await registerCommands();
    console.log("Intentando login...");
    await client.login(TOKEN);
  } catch (error) {
    console.error("Error iniciando el bot:", error);
    process.exit(1);
  }
})();