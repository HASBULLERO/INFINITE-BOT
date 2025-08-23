// index.js
const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    PermissionsBitField,
    ChannelType
} = require("discord.js");
const fs = require("fs");
require("dotenv").config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// ------------------- SISTEMA DE XP -------------------
let levels = {};
const LEVEL_FILE = "levels.json";

// Cargar datos de XP si existen
if (fs.existsSync(LEVEL_FILE)) {
    levels = JSON.parse(fs.readFileSync(LEVEL_FILE));
}

// Función para calcular XP necesario por nivel
function getNeededXP(level) {
    return 100 * level; // ejemplo: nivel 2 = 200 XP, nivel 3 = 300 XP
}

// Guardar en archivo
function saveLevels() {
    fs.writeFileSync(LEVEL_FILE, JSON.stringify(levels, null, 2));
}

// ------------------- COMANDOS -------------------
const commands = [
    // Comandos existentes...
    new SlashCommandBuilder().setName("ping").setDescription("🏓 Pong!"),
    new SlashCommandBuilder().setName("help").setDescription("📖 Muestra todos los comandos"),
    new SlashCommandBuilder().setName("nivel").setDescription("⭐ Muestra tu nivel y XP"),

    // Vice Casino
    new SlashCommandBuilder().setName("whatsaboutvicecasino").setDescription("🎰 Información sobre Vice Casino"),
].map(c => c.toJSON());

// Registrar slash commands
const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);
(async () => {
    try {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log("✅ Comandos listos");
    } catch (e) { console.error(e); }
})();

// ------------------- EVENTOS -------------------
client.once("ready", () => console.log(`✅ Bot online como ${client.user.tag}`));

// Sistema XP
client.on("messageCreate", msg => {
    if (msg.author.bot) return;

    const userId = msg.author.id;
    if (!levels[userId]) {
        levels[userId] = { xp: 0, level: 1 };
    }

    const gain = Math.floor(Math.random() * 11) + 5; // 5 a 15 XP
    levels[userId].xp += gain;

    const needed = getNeededXP(levels[userId].level);

    if (levels[userId].xp >= needed) {
        levels[userId].level++;
        levels[userId].xp = 0;
        msg.channel.send(`⭐ Felicidades ${msg.author}, ¡subiste a **nivel ${levels[userId].level}**!`);
    }

    saveLevels();
});

// ------------------- INTERACCIONES -------------------
client.on("interactionCreate", async (i) => {
    if (!i.isChatInputCommand()) return;

    const { commandName } = i;

    if (commandName === "ping") return i.reply("🏓 Pong!");
    if (commandName === "help") {
        return i.reply(`
📖 **Comandos principales:**
- /ping → Pong!
- /help → Muestra comandos
- /nivel → Ver tu nivel y XP
- /whatsaboutvicecasino → Info Vice Casino
⭐ Sistema XP activo: escribe en el chat para ganar XP y subir de nivel.
        `);
    }
    if (commandName === "nivel") {
        const userId = i.user.id;
        if (!levels[userId]) {
            levels[userId] = { xp: 0, level: 1 };
        }
        return i.reply(`⭐ ${i.user.username}, eres **nivel ${levels[userId].level}** con **${levels[userId].xp} XP**.`);
    }

    if (commandName === "whatsaboutvicecasino") {
        return i.reply(`
🇪🇸  
El juego trata de conseguir el máximo de dinero posible para poder acceder a las máximas funcionalidades del juego:  

- Discotecas  
- Hipercoches  
- Islas privadas (gratuito por la primera semana y después con gamepass)  
- Casas luxury  
- Y acceder al Casino para jugar a más cosas con shows impresionantes  

📅 La fecha de lanzamiento prevista está estimada para el **final del verano de 2025**  

---
🇺🇸  
The game is about earning as much money as possible to unlock the maximum features of the game:  

- Nightclubs  
- Hypercars  
- Private islands (free for the first week, then available with a gamepass)  
- Luxury houses  
- Access to the Casino to play more games and enjoy impressive shows  

📅 The planned release date is estimated for the **end of summer 2025**  

||@everyone||
        `);
    }
});

// ------------------- LOGIN -------------------
client.login(process.env.TOKEN);
