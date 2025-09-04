// ========================== IMPORTS ==========================
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
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
const GUILD_ID = process.env.GUILD_ID;

const STAFF_ROLE_IDS = [
  "1405183233293025382",
  "1405183143501103236",
  "1405183318688796803",
];

// ========================== CLIENT ==========================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// ========================== WEB SERVER ==========================
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (_req, res) => res.send("✅ Bot activo y listo para pings."));
app.listen(PORT, () => console.log(`🌐 Web escuchando en puerto ${PORT}`));

// ========================== PERSISTENCIA ==========================
const ECON_PATH = path.join(__dirname, "economy.json");
const XP_PATH = path.join(__dirname, "xp.json");

let economy = {};
let levels = {};

function loadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`⚠️ Error leyendo ${file}:`, e);
  }
  return fallback;
}
function saveJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`⚠️ Error guardando ${file}:`, e);
  }
}

economy = loadJSON(ECON_PATH, {});
levels = loadJSON(XP_PATH, {});

// ========================== ECONOMÍA HELPERS ==========================
function ensureUserEconomy(userId) {
  if (!economy[userId]) economy[userId] = { money: 200, lastDaily: 0, lastWork: 0 };
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
  return `${h}h ${m}m ${ss}s`;
}

// ========================== XP / NIVELES HELPERS ==========================
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
  const gain = Math.floor(Math.random() * 11) + 5;
  u.xp += gain;
  u.lastGain = now;

  const need = neededXP(u.level);
  if (u.xp >= need) {
    u.level += 1;
    u.xp = 0;
    channel?.send(`⭐ <@${userId}> subió a **nivel ${u.level}**!`);
  }
  saveJSON(XP_PATH, levels);
}

