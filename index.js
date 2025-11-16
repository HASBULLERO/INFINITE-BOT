// Version 1.0 (error en el login y conectar)
require("dotenv").config();
const express = require("express");
const { Client, GatewayIntentBits } = require("discord.js");

const TOKEN = process.env.TOKEN;
const PORT = process.env.PORT || 10000;

console.log("=== INICIO ===");
console.log("TOKEN existe:", !!TOKEN);
console.log("TOKEN length:", TOKEN ? TOKEN.length : 0);

const app = express();
app.get("/", (req, res) => res.send("OK"));
app.listen(PORT, () => console.log("Server puerto " + PORT));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once("ready", () => {
  console.log("===== BOT CONECTADO =====");
  console.log("Usuario:", client.user.tag);
  console.log("=========================");
});

client.on("error", console.error);

client.login(TOKEN)
  .then(() => console.log("Login iniciado"))
  .catch(err => {
    console.error("ERROR EN LOGIN:");
    console.error(err);
    process.exit(1);
  });