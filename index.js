const { Client, GatewayIntentBits, Partials, Collection, EmbedBuilder, PermissionsBitField } = require("discord.js");
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require("@discordjs/voice");
const ytdl = require("ytdl-core");
const fs = require("fs");
require("dotenv").config();

// ========================== CLIENTE ==========================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.commands = new Collection();

// ========================== SISTEMA XP ==========================
const xp = {};
const levelUp = (userId, guildId, channel) => {
    if (!xp[guildId][userId]) xp[guildId][userId] = { xp: 0, level: 1 };
    xp[guildId][userId].xp += Math.floor(Math.random() * 20) + 1;

    const curLevel = xp[guildId][userId].level;
    const neededXP = curLevel * 100;

    if (xp[guildId][userId].xp >= neededXP) {
        xp[guildId][userId].level++;
        xp[guildId][userId].xp = 0;
        channel.send(`🎉 <@${userId}> subió al nivel **${xp[guildId][userId].level}**!`);
    }
};

// ========================== COMANDOS ==========================
const commands = [
    {
        name: "ping",
        description: "Ver la latencia del bot",
        run: async (interaction) => {
            await interaction.reply(`🏓 Pong! Latencia: **${client.ws.ping}ms**`);
        }
    },
    {
        name: "vicecasino",
        description: "Información sobre Vice Casino",
        run: async (interaction) => {
            const embed = new EmbedBuilder()
                .setTitle("🎰 Vice Casino - Info")
                .setDescription(`
🇪🇸  
El juego trata de conseguir el máximo de dinero posible para poder acceder a las máximas funcionalidades del juego: 

- Discotecas  
- Hipercoches  
- Islas privadas (gratuito por la primera semana y después con gamepass)  
- Casas luxury  
- Y acceder al Casino para jugar a más cosas con shows impresionantes  

La fecha de lanzamiento prevista está estimada para el final del verano de 2025  

🇺🇸  
The game is about earning as much money as possible to unlock the maximum features of the game:  

- Nightclubs  
- Hypercars  
- Private islands (free for the first week, then available with a gamepass)  
- Luxury houses  
- Access to the Casino to play more games and enjoy impressive shows  

The planned release date is estimated for the end of summer 2025.  

||@everyone||
                `)
                .setColor("Gold");
            await interaction.reply({ embeds: [embed] });
        }
    },
    {
        name: "ticket",
        description: "Abrir un ticket de soporte",
        run: async (interaction) => {
            const channel = await interaction.guild.channels.create({
                name: `ticket-${interaction.user.username}`,
                type: 0, // text channel
                permissionOverwrites: [
                    { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                    { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel] },
                    { id: interaction.guild.roles.everyone.id, deny: [PermissionsBitField.Flags.SendMessages] }
                ]
            });
            await channel.send(`🎟️ Hola <@${interaction.user.id}>, el staff te atenderá pronto.`);
            await interaction.reply({ content: `✅ Ticket creado: ${channel}`, ephemeral: true });
        }
    },
    {
        name: "play",
        description: "Reproducir música desde YouTube",
        options: [{ name: "url", type: 3, description: "URL del video", required: true }],
        run: async (interaction) => {
            const url = interaction.options.getString("url");
            if (!ytdl.validateURL(url)) return interaction.reply("❌ URL inválida.");

            const channel = interaction.member.voice.channel;
            if (!channel) return interaction.reply("❌ Debes estar en un canal de voz.");

            const connection = joinVoiceChannel({
                channelId: channel.id,
                guildId: channel.guild.id,
                adapterCreator: channel.guild.voiceAdapterCreator,
            });

            const stream = ytdl(url, { filter: "audioonly" });
            const resource = createAudioResource(stream);
            const player = createAudioPlayer();

            connection.subscribe(player);
            player.play(resource);

            player.on(AudioPlayerStatus.Playing, () => {
                interaction.reply(`🎶 Reproduciendo: ${url}`);
            });
        }
    },
    {
        name: "kick",
        description: "Expulsar a un usuario",
        options: [{ name: "user", type: 6, description: "Usuario", required: true }],
        run: async (interaction) => {
            const member = interaction.options.getUser("user");
            const target = await interaction.guild.members.fetch(member.id);
            await target.kick();
            interaction.reply(`👢 Usuario ${member.username} expulsado.`);
        }
    }
];

// ========================== HANDLER ==========================
client.once("ready", async () => {
    console.log(`✅ Bot iniciado como ${client.user.tag}`);
    await client.application.commands.set(commands.map(cmd => ({
        name: cmd.name,
        description: cmd.description,
        options: cmd.options || []
    })));
});

// ========================== INTERACCIONES ==========================
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const command = commands.find(cmd => cmd.name === interaction.commandName);
    if (command) await command.run(interaction);
});

// ========================== XP MENSAJES ==========================
client.on("messageCreate", (message) => {
    if (message.author.bot || !message.guild) return;
    if (!xp[message.guild.id]) xp[message.guild.id] = {};
    levelUp(message.author.id, message.guild.id, message.channel);
});

// ========================== LOGIN ==========================
client.login(process.env.TOKEN);
