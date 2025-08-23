// index.js
require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
} = require("discord.js");

// ========================== CONFIG ==========================
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null; // si lo pones, registra en guild; si no, global
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID || null; // rol opcional para ver tickets

if (!TOKEN || !CLIENT_ID) {
  console.error("❌ Falta TOKEN o CLIENT_ID en .env");
  process.exit(1);
}

// ========================== WEB SERVER (PING) ==========================
const app = express();
app.get("/", (_req, res) => res.send("✅ Bot activo y listo para pings."));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web escuchando en puerto ${PORT}`));

// ========================== DISCORD CLIENT ==========================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// ========================== PERSISTENCIA (JSON) ==========================
const ECON_PATH = path.join(__dirname, "economy.json");
const XP_PATH = path.join(__dirname, "xp.json");

let economy = {};
let levels = {};

function loadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
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

economy = loadJSON(ECON_PATH, {}); // { [userId]: { money, lastDaily, lastWork } }
levels = loadJSON(XP_PATH, {});    // { [userId]: { xp, level, lastGain } }

// ========================== ECONOMÍA HELPERS ==========================
function ensureUserEconomy(userId) {
  if (!economy[userId]) {
    economy[userId] = { money: 200, lastDaily: 0, lastWork: 0 };
  }
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
  return 100 * level; // simple: nivel 1→100, 2→200, etc.
}
function tryAddXP(userId, channel) {
  const u = ensureUserLevel(userId);
  const now = Date.now();
  // cooldown 60s por XP para evitar spam
  if (now - u.lastGain < 60_000) return;
  const gain = Math.floor(Math.random() * 11) + 5; // 5-15 XP
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
  // Utilidad
  new SlashCommandBuilder().setName("ping").setDescription("🏓 Pong!"),
  new SlashCommandBuilder().setName("help").setDescription("📖 Lista de comandos"),
  new SlashCommandBuilder()
    .setName("vicecasino")
    .setDescription("🎰 Información sobre Vice Casino"),
  new SlashCommandBuilder()
    .setName("anuncio")
    .setDescription("📢 Enviar anuncio (requiere ManageGuild)")
    .addStringOption(o => o.setName("mensaje").setDescription("Contenido del anuncio").setRequired(true))
    .addBooleanOption(o => o.setName("everyone").setDescription("Mencionar a todos (@everyone)?").setRequired(false)),
  new SlashCommandBuilder()
    .setName("sugerencia")
    .setDescription("💡 Enviar sugerencia")
    .addStringOption(o => o.setName("texto").setDescription("Tu sugerencia").setRequired(true)),

  // Economía
  new SlashCommandBuilder().setName("balance").setDescription("💰 Ver tu saldo"),
  new SlashCommandBuilder().setName("daily").setDescription("🎁 Recompensa diaria"),
  new SlashCommandBuilder().setName("trabajar").setDescription("🛠️ Trabajar para ganar dinero"),
  new SlashCommandBuilder()
    .setName("apostar")
    .setDescription("🎲 Apostar una cantidad (50% de ganar)")
    .addIntegerOption(o => o.setName("cantidad").setDescription("Cantidad a apostar").setRequired(true)),
  new SlashCommandBuilder()
    .setName("transferir")
    .setDescription("💸 Transferir dinero a otro usuario")
    .addUserOption(o => o.setName("usuario").setDescription("Receptor").setRequired(true))
    .addIntegerOption(o => o.setName("cantidad").setDescription("Cantidad").setRequired(true)),

  // Juegos (ligados a economía)
  new SlashCommandBuilder()
    .setName("coinflip")
    .setDescription("🪙 Cara o cruz apostando")
    .addStringOption(o => o.setName("eleccion").setDescription("cara | cruz").setRequired(true))
    .addIntegerOption(o => o.setName("cantidad").setDescription("Cantidad a apostar").setRequired(true)),
  new SlashCommandBuilder()
    .setName("slots")
    .setDescription("🎰 Tragaperras: apuesta y gira")
    .addIntegerOption(o => o.setName("cantidad").setDescription("Cantidad a apostar").setRequired(true)),

  // Tickets
  new SlashCommandBuilder().setName("ticket").setDescription("🎟️ Abrir ticket"),
  new SlashCommandBuilder().setName("close").setDescription("❌ Cerrar ticket actual"),

  // Moderación
  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("🚫 Banear usuario")
    .addUserOption(o => o.setName("usuario").setDescription("Usuario a banear").setRequired(true))
    .addStringOption(o => o.setName("razon").setDescription("Razón").setRequired(false)),
  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("👢 Expulsar usuario")
    .addUserOption(o => o.setName("usuario").setDescription("Usuario a expulsar").setRequired(true))
    .addStringOption(o => o.setName("razon").setDescription("Razón").setRequired(false)),
  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("🧹 Borrar mensajes")
    .addIntegerOption(o => o.setName("cantidad").setDescription("Cantidad (1-100)").setRequired(true)),

  // XP
  new SlashCommandBuilder().setName("nivel").setDescription("⭐ Ver tu nivel y XP"),
].map(c => c.toJSON());

// ========================== REGISTRO DE COMANDOS ==========================
const rest = new REST({ version: "10" }).setToken(TOKEN);
async function registerCommands() {
  try {
    console.log("⚙️ Registrando slash commands…");
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: slashDefs });
      console.log("✅ Comandos registrados en GUILD (aparición inmediata).");
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: slashDefs });
      console.log("✅ Comandos registrados GLOBAL (pueden tardar en aparecer).");
    }
  } catch (e) {
    console.error("❌ Error registrando comandos:", e);
  }
}

// ========================== READY ==========================
client.once("ready", () => {
  console.log(`🤖 Conectado como ${client.user.tag}`);
});

// ========================== XP POR MENSAJE ==========================
client.on("messageCreate", (msg) => {
  if (!msg.guild || msg.author.bot) return;
  tryAddXP(msg.author.id, msg.channel);
});

// ========================== INTERACCIONES ==========================
client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;

  try {
    const name = i.commandName;

    // -------- Utilidad --------
    if (name === "ping") {
      return i.reply(`🏓 Pong! Latencia WS: **${client.ws.ping}ms**`);
    }

    if (name === "help") {
      const help = new EmbedBuilder()
        .setTitle("📖 Comandos disponibles")
        .setColor("Gold")
        .setDescription([
          "### Utilidad",
          "`/ping`, `/help`, `/vicecasino`, `/anuncio`, `/sugerencia`",
          "",
          "### Economía & Juegos",
          "`/balance`, `/daily`, `/trabajar`, `/apostar`, `/transferir`",
          "`/coinflip`, `/slots`",
          "",
          "### Tickets",
          "`/ticket`, `/close`",
          "",
          "### Moderación",
          "`/ban`, `/kick`, `/clear`",
          "",
          "### XP",
          "`/nivel`",
        ].join("\n"));
      return i.reply({ embeds: [help], ephemeral: true });
    }

    if (name === "vicecasino") {
      return i.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("🎰 Vice Casino – Información")
            .setColor("Purple")
            .setDescription(
`🇪🇸 
El juego trata de conseguir el máximo de dinero posible para poder acceder a las máximas funcionalidades del juego: 
- Discotecas
- Hipercoches
- Islas privadas (gratuito por la primera semana y después con gamepass)
- Casas luxury
- Acceso al Casino para jugar a más cosas con shows impresionantes

