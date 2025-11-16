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

app.get("/", (req, res) => res.send("Bot activo"));

app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook error:", err.message);
    return res.status(400).send("Webhook Error");
  }
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId = session.metadata.userId;
    const tier = session.metadata.tier;
    if (userId && tier) {
      await activatePremium(userId, tier);
      console.log("Premium activado:", userId);
    }
  }
  res.json({ received: true });
});

app.use(express.json());
app.listen(PORT, () => console.log("Servidor web en puerto " + PORT));

// ========================== DATABASE ==========================
mongoose.connect(MONGO_URI)
  .then(() => console.log("MongoDB conectado"))
  .catch(err => console.error("Error MongoDB:", err));

// ========================== HELPERS ==========================
async function isPremium(userId) {
  const user = await PremiumUser.findOne({ userId });
  if (!user) return false;
  if (user.tier === "lifetime") return true;
  if (user.tier === "monthly" && user.expiresAt > Date.now()) return true;
  return false;
}

async function activatePremium(userId, tier) {
  await PremiumUser.findOneAndUpdate({ userId }, {
    userId, tier, activatedAt: Date.now(),
    expiresAt: tier === "monthly" ? Date.now() + 30 * 24 * 60 * 60 * 1000 : null,
  }, { upsert: true });
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

async function ensureUserEconomy(userId) {
  let user = await Economy.findOne({ userId });
  if (!user) user = await Economy.create({ userId, money: 200, bank: 0 });
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
  return { ok: (now - last) >= ms, left: Math.max(0, ms - (now - last)) };
}

function fmtMs(ms) {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h + "h " + m + "m " + ss + "s";
}

async function ensureUserLevel(userId) {
  let user = await Level.findOne({ userId });
  if (!user) user = await Level.create({ userId, xp: 0, level: 1 });
  return user;
}

async function tryAddXP(userId, channel) {
  const u = await ensureUserLevel(userId);
  const now = Date.now();
  if (now - u.lastGain < 60000) return;
  let gain = Math.floor(Math.random() * 11) + 5;
  if (await isPremium(userId)) gain *= 2;
  u.xp += gain;
  u.lastGain = now;
  const need = 100 * u.level;
  if (u.xp >= need) {
    u.level += 1;
    u.xp = 0;
    channel?.send("<@" + userId + "> subio a nivel " + u.level);
  }
  await u.save();
}

async function addWarn(userId, guildId, reason, moderatorId) {
  const key = guildId + "-" + userId;
  let doc = await Warning.findOne({ key });
  if (!doc) doc = await Warning.create({ key, warnings: [] });
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
  await Warning.deleteOne({ key: guildId + "-" + userId });
}

async function sendLog(guild, embed) {
  if (!LOGS_CHANNEL_ID) return;
  const ch = guild.channels.cache.get(LOGS_CHANNEL_ID);
  if (ch) await ch.send({ embeds: [embed] });
}

// ========================== COMANDOS ==========================
const commands = [
  new SlashCommandBuilder().setName("ping").setDescription("Ver latencia"),
  new SlashCommandBuilder().setName("balance").setDescription("Ver saldo"),
  new SlashCommandBuilder().setName("daily").setDescription("Recompensa diaria"),
  new SlashCommandBuilder().setName("trabajar").setDescription("Trabajar por dinero"),
  new SlashCommandBuilder().setName("apostar").setDescription("Apostar dinero").addIntegerOption(o => o.setName("cantidad").setDescription("Cantidad").setRequired(true)),
  new SlashCommandBuilder().setName("transferir").setDescription("Transferir dinero").addUserOption(o => o.setName("usuario").setDescription("Usuario").setRequired(true)).addIntegerOption(o => o.setName("cantidad").setDescription("Cantidad").setRequired(true)),
  new SlashCommandBuilder().setName("depositar").setDescription("Depositar en banco").addIntegerOption(o => o.setName("cantidad").setDescription("Cantidad").setRequired(true)),
  new SlashCommandBuilder().setName("retirar").setDescription("Retirar del banco").addIntegerOption(o => o.setName("cantidad").setDescription("Cantidad").setRequired(true)),
  new SlashCommandBuilder().setName("coinflip").setDescription("Cara o cruz").addStringOption(o => o.setName("eleccion").setDescription("cara o cruz").setRequired(true).addChoices({name:"cara",value:"cara"},{name:"cruz",value:"cruz"})).addIntegerOption(o => o.setName("cantidad").setDescription("Cantidad").setRequired(true)),
  new SlashCommandBuilder().setName("slots").setDescription("Tragaperras").addIntegerOption(o => o.setName("cantidad").setDescription("Cantidad").setRequired(true)),
  new SlashCommandBuilder().setName("8ball").setDescription("Bola magica").addStringOption(o => o.setName("pregunta").setDescription("Pregunta").setRequired(true)),
  new SlashCommandBuilder().setName("dado").setDescription("Lanzar dado").addIntegerOption(o => o.setName("caras").setDescription("Numero de caras")),
  new SlashCommandBuilder().setName("meme").setDescription("Meme aleatorio"),
  new SlashCommandBuilder().setName("avatar").setDescription("Ver avatar").addUserOption(o => o.setName("usuario").setDescription("Usuario")),
  new SlashCommandBuilder().setName("userinfo").setDescription("Info de usuario").addUserOption(o => o.setName("usuario").setDescription("Usuario")),
  new SlashCommandBuilder().setName("serverinfo").setDescription("Info del servidor"),
  new SlashCommandBuilder().setName("leaderboard").setDescription("Top usuarios").addStringOption(o => o.setName("tipo").setDescription("Tipo").setRequired(true).addChoices({name:"Dinero",value:"money"},{name:"Nivel",value:"level"})),
  new SlashCommandBuilder().setName("premium").setDescription("Info Premium"),
  new SlashCommandBuilder().setName("buypremium").setDescription("Comprar Premium").addStringOption(o => o.setName("plan").setDescription("Plan").setRequired(true).addChoices({name:"Mensual 3€/mes",value:"monthly"},{name:"Lifetime 30€",value:"lifetime"})),
  new SlashCommandBuilder().setName("premiumdaily").setDescription("[PREMIUM] Daily mejorado"),
  new SlashCommandBuilder().setName("megaslots").setDescription("[PREMIUM] Mega slots").addIntegerOption(o => o.setName("cantidad").setDescription("Cantidad").setRequired(true)),
  new SlashCommandBuilder().setName("givepremium").setDescription("[OWNER] Dar premium").addUserOption(o => o.setName("usuario").setDescription("Usuario").setRequired(true)).addStringOption(o => o.setName("plan").setDescription("Plan").setRequired(true).addChoices({name:"Mensual",value:"monthly"},{name:"Lifetime",value:"lifetime"})),
  new SlashCommandBuilder().setName("info").setDescription("Info del bot"),
  new SlashCommandBuilder().setName("kick").setDescription("Expulsar usuario").addUserOption(o => o.setName("usuario").setDescription("Usuario").setRequired(true)).addStringOption(o => o.setName("razon").setDescription("Razon")).setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
  new SlashCommandBuilder().setName("ban").setDescription("Banear usuario").addUserOption(o => o.setName("usuario").setDescription("Usuario").setRequired(true)).addStringOption(o => o.setName("razon").setDescription("Razon")).setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  new SlashCommandBuilder().setName("warn").setDescription("Advertir usuario").addUserOption(o => o.setName("usuario").setDescription("Usuario").setRequired(true)).addStringOption(o => o.setName("razon").setDescription("Razon").setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName("warnings").setDescription("Ver advertencias").addUserOption(o => o.setName("usuario").setDescription("Usuario").setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName("clearwarns").setDescription("Limpiar advertencias").addUserOption(o => o.setName("usuario").setDescription("Usuario").setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName("timeout").setDescription("Silenciar usuario").addUserOption(o => o.setName("usuario").setDescription("Usuario").setRequired(true)).addIntegerOption(o => o.setName("minutos").setDescription("Minutos").setRequired(true)).addStringOption(o => o.setName("razon").setDescription("Razon")).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName("clear").setDescription("Borrar mensajes").addIntegerOption(o => o.setName("cantidad").setDescription("Cantidad 1-100").setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  new SlashCommandBuilder().setName("setup").setDescription("[ADMIN] Setup tickets").addChannelOption(o => o.setName("canal").setDescription("Canal").setRequired(true).addChannelTypes(ChannelType.GuildText)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("announce").setDescription("[ADMIN] Anuncio").addChannelOption(o => o.setName("canal").setDescription("Canal").setRequired(true).addChannelTypes(ChannelType.GuildText)).addStringOption(o => o.setName("mensaje").setDescription("Mensaje").setRequired(true)).addStringOption(o => o.setName("titulo").setDescription("Titulo")).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(TOKEN);

async function registerCommands() {
  try {
    console.log("Registrando comandos...");
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("Comandos registrados OK");
  } catch (e) {
    console.error("Error comandos:", e.message);
  }
}

// ========================== EVENTOS ==========================
client.once("ready", () => {
  console.log("BOT ONLINE:", client.user.tag);
  client.user.setPresence({ activities: [{ name: "Ayudando servers" }], status: "online" });
});

client.on("messageCreate", async (msg) => {
  if (!msg.guild || msg.author.bot) return;
  await tryAddXP(msg.author.id, msg.channel);
});

client.on("guildMemberAdd", async (m) => {
  const e = new EmbedBuilder().setTitle("Miembro nuevo").setDescription(m.user.tag + " se unio").setColor("Green").setTimestamp();
  await sendLog(m.guild, e);
});

client.on("guildMemberRemove", async (m) => {
  const e = new EmbedBuilder().setTitle("Miembro salio").setDescription(m.user.tag + " salio").setColor("Red").setTimestamp();
  await sendLog(m.guild, e);
});

client.on("messageDelete", async (msg) => {
  if (!msg.guild || msg.author?.bot) return;
  const e = new EmbedBuilder().setTitle("Mensaje eliminado").setDescription("Autor: " + msg.author?.tag + "\nContenido: " + (msg.content || "N/A")).setColor("Orange").setTimestamp();
  await sendLog(msg.guild, e);
});

// ========================== COMANDOS HANDLER ==========================
client.on("interactionCreate", async (i) => {
  if (i.isButton()) {
    if (i.customId === "create_ticket") {
      if (!i.guild) return i.reply({ content: "Solo en servidores", ephemeral: true });
      const ex = i.guild.channels.cache.find(c => c.name === "ticket-" + i.user.id);
      if (ex) return i.reply({ content: "Ya tienes ticket: " + ex.toString(), ephemeral: true });
      
      const ch = await i.guild.channels.create({
        name: "ticket-" + i.user.id,
        type: ChannelType.GuildText,
        permissionOverwrites: [
          { id: i.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: i.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
          ...STAFF_ROLE_IDS.map(id => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] })),
        ],
      });
      
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("close_ticket").setLabel("Cerrar").setStyle(ButtonStyle.Danger)
      );
      
      await ch.send({
        content: "<@" + i.user.id + ">",
        embeds: [new EmbedBuilder().setTitle("Ticket").setDescription("Describe tu problema").setColor("Green")],
        components: [row]
      });
      
      return i.reply({ content: "Ticket creado: " + ch.toString(), ephemeral: true });
    }
    
    if (i.customId === "close_ticket") {
      const hasRole = i.member.roles.cache.some(r => STAFF_ROLE_IDS.includes(r.id));
      if (!hasRole && !i.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return i.reply({ content: "Solo staff", ephemeral: true });
      }
      await i.reply("Cerrando...");
      setTimeout(() => i.channel.delete(), 3000);
    }
    return;
  }
  
  if (!i.isChatInputCommand()) return;
  const cmd = i.commandName;
  
  try {
    if (cmd === "ping") return i.reply("Pong! " + client.ws.ping + "ms");
    
    if (cmd === "balance") {
      const u = await ensureUserEconomy(i.user.id);
      const e = new EmbedBuilder()
        .setTitle("Balance de " + i.user.username)
        .addFields(
          { name: "Efectivo", value: String(u.money), inline: true },
          { name: "Banco", value: String(u.bank || 0), inline: true },
          { name: "Total", value: String(u.money + (u.bank || 0)), inline: true }
        )
        .setColor("Green");
      if (await isPremium(i.user.id)) e.setFooter({ text: "Usuario Premium" });
      return i.reply({ embeds: [e] });
    }
    
    if (cmd === "daily") {
      const u = await ensureUserEconomy(i.user.id);
      const cd = canUseCooldown(u.lastDaily, 86400000);
      if (!cd.ok) return i.reply({ content: "Espera " + fmtMs(cd.left), ephemeral: true });
      let amt = 150;
      if (await isPremium(i.user.id)) amt = 225;
      u.lastDaily = Date.now();
      await u.save();
      await addMoney(i.user.id, amt);
      return i.reply("Daily: +" + amt + ". Saldo: **" + (await getBalance(i.user.id)) + "**");
    }
    
    if (cmd === "trabajar") {
      const u = await ensureUserEconomy(i.user.id);
      const cd = canUseCooldown(u.lastWork, 1800000);
      if (!cd.ok) return i.reply({ content: "Espera " + fmtMs(cd.left), ephemeral: true });
      let amt = Math.floor(Math.random() * 201) + 50;
      if (await isPremium(i.user.id)) amt = Math.floor(amt * 1.5);
      u.lastWork = Date.now();
      await u.save();
      await addMoney(i.user.id, amt);
      return i.reply("Trabajaste: +" + amt + ". Saldo: **" + (await getBalance(i.user.id)) + "**");
    }
    
    if (cmd === "apostar") {
      const amt = i.options.getInteger("cantidad");
      if (amt <= 0) return i.reply({ content: "Cantidad invalida", ephemeral: true });
      if ((await getBalance(i.user.id)) < amt) return i.reply({ content: "Sin fondos", ephemeral: true });
      const win = Math.random() < 0.5;
      await addMoney(i.user.id, win ? amt : -amt);
      return i.reply((win ? "Ganaste +" : "Perdiste -") + amt + ". Saldo: **" + (await getBalance(i.user.id)) + "**");
    }
    
    if (cmd === "transferir") {
      const target = i.options.getUser("usuario");
      const amt = i.options.getInteger("cantidad");
      if (target.bot || target.id === i.user.id) return i.reply({ content: "Invalido", ephemeral: true });
      if (amt <= 0) return i.reply({ content: "Cantidad invalida", ephemeral: true });
      if ((await getBalance(i.user.id)) < amt) return i.reply({ content: "Sin fondos", ephemeral: true });
      await addMoney(i.user.id, -amt);
      await addMoney(target.id, amt);
      return i.reply("Transferiste **" + amt + "** a " + target.username);
    }
    
    if (cmd === "depositar") {
      const amt = i.options.getInteger("cantidad");
      if (amt <= 0) return i.reply({ content: "Invalido", ephemeral: true });
      const u = await ensureUserEconomy(i.user.id);
      if (u.money < amt) return i.reply({ content: "Sin fondos", ephemeral: true });
      u.money -= amt;
      u.bank = (u.bank || 0) + amt;
      await u.save();
      return i.reply("Depositaste **" + amt + "**. Banco: **" + u.bank + "**");
    }
    
    if (cmd === "retirar") {
      const amt = i.options.getInteger("cantidad");
      if (amt <= 0) return i.reply({ content: "Invalido", ephemeral: true });
      const u = await ensureUserEconomy(i.user.id);
      if ((u.bank || 0) < amt) return i.reply({ content: "Sin fondos", ephemeral: true });
      u.bank -= amt;
      u.money += amt;
      await u.save();
      return i.reply("Retiraste **" + amt + "**. Efectivo: **" + u.money + "**");
    }
    
    if (cmd === "coinflip") {
      const choice = i.options.getString("eleccion");
      const amt = i.options.getInteger("cantidad");
      if (amt <= 0) return i.reply({ content: "Invalido", ephemeral: true });
      if ((await getBalance(i.user.id)) < amt) return i.reply({ content: "Sin fondos", ephemeral: true });
      const res = Math.random() < 0.5 ? "cara" : "cruz";
      const win = res === choice;
      await addMoney(i.user.id, win ? amt : -amt);
      return i.reply("Resultado: **" + res + "**. " + (win ? "Ganaste +" : "Perdiste -") + amt);
    }
    
    if (cmd === "slots") {
      const amt = i.options.getInteger("cantidad");
      if (amt <= 0) return i.reply({ content: "Invalido", ephemeral: true });
      if ((await getBalance(i.user.id)) < amt) return i.reply({ content: "Sin fondos", ephemeral: true });
      const syms = ["cereza", "limon", "campana", "estrella", "siete"];
      const r = [syms[Math.floor(Math.random()*5)], syms[Math.floor(Math.random()*5)], syms[Math.floor(Math.random()*5)]];
      const win = r[0] === r[1] && r[1] === r[2];
      const prize = win ? amt * 3 : -amt;
      await addMoney(i.user.id, prize);
      return i.reply("Slots: " + r.join(" | ") + "\n" + (win ? "Ganaste +" + (amt*3) : "Perdiste -" + amt));
    }
    
    if (cmd === "8ball") {
      const q = i.options.getString("pregunta");
      const ans = ["Si","No","Tal vez","Definitivamente","No lo creo","Pregunta de nuevo","Sin duda","No cuentes con ello","Es probable","No es seguro"];
      const e = new EmbedBuilder()
        .setTitle("Bola Magica")
        .addFields({name:"Pregunta",value:q},{name:"Respuesta",value:ans[Math.floor(Math.random()*ans.length)]})
        .setColor("Purple");
      return i.reply({embeds:[e]});
    }
    
    if (cmd === "dado") {
      const faces = i.options.getInteger("caras") || 6;
      if (faces < 2 || faces > 100) return i.reply({ content: "Entre 2-100", ephemeral: true });
      const res = Math.floor(Math.random() * faces) + 1;
      return i.reply("Dado de **" + faces + "**: **" + res + "**");
    }
    
    if (cmd === "meme") {
      const memes = [
        "https://i.imgur.com/2Z8QZ0M.jpg",
        "https://i.imgur.com/7gFqrNs.jpg",
        "https://i.imgur.com/xGQ4k2l.jpg"
      ];
      const e = new EmbedBuilder().setTitle("Meme").setImage(memes[Math.floor(Math.random()*memes.length)]).setColor("Random");
      return i.reply({embeds:[e]});
    }
    
    if (cmd === "avatar") {
      const u = i.options.getUser("usuario") || i.user;
      const e = new EmbedBuilder().setTitle("Avatar de " + u.username).setImage(u.displayAvatarURL({size:1024})).setColor("Blue");
      return i.reply({embeds:[e]});
    }
    
    if (cmd === "userinfo") {
      const u = i.options.getUser("usuario") || i.user;
      if (!i.guild) return i.reply({ content: "Solo servidores", ephemeral: true });
      const m = await i.guild.members.fetch(u.id);
      const e = new EmbedBuilder()
        .setTitle("Info: " + u.username)
        .setThumbnail(u.displayAvatarURL())
        .addFields(
          {name:"ID",value:u.id,inline:true},
          {name:"Creado",value:"<t:" + Math.floor(u.createdTimestamp/1000) + ":R>",inline:true},
          {name:"Se unio",value:"<t:" + Math.floor(m.joinedTimestamp/1000) + ":R>",inline:true}
        )
        .setColor("Purple");
      return i.reply({embeds:[e]});
    }
    
    if (cmd === "serverinfo") {
      if (!i.guild) return i.reply({ content: "Solo servidores", ephemeral: true });
      const g = i.guild;
      const e = new EmbedBuilder()
        .setTitle(g.name)
        .setThumbnail(g.iconURL())
        .addFields(
          {name:"Miembros",value:String(g.memberCount),inline:true},
          {name:"Creado",value:"<t:" + Math.floor(g.createdTimestamp/1000) + ":R>",inline:true},
          {name:"Owner",value:"<@" + g.ownerId + ">",inline:true}
        )
        .setColor("Gold");
      return i.reply({embeds:[e]});
    }
    
    if (cmd === "leaderboard") {
      const type = i.options.getString("tipo");
      let data = [];
      if (type === "money") {
        const users = await Economy.find({}).sort({money:-1}).limit(10);
        data = users.map(u => ({id:u.userId,val:u.money+(u.```javascript
        data = users.map(u => ({id:u.userId,val:u.money+(u.bank||0)}));
      } else {
        const users = await Level.find({}).sort({level:-1}).limit(10);
        data = users.map(u => ({id:u.userId,val:u.level}));
      }
      const desc = data.map((d,i) => "**" + (i+1) + ".** <@" + d.id + "> - " + (type==="money"?"$"+d.val:"Nivel "+d.val)).join("\n") || "Sin datos";
      const e = new EmbedBuilder().setTitle("Top " + (type==="money"?"Dinero":"Niveles")).setDescription(desc).setColor("Gold");
      return i.reply({embeds:[e]});
    }
    
    if (cmd === "premium") {
      const status = await isPremium(i.user.id);
      const userData = await PremiumUser.findOne({userId:i.user.id});
      const e = new EmbedBuilder()
        .setTitle("Sistema Premium")
        .setDescription(status ? "Eres Premium!\nPlan: " + (userData.tier==="monthly"?"Mensual":"Lifetime") : "No tienes Premium")
        .addFields(
          {name:"Beneficios",value:"2x XP en mensajes\n50% mas recompensas\nComandos exclusivos"},
          {name:"Planes",value:"Mensual: 3€/mes\nLifetime: 30€ (pago unico)"}
        )
        .setColor(status?"Gold":"Grey");
      return i.reply({embeds:[e]});
    }
    
    if (cmd === "buypremium") {
      const plan = i.options.getString("plan");
      try {
        const url = await createCheckoutSession(i.user.id, plan);
        const e = new EmbedBuilder()
          .setTitle("Checkout Premium")
          .setDescription("Haz clic abajo para completar el pago\n\nPlan: " + (plan==="monthly"?"Mensual 3€/mes":"Lifetime 30€"))
          .setColor("Gold");
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel("Ir al Checkout").setStyle(ButtonStyle.Link).setURL(url)
        );
        return i.reply({embeds:[e],components:[row],ephemeral:true});
      } catch (e) {
        console.error("Error checkout:", e);
        return i.reply({content:"Error creando checkout",ephemeral:true});
      }
    }
    
    if (cmd === "premiumdaily") {
      if (!(await isPremium(i.user.id))) return i.reply({content:"Solo Premium. Usa /premium",ephemeral:true});
      const u = await ensureUserEconomy(i.user.id);
      const cd = canUseCooldown(u.lastDaily, 43200000);
      if (!cd.ok) return i.reply({content:"Espera " + fmtMs(cd.left),ephemeral:true});
      const amt = 350;
      u.lastDaily = Date.now();
      await u.save();
      await addMoney(i.user.id, amt);
      return i.reply("Premium Daily: +" + amt + " (12h cooldown). Saldo: **" + (await getBalance(i.user.id)) + "**");
    }
    
    if (cmd === "megaslots") {
      if (!(await isPremium(i.user.id))) return i.reply({content:"Solo Premium. Usa /premium",ephemeral:true});
      const amt = i.options.getInteger("cantidad");
      if (amt <= 0) return i.reply({content:"Invalido",ephemeral:true});
      if ((await getBalance(i.user.id)) < amt) return i.reply({content:"Sin fondos",ephemeral:true});
      const syms = ["diamante","estrella","corona","fuego","dinero"];
      const r = [syms[Math.floor(Math.random()*5)],syms[Math.floor(Math.random()*5)],syms[Math.floor(Math.random()*5)]];
      let mult = 0;
      if (r[0]===r[1] && r[1]===r[2]) mult = 5;
      else if (r[0]===r[1] || r[1]===r[2] || r[0]===r[2]) mult = 2;
      const prize = mult > 0 ? amt * mult : -amt;
      await addMoney(i.user.id, prize);
      const e = new EmbedBuilder()
        .setTitle("MEGA SLOTS")
        .setDescription("Resultado: " + r.join(" | "))
        .addFields(
          {name:"Resultado",value:mult>0?"GANASTE x"+mult+"! +"+prize:"Perdiste -"+amt},
          {name:"Saldo",value:"**"+(await getBalance(i.user.id))+"**"}
        )
        .setColor(mult>0?"Green":"Red");
      return i.reply({embeds:[e]});
    }
    
    if (cmd === "givepremium") {
      if (i.user.id !== OWNER_ID) return i.reply({content:"Solo owner",ephemeral:true});
      const target = i.options.getUser("usuario");
      const plan = i.options.getString("plan");
      await activatePremium(target.id, plan);
      const e = new EmbedBuilder()
        .setTitle("Premium Otorgado")
        .setDescription("Premium activado para " + target.username)
        .addFields(
          {name:"Usuario",value:"<@"+target.id+">",inline:true},
          {name:"Plan",value:plan==="monthly"?"Mensual (30 dias)":"Lifetime",inline:true},
          {name:"Por",value:"<@"+i.user.id+">",inline:true}
        )
        .setColor("Gold")
        .setTimestamp();
      console.log("Premium dado: " + target.tag + " - " + plan);
      return i.reply({embeds:[e],ephemeral:true});
    }
    
    if (cmd === "info") {
      const e = new EmbedBuilder()
        .setTitle("Info del Bot")
        .setDescription("Bot multifuncional con economia, niveles, moderacion y Premium")
        .setThumbnail(client.user.displayAvatarURL())
        .addFields(
          {name:"Economia",value:"/balance /daily /trabajar /apostar /transferir /depositar /retirar"},
          {name:"Juegos",value:"/coinflip /slots /8ball /dado /meme"},
          {name:"Info",value:"/avatar /userinfo /serverinfo /leaderboard"},
          {name:"Premium",value:"/premium /buypremium /premiumdaily /megaslots"},
          {name:"Moderacion",value:"/kick /ban /warn /warnings /clearwarns /timeout /clear"},
          {name:"Admin",value:"/setup /announce /givepremium"},
          {name:"Sistema",value:"Sistema de niveles automatico con XP por mensajes"}
        )
        .setColor("Blue")
        .setFooter({text:"Latencia: " + client.ws.ping + "ms"})
        .setTimestamp();
      return i.reply({embeds:[e]});
    }
    
    if (cmd === "kick") {
      if (!i.guild) return i.reply({content:"Solo servidores",ephemeral:true});
      const target = i.options.getUser("usuario");
      const razon = i.options.getString("razon") || "Sin razon";
      const member = await i.guild.members.fetch(target.id);
      if (!member.kickable) return i.reply({content:"No puedo expulsar",ephemeral:true});
      await member.kick(razon);
      const e = new EmbedBuilder()
        .setTitle("Usuario Expulsado")
        .addFields(
          {name:"Usuario",value:target.tag},
          {name:"Moderador",value:i.user.tag},
          {name:"Razon",value:razon}
        )
        .setColor("Orange")
        .setTimestamp();
      await sendLog(i.guild, e);
      return i.reply({embeds:[e]});
    }
    
    if (cmd === "ban") {
      if (!i.guild) return i.reply({content:"Solo servidores",ephemeral:true});
      const target = i.options.getUser("usuario");
      const razon = i.options.getString("razon") || "Sin razon";
      const member = await i.guild.members.fetch(target.id).catch(()=>null);
      if (member && !member.bannable) return i.reply({content:"No puedo banear",ephemeral:true});
      await i.guild.members.ban(target.id, {reason:razon});
      const e = new EmbedBuilder()
        .setTitle("Usuario Baneado")
        .addFields(
          {name:"Usuario",value:target.tag},
          {name:"Moderador",value:i.user.tag},
          {name:"Razon",value:razon}
        )
        .setColor("Red")
        .setTimestamp();
      await sendLog(i.guild, e);
      return i.reply({embeds:[e]});
    }
    
    if (cmd === "warn") {
      if (!i.guild) return i.reply({content:"Solo servidores",ephemeral:true});
      const target = i.options.getUser("usuario");
      const razon = i.options.getString("razon");
      if (target.bot) return i.reply({content:"No puedes advertir bots",ephemeral:true});
      const count = await addWarn(target.id, i.guild.id, razon, i.user.id);
      const e = new EmbedBuilder()
        .setTitle("Usuario Advertido")
        .addFields(
          {name:"Usuario",value:target.tag},
          {name:"Moderador",value:i.user.tag},
          {name:"Razon",value:razon},
          {name:"Total warns",value:String(count)}
        )
        .setColor("Yellow")
        .setTimestamp();
      await sendLog(i.guild, e);
      return i.reply({embeds:[e]});
    }
    
    if (cmd === "warnings") {
      if (!i.guild) return i.reply({content:"Solo servidores",ephemeral:true});
      const target = i.options.getUser("usuario");
      const warns = await getWarns(target.id, i.guild.id);
      if (warns.length === 0) return i.reply({content:target.username + " no tiene warns",ephemeral:true});
      const desc = warns.map((w,idx)=>"**"+(idx+1)+".** <@"+w.moderatorId+"> - "+w.reason+"\n<t:"+Math.floor(w.timestamp/1000)+":R>").join("\n\n");
      const e = new EmbedBuilder()
        .setTitle("Advertencias de " + target.username)
        .setDescription(desc)
        .setColor("Yellow");
      return i.reply({embeds:[e],ephemeral:true});
    }
    
    if (cmd === "clearwarns") {
      if (!i.guild) return i.reply({content:"Solo servidores",ephemeral:true});
      const target = i.options.getUser("usuario");
      await clearWarns(target.id, i.guild.id);
      return i.reply("Advertencias de " + target.username + " limpiadas");
    }
    
    if (cmd === "timeout") {
      if (!i.guild) return i.reply({content:"Solo servidores",ephemeral:true});
      const target = i.options.getUser("usuario");
      const mins = i.options.getInteger("minutos");
      const razon = i.options.getString("razon") || "Sin razon";
      if (mins < 1 || mins > 40320) return i.reply({content:"Entre 1 min y 28 dias",ephemeral:true});
      const member = await i.guild.members.fetch(target.id);
      if (!member.moderatable) return i.reply({content:"No puedo silenciar",ephemeral:true});
      await member.timeout(mins * 60 * 1000, razon);
      const e = new EmbedBuilder()
        .setTitle("Usuario Silenciado")
        .addFields(
          {name:"Usuario",value:target.tag},
          {name:"Moderador",value:i.user.tag},
          {name:"Duracion",value:mins + " minutos"},
          {name:"Razon",value:razon}
        )
        .setColor("DarkRed")
        .setTimestamp();
      await sendLog(i.guild, e);
      return i.reply({embeds:[e]});
    }
    
    if (cmd === "clear") {
      if (!i.guild) return i.reply({content:"Solo servidores",ephemeral:true});
      const amt = i.options.getInteger("cantidad");
      if (amt < 1 || amt > 100) return i.reply({content:"Entre 1-100",ephemeral:true});
      const deleted = await i.channel.bulkDelete(amt, true);
      return i.reply({content:"Eliminados **" + deleted.size + "** mensajes",ephemeral:true});
    }
    
    if (cmd === "setup") {
      if (!i.guild) return i.reply({content:"Solo servidores",ephemeral:true});
      const canalId = i.options.get("canal").value;
      const canal = await i.guild.channels.fetch(canalId).catch(()=>null);
      if (!canal || canal.type !== ChannelType.GuildText) return i.reply({content:"Canal invalido",ephemeral:true});
      const e = new EmbedBuilder()
        .setTitle("Sistema de Tickets")
        .setDescription("Haz clic en el boton para crear un ticket de soporte.\n\nUn miembro del staff te atendera pronto.")
        .setColor("Blue")
        .setFooter({text:"Sistema de Soporte"})
        .setTimestamp();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("create_ticket").setLabel("Crear Ticket").setStyle(ButtonStyle.Primary)
      );
      try {
        await canal.send({embeds:[e],components:[row]});
        return i.reply({content:"Panel creado en " + canal.toString(),ephemeral:true});
      } catch (err) {
        console.error("Error setup:", err);
        return i.reply({content:"Error creando panel",ephemeral:true});
      }
    }
    
    if (cmd === "announce") {
      if (!i.guild) return i.reply({content:"Solo servidores",ephemeral:true});
      const canalId = i.options.get("canal").value;
      const mensaje = i.options.getString("mensaje");
      const titulo = i.options.getString("titulo");
      const canal = await i.guild.channels.fetch(canalId).catch(()=>null);
      if (!canal || canal.type !== ChannelType.GuildText) return i.reply({content:"Canal invalido",ephemeral:true});
      const e = new EmbedBuilder()
        .setDescription(mensaje)
        .setColor("Blue")
        .setTimestamp()
        .setFooter({text:"Anuncio por " + i.user.username, iconURL:i.user.displayAvatarURL()});
      if (titulo) e.setTitle(titulo);
      try {
        await canal.send({embeds:[e]});
        return i.reply({content:"Anuncio enviado en " + canal.toString(),ephemeral:true});
      } catch (err) {
        console.error("Error announce:", err);
        return i.reply({content:"Error enviando anuncio",ephemeral:true});
      }
    }
    
  } catch (error) {
    console.error("Error comando " + cmd + ":", error);
    if (!i.replied && !i.deferred) {
      await i.reply({content:"Error ejecutando comando",ephemeral:true}).catch(()=>{});
    }
  }
});

// ========================== INICIO ==========================
(async () => {
  try {
    await registerCommands();
    await client.login(TOKEN);
  } catch (error) {
    console.error("ERROR FATAL:", error);
    process.exit(1);
  }
})();