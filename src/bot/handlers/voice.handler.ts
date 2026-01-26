import { Context } from 'grammy';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { config } from '../../config.js';
import { sendToAgent } from '../../claude/agent.js';
import { sessionManager } from '../../claude/session-manager.js';
import { messageSender } from '../../telegram/message-sender.js';
import { isDuplicate, markProcessed } from '../../telegram/deduplication.js';
import { isStaleMessage } from '../middleware/stale-filter.js';
import {
  queueRequest,
  isProcessing,
  getQueuePosition,
  setAbortController,
} from '../../claude/request-queue.js';
import { escapeMarkdownV2 } from '../../telegram/markdown.js';
import { getStreamingMode } from './command.handler.js';
import { maybeSendVoiceReply } from '../../tts/voice-reply.js';

function esc(text: string): string {
  return escapeMarkdownV2(text);
}

/**
 * Extract the transcript text from groq_transcribe.py stdout.
 * The script prints "Full text:\n<text>" as the last output.
 */
function parseTranscript(stdout: string): string {
  const marker = 'Full text:\n';
  const idx = stdout.lastIndexOf(marker);
  if (idx !== -1) {
    return stdout.slice(idx + marker.length).trim();
  }
  // Fallback: return the last non-empty line
  const lines = stdout.trim().split('\n').filter((l) => l.trim());
  return lines[lines.length - 1] || '';
}

/**
 * Transcribe an audio file using groq_transcribe.py.
 * Returns the transcript text.
 */
function transcribeFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      config.GROQ_TRANSCRIBE_PATH,
      filePath,
      '--task', 'transcribe',
      '--language', config.VOICE_LANGUAGE,
    ];

    const env = { ...process.env };
    if (config.GROQ_API_KEY) {
      env.GROQ_API_KEY = config.GROQ_API_KEY;
    }

    execFile(
      'python3',
      args,
      {
        timeout: config.VOICE_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        cwd: path.dirname(config.GROQ_TRANSCRIBE_PATH),
        env,
      },
      (error, stdout, stderr) => {
        if (error) {
          const stderrText = (stderr || '').trim();
          if (stderrText.includes('GROQ_API_KEY')) {
            reject(new Error('GROQ_API_KEY not configured. Set it in .env to enable voice transcription.'));
          } else if (stderrText.includes('ModuleNotFoundError')) {
            const modMatch = stderrText.match(/No module named '(\w+)'/);
            reject(new Error(`Missing Python dependency: ${modMatch ? modMatch[1] : 'unknown'}`));
          } else if ((error as { killed?: boolean }).killed) {
            reject(new Error('Transcription timed out.'));
          } else {
            reject(new Error(stderrText || error.message));
          }
          return;
        }

        const transcript = parseTranscript(stdout || '');
        if (!transcript) {
          reject(new Error('Empty transcription result'));
          return;
        }
        resolve(transcript);
      }
    );
  });
}