📅 Lanzamiento estimado: **final del verano de 2025**

🇺🇸 
The game is about earning as much money as possible to unlock the maximum features of the game:
- Nightclubs
- Hypercars
- Private islands (free for the first week, then with a gamepass)
- Luxury houses
- Access to the Casino to play more games and enjoy impressive shows

📅 Planned release: **end of summer 2025**

||@everyone||`)
        ],
      });
    }

    if (name === "anuncio") {
      if (!i.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
        return i.reply({ content: "⛔ Necesitas permiso **Manage Guild**.", ephemeral: true });
      }
      const msg = i.options.getString("mensaje", true);
      const everyone = i.options.getBoolean("everyone") || false;
      await i.reply({ content: "✅ Anuncio enviado.", ephemeral: true });
      return i.channel.send(`${everyone ? "@everyone " : ""}📢 ${msg}`);
    }

    if (name === "sugerencia") {
      const texto = i.options.getString("texto", true);
      const emb = new EmbedBuilder()
        .setTitle("💡 Nueva sugerencia")
        .setDescription(texto)
        .setColor("Green")
        .setFooter({ text: `Autor: ${i.user.tag}` })
        .setTimestamp();
      await i.reply({ content: "✅ ¡Gracias por tu sugerencia!", ephemeral: true });
      return i.channel.send({ embeds: [emb] });
    }

    // -------- Economía --------
    if (name === "balance") {
      return i.reply(`💰 ${i.user.username}, tu saldo es **${getBalance(i.user.id)}**.`);
    }

    if (name === "daily") {
      const u = ensureUserEconomy(i.user.id);
      const cd = canUseCooldown(u.lastDaily, 24 * 60 * 60 * 1000);
      if (!cd.ok) {
        return i.reply({ content: `⏳ Vuelve en **${fmtMs(cd.left)}** para tu próximo daily.`, ephemeral: true });
      }
      const amount = Math.floor(Math.random() * 201) + 100; // 100-300
      u.lastDaily = Date.now();
      addMoney(i.user.id, amount);
      return i.reply(`🎁 Has cobrado tu daily: **+${amount}**. Nuevo saldo: **${getBalance(i.user.id)}**`);
    }

    if (name === "trabajar") {
      const u = ensureUserEconomy(i.user.id);
      const cd = canUseCooldown(u.lastWork, 30 * 60 * 1000); // 30 min
      if (!cd.ok) {
        return i.reply({ content: `⏳ Podrás trabajar en **${fmtMs(cd.left)}**.`, ephemeral: true });
      }
      const amount = Math.floor(Math.random() * 251) + 50; // 50-300
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
        return i.reply(`🎉 ¡Ganaste! **+${cantidad}** → Saldo: **${getBalance(i.user.id)}**`);
      } else {
        addMoney(i.user.id, -cantidad);
        return i.reply(`💸 Perdiste **-${cantidad}** → Saldo: **${getBalance(i.user.id)}**`);
      }
    }

    if (name === "transferir") {
      const target = i.options.getUser("usuario", true);
      const cantidad = i.options.getInteger("cantidad", true);
      if (target.bot || target.id === i.user.id) {
        return i.reply({ content: "❌ No puedes transferirte a ti o a bots.", ephemeral: true });
      }
      if (cantidad <= 0) return i.reply({ content: "❌ Cantidad inválida.", ephemeral: true });
      if (getBalance(i.user.id) < cantidad) return i.reply({ content: "❌ No tienes suficiente dinero.", ephemeral: true });
      addMoney(i.user.id, -cantidad);
      addMoney(target.id, cantidad);
      return i.reply(`✅ Transferiste **${cantidad}** a **${target.username}**. Tu saldo: **${getBalance(i.user.id)}**`);
    }

    // -------- Juegos (con economía) --------
    if (name === "coinflip") {
      const eleccion = i.options.getString("eleccion", true).toLowerCase();
      const cantidad = i.options.getInteger("cantidad", true);
      if (!["cara", "cruz"].includes(eleccion)) {
        return i.reply({ content: "❌ Elige `cara` o `cruz`.", ephemeral: true });
      }
      if (cantidad <= 0) return i.reply({ content: "❌ Cantidad inválida.", ephemeral: true });
      if (getBalance(i.user.id) < cantidad) return i.reply({ content: "❌ No tienes suficiente dinero.", ephemeral: true });

      const resultado = Math.random() < 0.5 ? "cara" : "cruz";
      const win = (resultado === eleccion);
      if (win) {
        addMoney(i.user.id, cantidad);
        return i.reply(`🪙 Salió **${resultado}**. ¡Ganaste **+${cantidad}**! Saldo: **${getBalance(i.user.id)}**`);
      } else {
        addMoney(i.user.id, -cantidad);
        return i.reply(`🪙 Salió **${resultado}**. Perdiste **-${cantidad}**. Saldo: **${getBalance(i.user.id)}**`);
      }
    }

    if (name === "slots") {
      const cantidad = i.options.getInteger("cantidad", true);
      if (cantidad <= 0) return i.reply({ content: "❌ Cantidad inválida.", ephemeral: true });
      if (getBalance(i.user.id) < cantidad) return i.reply({ content: "❌ No tienes suficiente dinero.", ephemeral: true });

      const symbols = ["🍒", "🍋", "🔔", "⭐", "7️⃣"];
      const r = () => symbols[Math.floor(Math.random() * symbols.length)];
      const a = r(), b = r(), c = r();

      let mult = 0;
      if (a === b && b === c) {
        mult = a === "7️⃣" ? 5 : 3; // triple 7 paga más
      } else if (a === b || b === c || a === c) {
        mult = 1.5; // par
      }

      if (mult > 0) {
        const win = Math.floor(cantidad * mult);
        addMoney(i.user.id, win);
        return i.reply(`🎰 | ${a} | ${b} | ${c} | → ¡Ganaste **+${win}**! Saldo: **${getBalance(i.user.id)}**`);
      } else {
        addMoney(i.user.id, -cantidad);
        return i.reply(`🎰 | ${a} | ${b} | ${c} | → Perdiste **-${cantidad}**. Saldo: **${getBalance(i.user.id)}**`);
      }
    }

    // -------- Tickets --------
    if (name === "ticket") {
      const overwrites = [
        { id: i.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: i.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
      ];
      if (STAFF_ROLE_ID) {
        overwrites.push({ id: STAFF_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
      }

      const channel = await i.guild.channels.create({
        name: `ticket-${i.user.username}`.slice(0, 30),
        type: ChannelType.GuildText,
        permissionOverwrites: overwrites,
        reason: `Ticket de ${i.user.tag}`,
      });

      await channel.send(`🎟️ Ticket creado por ${i.user}. Un miembro del staff te atenderá.`);
      return i.reply({ content: `✅ Ticket creado: ${channel}`, ephemeral: true });
    }

    if (name === "close") {
      if (!i.channel || !i.channel.name?.startsWith("ticket-")) {
        return i.reply({ content: "⚠️ Este canal no es un ticket.", ephemeral: true });
      }
      await i.reply({ content: "🗑️ Cerrando ticket…", ephemeral: true });
      return i.channel.delete("Ticket cerrado");
    }

    // -------- Moderación --------
    if (name === "ban") {
      if (!i.memberPermissions.has(PermissionFlagsBits.BanMembers)) {
        return i.reply({ content: "⛔ Necesitas permiso **Ban Members**.", ephemeral: true });
      }
      const target = i.options.getUser("usuario", true);
      const razon = i.options.getString("razon") || "Sin razón";
      const member = await i.guild.members.fetch(target.id).catch(() => null);
      if (!member) return i.reply({ content: "⚠️ Usuario no encontrado en el servidor.", ephemeral: true });
      await member.ban({ reason: razon });
      return i.reply(`🚫 **${target.tag}** baneado. Razón: ${razon}`);
    }

    if (name === "kick") {
      if (!i.memberPermissions.has(PermissionFlagsBits.KickMembers)) {
        return i.reply({ content: "⛔ Necesitas permiso **Kick Members**.", ephemeral: true });
      }
      const target = i.options.getUser("usuario", true);
      const razon = i.options.getString("razon") || "Sin razón";
      const member = await i.guild.members.fetch(target.id).catch(() => null);
      if (!member) return i.reply({ content: "⚠️ Usuario no encontrado en el servidor.", ephemeral: true });
      await member.kick(razon);
      return i.reply(`👢 **${target.tag}** expulsado. Razón: ${razon}`);
    }

    if (name === "clear") {
      if (!i.memberPermissions.has(PermissionFlagsBits.ManageMessages)) {
        return i.reply({ content: "⛔ Necesitas permiso **Manage Messages**.", ephemeral: true });
      }
      const cantidad = i.options.getInteger("cantidad", true);
      if (cantidad < 1 || cantidad > 100) {
        return i.reply({ content: "❌ La cantidad debe estar entre 1 y 100.", ephemeral: true });
      }
      const deleted = await i.channel.bulkDelete(cantidad, true).catch(() => null);
      if (!deleted) return i.reply({ content: "⚠️ No se pudieron borrar mensajes (pueden ser muy antiguos).", ephemeral: true });
      return i.reply(`🧹 Borrados **${deleted.size}** mensajes.`);
    }

    // -------- XP --------
    if (name === "nivel") {
      const u = ensureUserLevel(i.user.id);
      return i.reply(`⭐ ${i.user.username}: Nivel **${u.level}** | XP **${u.xp}/${neededXP(u.level)}**`);
    }
  } catch (err) {
    console.error("❌ Error en comando:", err);
    if (i.deferred || i.replied) {
      return i.followUp({ content: "⚠️ Ocurrió un error procesando el comando.", ephemeral: true });
    }
    return i.reply({ content: "⚠️ Ocurrió un error procesando el comando.", ephemeral: true });
  }
});

// ========================== START ==========================
(async () => {
  await registerCommands();
  await client.login(TOKEN);
})();
