import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config.js';
import { downloadFileSecure, getTelegramFileUrl } from '../utils/download.js';

export interface TranscribeOptions {
  timeoutMs?: number;
  allowEmpty?: boolean;
}

async function transcribeFormData(
  endpoint: string,
  model: string,
  apiKey: string,
  filePath: string,
  timeoutMs: number,
): Promise<string> {
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer]), fileName);
  formData.append('model', model);
  formData.append('language', config.VOICE_LANGUAGE);
  formData.append('response_format', 'json');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`API error ${response.status}: ${body.slice(0, 300)}`);
  }

  const result = (await response.json()) as { text?: string };
  return (result.text || '').trim();
}

async function transcribeOpenRouter(
  apiKey: string,
  filePath: string,
  timeoutMs: number,
): Promise<string> {
  const fileBuffer = fs.readFileSync(filePath);
  const audioBase64 = fileBuffer.toString('base64');
  const ext = path.extname(filePath).slice(1) || 'ogg';

  const response = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'openai/whisper-large-v3',
      input_audio: { data: audioBase64, format: ext },
      temperature: 0.0,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`OpenRouter API error ${response.status}: ${body.slice(0, 300)}`);
  }

  const result = (await response.json()) as { text?: string };
  return (result.text || '').trim();
}

export async function transcribeFile(filePath: string, options?: TranscribeOptions): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? config.VOICE_TIMEOUT_MS;
  let transcript: string;

  if (config.TTS_PROVIDER === 'openrouter') {
    if (!config.OPENROUTER_API_KEY) {
      throw new Error('OPENROUTER_API_KEY not configured. Set it in .env to enable voice transcription.');
    }
    transcript = await transcribeOpenRouter(config.OPENROUTER_API_KEY, filePath, timeoutMs);
  } else if (config.TTS_PROVIDER === 'groq') {
    if (!config.GROQ_API_KEY) {
      throw new Error('GROQ_API_KEY not configured. Set it in .env to enable voice transcription.');
    }
    transcript = await transcribeFormData(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      'whisper-large-v3-turbo',
      config.GROQ_API_KEY,
      filePath,
      timeoutMs,
    );
  } else {
    if (!config.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY not configured. Set it in .env to enable voice transcription.');
    }
    transcript = await transcribeFormData(
      'https://api.openai.com/v1/audio/transcriptions',
      'whisper-1',
      config.OPENAI_API_KEY,
      filePath,
      timeoutMs,
    );
  }

  if (!transcript && !options?.allowEmpty) {
    throw new Error('Empty transcription result');
  }

  return transcript;
}

export function downloadTelegramAudio(botToken: string, filePath: string, destPath: string): Promise<void> {
  const fileUrl = getTelegramFileUrl(botToken, filePath);
  return downloadFileSecure(fileUrl, destPath);
}
