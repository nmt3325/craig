import axios, { type AxiosError } from 'axios';
import { spawn } from 'child_process';
import config from 'config';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { createLogger } from '../logger';
import { prisma } from '../prisma';
import { clearReadyState, setReadyState } from '../redis';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_BLOCKS_PER_REQUEST = 90;

const notionToken: string = config.has('notion.token') ? config.get<string>('notion.token') : '';

const recPath = config.has('recording.path')
  ? path.join(__dirname, '..', '..', config.get<string>('recording.path'))
  : path.join(__dirname, '..', '..', '..', '..', 'rec');

const scriptPath = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'transcribe.py');
const modelPath = path.join(__dirname, '..', '..', '..', '..', 'whisper-models');

const logger = createLogger('transcribe');

interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

interface SpeakerResult {
  username: string;
  segments: TranscriptSegment[];
}

interface DiarizedLine {
  time: number;
  username: string;
  text: string;
}

function notionHeaders(extra: Record<string, string> = {}) {
  return {
    Authorization: `Bearer ${notionToken}`,
    'Notion-Version': '2022-06-28',
    ...extra
  };
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function getDatabaseTitleProperty(databaseId: string): Promise<string> {
  const response = await axios.get(`${NOTION_API}/databases/${databaseId}`, {
    headers: notionHeaders()
  });
  const properties = response.data.properties as Record<string, { type: string }>;
  for (const [key, value] of Object.entries(properties)) {
    if (value.type === 'title') return key;
  }
  return 'Name';
}

function buildTranscriptText(speakers: SpeakerResult[]): string {
  const lines: DiarizedLine[] = [];
  for (const speaker of speakers) {
    for (const seg of speaker.segments) {
      if (seg.text.trim()) {
        lines.push({ time: seg.start, username: speaker.username, text: seg.text.trim() });
      }
    }
  }
  lines.sort((a, b) => a.time - b.time);
  return lines.map((l) => `[${formatTimestamp(l.time)}] ${l.username}: ${l.text}`).join('\n');
}

function transcriptToNotionBlocks(transcriptText: string) {
  return transcriptText
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => ({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: line.slice(0, 2000) } }]
      }
    }));
}

async function appendTranscriptToPage(pageId: string, transcriptText: string): Promise<void> {
  const divider = [{ object: 'block', type: 'divider', divider: {} }, { object: 'block', type: 'heading_3', heading_3: { rich_text: [{ type: 'text', text: { content: '📝 Transcript' } }] } }];
  const allBlocks = [...divider, ...transcriptToNotionBlocks(transcriptText)];
  for (let i = 0; i < allBlocks.length; i += NOTION_BLOCKS_PER_REQUEST) {
    await axios.patch(
      `${NOTION_API}/blocks/${pageId}/children`,
      { children: allBlocks.slice(i, i + NOTION_BLOCKS_PER_REQUEST) },
      { headers: notionHeaders({ 'Content-Type': 'application/json' }) }
    );
  }
}

async function createTranscriptNotionPage(databaseId: string, title: string, transcriptText: string): Promise<string> {
  const titlePropName = await getDatabaseTitleProperty(databaseId);
  const allBlocks = transcriptToNotionBlocks(transcriptText);
  const firstBatch = allBlocks.slice(0, NOTION_BLOCKS_PER_REQUEST);

  const pageResponse = await axios.post(
    `${NOTION_API}/pages`,
    {
      parent: { database_id: databaseId },
      properties: {
        [titlePropName]: { title: [{ text: { content: title } }] }
      },
      children: firstBatch
    },
    { headers: notionHeaders({ 'Content-Type': 'application/json' }) }
  );

  const pageId: string = pageResponse.data.id;

  for (let i = NOTION_BLOCKS_PER_REQUEST; i < allBlocks.length; i += NOTION_BLOCKS_PER_REQUEST) {
    await axios.patch(
      `${NOTION_API}/blocks/${pageId}/children`,
      { children: allBlocks.slice(i, i + NOTION_BLOCKS_PER_REQUEST) },
      { headers: notionHeaders({ 'Content-Type': 'application/json' }) }
    );
  }

  return pageId;
}

function runTrackTranscription(recordingId: string, trackIndex: number, lang?: string): Promise<TranscriptSegment[]> {
  return new Promise((resolve) => {
    const args = [
      scriptPath,
      recordingId,
      '--format',
      'json',
      '--track',
      String(trackIndex), // OGG stream serial number (= key in .ogg.users file)
      '--rec-dir',
      recPath,
      '--model-dir',
      modelPath,
      ...(lang ? ['--lang', lang] : [])
    ];

    const child = spawn('python3', args);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (buf: Buffer) => {
      stdout += buf.toString();
    });
    child.stderr.on('data', (buf: Buffer) => {
      const msg = buf.toString().trim();
      if (msg) logger.info(`[track ${trackIndex}] ${msg}`);
      stderr += msg;
    });

    child.on('close', (code: number | null) => {
      if (code !== 0) {
        logger.warn(`Track ${trackIndex} exited with code ${code}: ${stderr.slice(0, 300)}`);
        resolve([]);
        return;
      }
      try {
        const result = JSON.parse(stdout);
        resolve((result.segments as TranscriptSegment[]) || []);
      } catch {
        logger.warn(`Failed to parse transcription JSON for track ${trackIndex}: ${stdout.slice(0, 200)}`);
        resolve([]);
      }
    });

    child.on('error', (err: Error) => {
      logger.error(`Failed to spawn transcription for track ${trackIndex}`, err);
      resolve([]);
    });
  });
}