export async function handleVoice(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id;
  const messageDate = ctx.message?.date;
  const voice = ctx.message?.voice;

  if (!chatId || !messageId || !messageDate || !voice) return;

  // Stale/duplicate filters
  if (isStaleMessage(messageDate)) {
    console.log(`[Voice] Ignoring stale voice message ${messageId}`);
    return;
  }
  if (isDuplicate(messageId)) {
    console.log(`[Voice] Ignoring duplicate voice message ${messageId}`);
    return;
  }
  markProcessed(messageId);

  // Check session
  const session = sessionManager.getSession(chatId);
  if (!session) {
    await ctx.reply(
      '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project` to open a project first\\.',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // Check file size
  const fileSizeBytes = voice.file_size || 0;
  const fileSizeMB = fileSizeBytes / (1024 * 1024);
  if (fileSizeMB > config.VOICE_MAX_FILE_SIZE_MB) {
    await ctx.reply(
      `❌ Voice note too large \\(${esc(fileSizeMB.toFixed(1))}MB\\)\\.\n\nPlease send shorter notes \\(max ${config.VOICE_MAX_FILE_SIZE_MB}MB\\)\\.`,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // Acknowledge receipt
  const ackMsg = await ctx.reply('🎤 Transcribing...', { parse_mode: undefined });

  let tempFilePath: string | null = null;

  try {
    // Download voice file from Telegram (with retry for transient network errors)
    const file = await ctx.api.getFile(voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    // Download using curl (more reliable than Node fetch on this network)
    const ext = voice.mime_type?.includes('ogg') ? '.ogg' : '.oga';
    tempFilePath = path.join(os.tmpdir(), `claudegram_voice_${messageId}${ext}`);

    await new Promise<void>((resolve, reject) => {
      execFile(
        'curl',
        ['-sS', '-f', '--connect-timeout', '10', '--max-time', '30',
         '--retry', '2', '--retry-delay', '2',
         '-o', tempFilePath!,
         fileUrl],
        { timeout: 60_000 },
        (error, _stdout, stderr) => {
          if (error) {
            const msg = (stderr || '').trim() || error.message;
            console.error(`[Voice] curl download failed:`, msg);
            reject(new Error(`Failed to download voice file: ${msg}`));
          } else {
            resolve();
          }
        }
      );
    });

    const audioBuffer = fs.readFileSync(tempFilePath);
    if (!audioBuffer.length) {
      throw new Error('Downloaded empty voice file.');
    }

    console.log(`[Voice] Downloaded ${fileSizeMB.toFixed(1)}MB to ${tempFilePath}`);

    // Transcribe using groq_transcribe.py
    const transcript = await transcribeFile(tempFilePath);

    console.log(`[Voice] Transcript (${transcript.length} chars): ${transcript.substring(0, 100)}...`);

    // Show full transcript if configured, chunked for Telegram's message limit
    if (config.VOICE_SHOW_TRANSCRIPT) {
      const TELEGRAM_LIMIT = config.MAX_MESSAGE_LENGTH;
      const header = '🎤 Transcript:\n\n';
      const maxBodyPerMessage = TELEGRAM_LIMIT - header.length;

      // Split transcript into chunks that fit within Telegram's limit
      const chunks: string[] = [];
      if (transcript.length <= maxBodyPerMessage) {
        chunks.push(transcript);
      } else {
        let remaining = transcript;
        while (remaining.length > 0) {
          if (remaining.length <= maxBodyPerMessage) {
            chunks.push(remaining);
            break;
          }
          // Find a good split point: sentence boundary > newline > space
          let splitAt = maxBodyPerMessage;
          const searchRegion = remaining.substring(0, maxBodyPerMessage);

          // Try sentence boundary (. ! ?) followed by space or end
          const sentenceMatch = searchRegion.match(/.*[.!?](\s|$)/);
          if (sentenceMatch && sentenceMatch[0].length > maxBodyPerMessage / 2) {
            splitAt = sentenceMatch[0].length;
          } else {
            // Try newline
            const lastNewline = searchRegion.lastIndexOf('\n');
            if (lastNewline > maxBodyPerMessage / 2) {
              splitAt = lastNewline + 1;
            } else {
              // Try space
              const lastSpace = searchRegion.lastIndexOf(' ');
              if (lastSpace > maxBodyPerMessage / 2) {
                splitAt = lastSpace + 1;
              }
            }
          }

          chunks.push(remaining.substring(0, splitAt));
          remaining = remaining.substring(splitAt);
        }
      }

      const totalParts = chunks.length;

      // First chunk: edit the "Transcribing..." ack message
      const partLabel = totalParts > 1 ? ` [1/${totalParts}]` : '';
      const firstMsg = `${header}${chunks[0]}${partLabel}`;
      try {
        await ctx.api.editMessageText(
          chatId,
          ackMsg.message_id,
          firstMsg,
          { parse_mode: undefined }
        );
      } catch {
        // If edit fails, try sending as new message
        try {
          await ctx.api.deleteMessage(chatId, ackMsg.message_id);
        } catch { /* ignore */ }
        await ctx.reply(firstMsg, { parse_mode: undefined });
      }

      // Remaining chunks: send as new reply messages
      for (let i = 1; i < chunks.length; i++) {
        const label = ` [${i + 1}/${totalParts}]`;
        await ctx.reply(
          `${header}${chunks[i]}${label}`,
          { parse_mode: undefined }
        );
        // Small delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } else {
      // Remove ack message
      try {
        await ctx.api.deleteMessage(chatId, ackMsg.message_id);
      } catch { /* ignore */ }
    }

    // Check if already processing - show queue position
    if (isProcessing(chatId)) {
      const position = getQueuePosition(chatId) + 1;
      await ctx.reply(`⏳ Queued \\(position ${position}\\)`, { parse_mode: 'MarkdownV2' });
    }

    // Feed transcript into agent
    await queueRequest(chatId, transcript, async () => {
      if (getStreamingMode() === 'streaming') {
        await messageSender.startStreaming(ctx);

        const abortController = new AbortController();
        setAbortController(chatId, abortController);

        try {
          const response = await sendToAgent(chatId, transcript, {
            onProgress: (progressText) => {
              messageSender.updateStream(ctx, progressText);
            },
            abortController,
          });

          await messageSender.finishStreaming(ctx, response.text);
          await maybeSendVoiceReply(ctx, response.text);
        } catch (error) {
          await messageSender.cancelStreaming(ctx);
          throw error;
        }
      } else {
        await ctx.replyWithChatAction('typing');

        const abortController = new AbortController();
        setAbortController(chatId, abortController);

        const response = await sendToAgent(chatId, transcript, { abortController });
        await messageSender.sendMessage(ctx, response.text);
        await maybeSendVoiceReply(ctx, response.text);
      }
    });
  } catch (error) {
    if ((error as Error).message === 'Queue cleared') return;

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Voice] Error:', error);

    // Try to update ack message with error
    try {
      await ctx.api.editMessageText(
        chatId,
        ackMsg.message_id,
        `❌ ${errorMessage}`,
        { parse_mode: undefined }
      );
    } catch {
      await ctx.reply(`❌ Voice error: ${esc(errorMessage)}`, { parse_mode: 'MarkdownV2' });
    }
  } finally {
    // Clean up temp file
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
        console.log(`[Voice] Cleaned up ${tempFilePath}`);
      } catch { /* ignore */ }
    }
  }
}
