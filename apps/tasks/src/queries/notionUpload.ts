import axios, { type AxiosError } from 'axios';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import config from 'config';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createLogger } from '../logger';
import { prisma } from '../prisma';
import { clearReadyState, setReadyState } from '../redis';

const NOTION_API = 'https://api.notion.com/v1';
// Notion single-part upload limit
const PART_SIZE = 5 * 1024 * 1024;

const notionToken: string = config.has('notion.token') ? config.get<string>('notion.token') : '';

const recPath = config.has('recording.path')
  ? path.join(__dirname, '..', '..', config.get<string>('recording.path'))
  : path.join(__dirname, '..', '..', '..', '..', 'rec');
const cookPath = config.has('cookPath')
  ? path.join(__dirname, '..', '..', config.get<string>('cookPath'))
  : path.join(__dirname, '..', '..', '..', '..', 'cook');

const logger = createLogger('notion');

async function fileExists(file: string) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function killProcessTree(p: ChildProcessWithoutNullStreams) {
  if (p.killed || !p.pid) return true;
  try {
    return process.kill(p.pid);
  } catch (e) {
    if ((e as Error).message.startsWith('kill ESRCH')) return true;
    return false;
  }
}

function notionHeaders(extra: Record<string, string> = {}) {
  return {
    Authorization: `Bearer ${notionToken}`,
    'Notion-Version': '2022-06-28',
    ...extra
  };
}