export async function transcribeUpload({
  recordingId,
  channelId,
  userId,
  lang,
  notionPageId
}: {
  recordingId: string;
  channelId: string;
  userId: string;
  lang?: string;
  notionPageId?: string;
}): Promise<{ error: null | string; notify: boolean; url?: string; transcript?: string }> {
  // Verify recording files exist
  const infoPath = path.join(recPath, `${recordingId}.ogg.info`);
  const dataPath = path.join(recPath, `${recordingId}.ogg.data`);
  try {
    await fs.access(infoPath);
    await fs.access(dataPath);
  } catch {
    return { error: 'recording_deleted', notify: false };
  }

  const info = JSON.parse(await fs.readFile(infoPath, 'utf8'));

  // Read the per-track user list written by the bot's OGG writer.
  // Keys are track indices (0-based strings), values are RecordingUser objects.
  const usersPath = path.join(recPath, `${recordingId}.ogg.users`);
  let usersRaw: Record<string, { username?: string; id?: string }> = {};
  try {
    const userText = await fs.readFile(usersPath, 'utf8');
    usersRaw = JSON.parse(`{${userText}}`);
  } catch {
    logger.warn(`Could not read users file for recording ${recordingId}`);
  }

  // Build ordered list of (trackIndex, username) pairs, skipping empty entries
  const tracks = Object.entries(usersRaw)
    .filter(([, u]) => u && (u.username || u.id))
    .map(([idx, u]) => ({
      trackIndex: parseInt(idx, 10),
      username: (u.username || u.id || `Speaker${idx}`).trim()
    }))
    .sort((a, b) => a.trackIndex - b.trackIndex);

  if (tracks.length === 0) {
    return { error: 'no_speakers_found', notify: false };
  }

  const startDate = new Date(info.startTime);
  const datePart = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;
  const timePart = `${String(startDate.getHours()).padStart(2, '0')}:${String(startDate.getMinutes()).padStart(2, '0')}:${String(startDate.getSeconds()).padStart(2, '0')}`;

  // Look up channel settings early to get transcribeLang
  const notionChannel = await prisma.notionChannel.findUnique({ where: { channelId } });
  const effectiveLang = lang || notionChannel?.transcribeLang || undefined;

  logger.info(`Transcribing recording ${recordingId}: ${tracks.length} speaker(s), lang=${effectiveLang || 'auto'}`);
  await setReadyState(recordingId, { message: `Transcribing 0/${tracks.length} speakers...` });

  try {
    const speakers: SpeakerResult[] = [];

    for (let i = 0; i < tracks.length; i++) {
      const { trackIndex, username } = tracks[i];
      logger.info(`Transcribing track ${trackIndex} (${username}) [${i + 1}/${tracks.length}]`);
      await setReadyState(recordingId, {
        message: `Transcribing ${username} (${i + 1}/${tracks.length})...`,
        progress: Math.round((i / tracks.length) * 100)
      });

      const segments = await runTrackTranscription(recordingId, trackIndex, effectiveLang);
      if (segments.length > 0) {
        speakers.push({ username, segments });
      }
    }

    if (speakers.length === 0) {
      await clearReadyState(recordingId);
      return { error: 'no_speech_detected', notify: true };
    }

    const transcriptText = buildTranscriptText(speakers);

    // Upload to Notion if the channel is configured
    let notionUrl: string | undefined;
    if (notionToken && notionChannel) {
      // Wait for notionUpload's API calls to clear the rate limit window
      await new Promise((resolve) => setTimeout(resolve, 5000));

      await setReadyState(recordingId, { message: 'Uploading transcript to Notion...' });

      let pageId: string;
      if (notionPageId) {
        // Append transcript to the audio page created by notionUpload
        logger.info(`Appending transcript for ${recordingId} to existing Notion page ${notionPageId}`);
        await appendTranscriptToPage(notionPageId, transcriptText);
        pageId = notionPageId;
      } else {
        // Fallback: create a new standalone transcript page
        logger.info(`Uploading transcript for ${recordingId} to Notion database ${notionChannel.databaseId}`);
        const pageTitle = `[Transcript] ${info.channel} - ${datePart} ${timePart}`;
        pageId = await createTranscriptNotionPage(notionChannel.databaseId, pageTitle, transcriptText);
      }
      notionUrl = `https://notion.so/${pageId.replace(/-/g, '')}`;
      logger.info(`Transcript for ${recordingId} uploaded to Notion page ${pageId}`);
    }

    await clearReadyState(recordingId);
    return { error: null, notify: true, url: notionUrl, transcript: transcriptText };
  } catch (e) {
    await clearReadyState(recordingId);
    logger.error(`Error during transcription of ${recordingId}`, e);
    if ((e as AxiosError).isAxiosError) {
      const res = (e as AxiosError).response;
      if (res) logger.error(`Notion API error (${res.status})`, res.data);
    }
    return {
      error: ((e as Error).message || 'unknown_error').slice(0, 200),
      notify: true
    };
  }
}
