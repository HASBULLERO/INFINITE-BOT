if (name === "coinflip") {
  const eleccion = i.options.getString("eleccion");
  const cantidad = i.options.getInteger("cantidad");
  if (cantidad <= 0) return i.reply({ content: "❌ Cantidad inválida.", ephemeral: true });
  if (getBalance(i.user.id) < cantidad) return i.reply({ content: "❌ No tienes suficiente.", ephemeral: true });
  const resultado = Math.random() < 0.5 ? "cara" : "cruz";
  const win = resultado === eleccion;
  if (win) addMoney(i.user.id, cantidad);
  else addMoney(i.user.id, -cantidad);
  return i.reply(`🪙 **${resultado}**. ${win ? "Ganaste" : "Perdiste"} **${cantidad}**. Saldo: **${getBalance(i.user.id)}**`);
}