// ========================== SLASH COMMANDS ==========================
const slashDefs = [
  new SlashCommandBuilder().setName("ping").setDescription("Responde con Pong!"),

  new SlashCommandBuilder().setName("balance").setDescription("Muestra tu saldo"),

  new SlashCommandBuilder().setName("daily").setDescription("Reclama tu recompensa diaria"),

  new SlashCommandBuilder().setName("trabajar").setDescription("Trabaja para ganar dinero"),

  new SlashCommandBuilder()
    .setName("apostar")
    .setDescription("Apuesta dinero")
    .addIntegerOption(o =>
      o.setName("cantidad").setDescription("Cantidad a apostar").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("transferir")
    .setDescription("Transfiere dinero a otro usuario")
    .addUserOption(o =>
      o.setName("usuario").setDescription("El usuario al que transferirás").setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName("cantidad").setDescription("Cantidad a transferir").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("coinflip")
    .setDescription("Apuesta en cara o cruz")
    .addStringOption(o =>
      o.setName("eleccion")
        .setDescription("Elige cara o cruz")
        .setRequired(true)
        .addChoices({ name: "cara", value: "cara" }, { name: "cruz", value: "cruz" })
    )
    .addIntegerOption(o =>
      o.setName("cantidad").setDescription("Cantidad a apostar").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("slots")
    .setDescription("Juega a las tragaperras")
    .addIntegerOption(o =>
      o.setName("cantidad").setDescription("Cantidad a apostar").setRequired(true)
    ),
].map(cmd => cmd.toJSON());

// ========================== REGISTRO DE COMANDOS ==========================
const rest = new REST({ version: "10" }).setToken(TOKEN);

async function registerCommands() {
  try {
    console.log("⚙️ Registrando slash commands…");
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: slashDefs });
    console.log("✅ Comandos registrados en el servidor.");
  } catch (e) {
    console.error("❌ Error registrando comandos:", e);
  }
}

// ========================== READY ==========================
client.once("ready", () => console.log(`🤖 Conectado como ${client.user.tag}`));

// ========================== XP POR MENSAJE ==========================
client.on("messageCreate", (msg) => {
  if (!msg.guild || msg.author.bot) return;
  tryAddXP(msg.author.id, msg.channel);
});

// ========================== INTERACCIONES ==========================
client.on("interactionCreate", async (i) => {
  if (i.isChatInputCommand()) {
    const name = i.commandName;

    // ---------- Utilidad ----------
    if (name === "ping") return i.reply(`🏓 Pong! Latencia WS: **${client.ws.ping}ms**`);

    // ---------- ECONOMÍA ----------
    if (name === "balance") return i.reply(`💰 ${i.user.username}, tu saldo es **${getBalance(i.user.id)}**.`);

    if (name === "daily") {
      const u = ensureUserEconomy(i.user.id);
      const cd = canUseCooldown(u.lastDaily, 24 * 60 * 60 * 1000);
      if (!cd.ok) return i.reply({ content: `⏳ Vuelve en **${fmtMs(cd.left)}**.`, ephemeral: true });
      const amount = Math.floor(Math.random() * 201) + 100;
      u.lastDaily = Date.now();
      addMoney(i.user.id, amount);
      return i.reply(`🎁 Daily cobrado: **+${amount}**. Nuevo saldo: **${getBalance(i.user.id)}**`);
    }

    if (name === "trabajar") {
      const u = ensureUserEconomy(i.user.id);
      const cd = canUseCooldown(u.lastWork, 30 * 60 * 1000);
      if (!cd.ok) return i.reply({ content: `⏳ Podrás trabajar en **${fmtMs(cd.left)}**.`, ephemeral: true });
      const amount = Math.floor(Math.random() * 251) + 50;
      u.lastWork = Date.now();
      addMoney(i.user.id, amount);
      return i.reply(`🛠️ Trabajaste y ganaste **+${amount}**. Saldo: **${getBalance(i.user.id)}**`);
    }

    if (name === "apostar") {
      const cantidad = i.options.getInteger("cantidad", true);
      if (cantidad <= 0) return i.reply({ content: "❌ Cantidad inválida.", ephemeral: true });
      if (getBalance(i.user.id) < cantidad) return i.reply({ content: "❌ No tienes suficiente dinero.", ephemeral: true });
      const win = Math.random() < 0.5;
      if (win) {
        addMoney(i.user.id, cantidad);
        return i.reply(`🎉 Ganaste **+${cantidad}**. Saldo: **${getBalance(i.user.id)}**`);
      } else {
        addMoney(i.user.id, -cantidad);
        return i.reply(`💸 Perdiste **-${cantidad}**. Saldo: **${getBalance(i.user.id)}**`);
      }
    }

    if (name === "transferir") {
      const target = i.options.getUser("usuario", true);
      const cantidad = i.options.getInteger("cantidad", true);
      if (target.bot || target.id === i.user.id) return i.reply({ content: "❌ No puedes transferirte a ti o a bots.", ephemeral: true });
      if (cantidad <= 0) return i.reply({ content: "❌ Cantidad inválida.", ephemeral: true });
      if (getBalance(i.user.id) < cantidad) return i.reply({ content: "❌ No tienes suficiente dinero.", ephemeral: true });
      addMoney(i.user.id, -cantidad);
      addMoney(target.id, cantidad);
      return i.reply(`✅ Transferiste **${cantidad}** a **${target.username}**. Tu saldo: **${getBalance(i.user.id)}**`);
    }

    // ---------- Juegos ----------
    if (name === "coinflip") {
      const eleccion = i.options.getString("eleccion", true).toLowerCase();
      const cantidad = i.options.getInteger("cantidad", true);
      if (!["cara","cruz"].includes(eleccion)) return i.reply({ content: "❌ Elige `cara` o `cruz`.", ephemeral:true });
      if (cantidad <= 0) return i.reply({ content: "❌ Cantidad inválida.", ephemeral:true });
      if (getBalance(i.user.id) < cantidad) return i.reply({ content: "❌ No tienes suficiente dinero.", ephemeral:true });
      const resultado = Math.random() < 0.5 ? "cara" : "cruz";
      const win = resultado === eleccion;
      if (win) addMoney(i.user.id, cantidad);
      else addMoney(i.user.id, -cantidad);
      return i.reply(`🪙 Salió **${resultado}**. ${win?"Ganaste":"Perdiste"} **${cantidad}**. Saldo: **${getBalance(i.user.id)}**`);
    }

    if (name === "slots") {
      const cantidad = i.options.getInteger("cantidad", true);
      if (cantidad <= 0) return i.reply({ content: "❌ Cantidad inválida.", ephemeral:true });
      if (getBalance(i.user.id) < cantidad) return i.reply({ content: "❌ No tienes suficiente dinero.", ephemeral:true });
      const symbols = ["🍒","🍋","🔔","⭐","7️⃣"];
      const r = ()=>symbols[Math.floor(Math.random()*symbols.length)];
      const res = [r(), r(), r()];
      let win = false;
      let ganho = 0;
      if (res[0]===res[1]&&res[1]===res[2]){
        win = true;
        ganho = cantidad*3;
      }
      addMoney(i.user.id, win?ganho:-cantidad);
      return i.reply(`🎰 ${res.join(" | ")}\n${win?"Ganaste":"Perdiste"} ${win?ganho: cantidad}. Saldo: **${getBalance(i.user.id)}**`);
    }
  }

  // ---------- BOTONES (TICKETS) ----------
  if (i.isButton() && (i.customId === "support_es" || i.customId === "support_en")) {
    const channel = await i.guild.channels.create({
      name: `ticket-${i.user.username}`,
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

    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(i.customId === "support_es" ? "🎫 Ticket de Soporte" : "🎫 Support Ticket")
          .setDescription(
            i.customId === "support_es"
              ? "Gracias por crear un ticket. El equipo de soporte te atenderá pronto."
              : "Thanks for creating a ticket. The support team will assist you shortly."
          )
          .setColor("Green"),
      ],
    });

    await i.reply({ content: `✅ Ticket creado: ${channel}`, ephemeral: true });
  }
});

// ========================== START ==========================
(async () => {
  await registerCommands();
  await client.login(TOKEN);
})();
