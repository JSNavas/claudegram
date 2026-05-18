import { webhookCallback } from 'grammy';
import express from 'express';
import { createBot } from './bot/bot.js';
import { config } from './config.js';
import { preventSleep, allowSleep } from './utils/caffeinate.js';
import { stopCleanup } from './telegram/deduplication.js';

async function main() {
  console.log('🤖 Starting Claudegram in Webhook Mode...');
  console.log(`📋 Allowed users: ${config.ALLOWED_USER_IDS.join(', ')}`);
  console.log(`📝 Mode: ${config.STREAMING_MODE}`);

  // Prevent system sleep on macOS
  preventSleep();

  const bot = await createBot();

  // Initialize bot (fetches bot info from Telegram)
  await bot.init();
  console.log(`✅ Bot initialized as @${bot.botInfo.username}`);

  // Levantamos Express para escuchar las peticiones de Ngrok
  const app = express();
  app.use(express.json());

  const PORT = process.env.PORT || 3000;

  // Endpoint donde Telegram/Ngrok enviarán los payloads
  app.post(
    '/webhook',
    webhookCallback(bot, 'express', {
      onTimeout: 'return', // Evita que lance la excepción de timeout si tarda
      timeoutMilliseconds: 30000, // Amplía el margen interno a 30 segundos
    })
  );

  const server = app.listen(PORT, () => {
    console.log(`🌐 Webhook server listening on port ${PORT}`);
    console.log('📱 Send /start in Telegram to begin');
  });

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n👋 Shutting down webhook server...');
    allowSleep();
    stopCleanup();
    
    server.close(() => {
      console.log('🛑 Server closed.');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => { shutdown(); });
  process.on('SIGTERM', () => { shutdown(); });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  allowSleep();
  process.exit(1);
});