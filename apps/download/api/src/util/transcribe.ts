import { spawn } from 'child_process';
import path from 'path';

import { clearTranscribeState, setTranscribeState } from '../cache';
import { registerProcess } from './processManager';
import { recPath } from './recording';

export const transcribeScriptPath = path.join(__dirname, '..', '..', '..', '..', '..', 'scripts', 'transcribe.py');
export const modelPath = path.join(__dirname, '..', '..', '..', '..', '..', 'whisper-models');

export const allowedTranscribeFormats = ['srt', 'vtt', 'txt'] as const;
export type TranscribeFormat = (typeof allowedTranscribeFormats)[number];

export const transcribeFormatExt: Record<TranscribeFormat, string> = {
  srt: 'srt',
  vtt: 'vtt',
  txt: 'txt'
};

export async function transcribe(id: string, format: TranscribeFormat = 'srt', lang?: string) {
  const deleteState = async () => {
    await clearTranscribeState(id).catch(() => {});
  };

  await setTranscribeState(id, { message: 'Starting transcription...' });

  const args = [
    transcribeScriptPath,
    id,
    '--format',
    format,
    '--rec-dir',
    recPath,
    '--model-dir',
    modelPath,
    ...(lang ? ['--lang', lang] : [])
  ];

  const child = spawn('python3', args, { detached: true });
  console.log(`Transcribing ${id} (format: ${format}${lang ? `, lang: ${lang}` : ''}) with PID ${child.pid}`);
  registerProcess(child, deleteState);

  child.stderr.on('data', (buf: Buffer) => {
    const msg = buf.toString().trim();
    if (msg) {
      setTranscribeState(id, { message: msg.slice(0, 200) }).catch(() => {});
    }
  });

  return child.stdout;
}