// Build a multipart/form-data body manually for Node.js compatibility with axios 0.27
function buildMultipartBody(partNumber: number, fileName: string, mimeType: string, data: Buffer) {
  const boundary = `craignotion${Date.now()}${Math.random().toString(36).slice(2)}`;
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="part_number"\r\n\r\n${partNumber}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([header, data, footer]),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

async function createFileUpload(isMultiPart: boolean, partCount: number) {
  const body: Record<string, unknown> = { mode: isMultiPart ? 'multi_part' : 'single_part' };
  if (isMultiPart) body.number_of_parts = partCount;
  const response = await axios.post(`${NOTION_API}/file_uploads`, body, {
    headers: notionHeaders({ 'Content-Type': 'application/json' })
  });
  return response.data as { id: string };
}

async function sendFilePart(fileUploadId: string, partNumber: number, fileName: string, chunk: Buffer) {
  const { body, contentType } = buildMultipartBody(partNumber, fileName, 'audio/aac', chunk);
  await axios.post(`${NOTION_API}/file_uploads/${fileUploadId}/send`, body, {
    headers: notionHeaders({ 'Content-Type': contentType, 'Content-Length': String(body.length) }),
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });
}

async function completeMultiPartUpload(fileUploadId: string) {
  await axios.post(`${NOTION_API}/file_uploads/${fileUploadId}/complete`, {}, {
    headers: notionHeaders({ 'Content-Type': 'application/json' })
  });
}

async function getDatabaseProperties(databaseId: string): Promise<{ titleProp: string; dateProp: string | null }> {
  const response = await axios.get(`${NOTION_API}/databases/${databaseId}`, {
    headers: notionHeaders()
  });
  const properties = response.data.properties as Record<string, { type: string }>;
  let titleProp = 'Name';
  let dateProp: string | null = null;
  for (const [key, value] of Object.entries(properties)) {
    if (value.type === 'title') titleProp = key;
    if (value.type === 'date' && dateProp === null) dateProp = key;
  }
  return { titleProp, dateProp };
}

async function createNotionPage(
  databaseId: string,
  titlePropName: string,
  title: string,
  fileUploadId: string,
  fileName: string,
  datePropName: string | null,
  startDate: Date
) {
  const properties: Record<string, unknown> = {
    [titlePropName]: {
      title: [{ text: { content: title } }]
    }
  };
  if (datePropName) {
    properties[datePropName] = {
      date: { start: startDate.toISOString() }
    };
  }
  const response = await axios.post(
    `${NOTION_API}/pages`,
    {
      parent: { database_id: databaseId },
      properties,
      children: [
        {
          object: 'block',
          type: 'audio',
          audio: {
            type: 'file_upload',
            file_upload: { id: fileUploadId }
          }
        }
      ]
    },
    { headers: notionHeaders({ 'Content-Type': 'application/json' }) }
  );
  return response.data as { id: string };
}

export async function notionUpload({
  recordingId,
  channelId,
  userId
}: {
  recordingId: string;
  channelId: string;
  userId: string;
}): Promise<{ error: null | string; notify: boolean; url?: string }> {
  if (!notionToken) return { error: 'notion_not_configured', notify: false };

  const notionChannel = await prisma.notionChannel.findUnique({ where: { channelId } });
  if (!notionChannel) return { error: 'notion_channel_not_configured', notify: false };

  const infoExists = await fileExists(path.join(recPath, `${recordingId}.ogg.info`));
  if (!infoExists) return { error: 'info_deleted', notify: false };
  const dataExists = await fileExists(path.join(recPath, `${recordingId}.ogg.data`));
  if (!dataExists) return { error: 'data_deleted', notify: false };

  const info = JSON.parse(await fs.readFile(path.join(recPath, `${recordingId}.ogg.info`), 'utf8'));
  const startDate = new Date(info.startTime);
  const datePart = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;
  const timePart = `${String(startDate.getHours()).padStart(2, '0')}-${String(startDate.getMinutes()).padStart(2, '0')}-${String(startDate.getSeconds()).padStart(2, '0')}`;
  const fileName = `craig_${recordingId}_${datePart}_${timePart}.aac`;
  const pageTitle = `${info.channel} - ${datePart} ${timePart.replace(/-/g, ':')}`;

  const start = Date.now();
  let child: ChildProcessWithoutNullStreams | null = null;
  let tempFile: string | null = null;

  try {
    await setReadyState(recordingId, { message: 'Uploading recording to Notion...' });
    const cookingPath = path.join(cookPath, '..', 'cook.sh');
    child = spawn(cookingPath, [recordingId, 'aac', 'mix'], { detached: true });
    logger.log(`Cooking ${recordingId} (aac.mix) for Notion with process ${child.pid}`);
    child.stderr.on('data', () => {});

    tempFile = path.join(tmpdir(), `${fileName}-${(Math.random() * 1000000).toString(36)}-notion.tmp`);
    await fs.writeFile(tempFile, child.stdout);

    await clearReadyState(recordingId);
    killProcessTree(child);
    logger.info(`Finished cooking for ${recordingId}, took ${(Date.now() - start) / 1000}s`);

    const fileSize = (await fs.stat(tempFile)).size;
    const isMultiPart = fileSize > PART_SIZE;
    const partCount = isMultiPart ? Math.ceil(fileSize / PART_SIZE) : 1;

    const { id: fileUploadId } = await createFileUpload(isMultiPart, partCount);

    const fileHandle = await fs.open(tempFile, 'r');
    for (let i = 0; i < partCount; i++) {
      const partSize = Math.min(PART_SIZE, fileSize - i * PART_SIZE);
      const chunk = Buffer.alloc(partSize);
      await fileHandle.read(chunk, 0, partSize, i * PART_SIZE);
      await sendFilePart(fileUploadId, i + 1, fileName, chunk);
    }
    await fileHandle.close();

    if (isMultiPart) await completeMultiPartUpload(fileUploadId);

    await fs.unlink(tempFile).catch(() => {});
    tempFile = null;

    const { titleProp: titlePropName, dateProp } = await getDatabaseProperties(notionChannel.databaseId);
    const page = await createNotionPage(notionChannel.databaseId, titlePropName, pageTitle, fileUploadId, fileName, dateProp, startDate);

    logger.info(`Uploaded ${recordingId} to Notion (page: ${page.id})`);
    return {
      error: null,
      notify: true,
      url: `https://notion.so/${page.id.replace(/-/g, '')}`,
      pageId: page.id
    };
  } catch (e) {
    logger.error(`Error uploading recording ${recordingId} to Notion`);
    await clearReadyState(recordingId);
    if (child) killProcessTree(child);
    if (tempFile) await fs.unlink(tempFile).catch(() => {});
    let errorString = ((e as Error).message || 'unknown_error').slice(0, 200);
    if ((e as AxiosError).isAxiosError) {
      const res = (e as AxiosError).response;
      if (res) {
        logger.error(`Notion API error (${res.status})`, res.data);
        const notionMessage = res.data?.message;
        if (notionMessage) errorString = `Notion ${res.status}: ${String(notionMessage).slice(0, 180)}`;
      }
    }
    return { error: errorString, notify: true };
  }
}
