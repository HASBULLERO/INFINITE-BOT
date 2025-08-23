const { REST, Routes } = require('discord.js');
const { TOKEN, CLIENT_ID } = process.env;
const commands = require('./commands.json'); // o directamente un array de comandos

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
    try {
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('✅ Comandos globales registrados.');
    } catch (e) {
        console.error(e);
    }
})();
