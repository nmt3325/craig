import { captureException, withScope } from '@sentry/node';
import fs from 'fs';
import { nanoid } from 'nanoid';
import path from 'path';
import { RouteOptions } from 'fastify';

import {
  clearTranscribeDownload,
  clearTranscribeState,
  getTranscribeDownload,
  getTranscribeState,
  setTranscribeDownload
} from '../cache';
import { ErrorCode } from '../util';
import { downloadPath, removeFile } from '../util/download';
import { getRecording, keyMatches } from '../util/recording';
import { allowedTranscribeFormats, transcribe, transcribeFormatExt, TranscribeFormat } from '../util/transcribe';

export const getRoute: RouteOptions = {
  method: 'GET',
  url: '/api/recording/:id/transcribe',
  handler: async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    if (!id) return reply.status(400).send({ ok: false, error: 'Invalid ID', code: ErrorCode.INVALID_ID });
    const { key } = request.query as Record<string, string>;
    if (!key) return reply.status(403).send({ ok: false, error: 'Invalid key', code: ErrorCode.INVALID_KEY });

    const info = await getRecording(id);
    if (info === false) return reply.status(410).send({ ok: false, error: 'Recording was deleted', code: ErrorCode.RECORDING_DELETED });
    else if (!info) return reply.status(404).send({ ok: false, error: 'Recording not found', code: ErrorCode.RECORDING_NOT_FOUND });
    if (!keyMatches(info, key)) return reply.status(403).send({ ok: false, error: 'Invalid key', code: ErrorCode.INVALID_KEY });

    const state = await getTranscribeState(id);
    const download = await getTranscribeDownload(id);
    return reply.status(200).send({ ok: true, running: !!state, ...(state || {}), download });
  }
};

export const postRoute: RouteOptions = {
  method: 'POST',
  url: '/api/recording/:id/transcribe',
  handler: async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    if (!id) return reply.status(400).send({ ok: false, error: 'Invalid ID', code: ErrorCode.INVALID_ID });
    const { key } = request.query as Record<string, string>;
    if (!key) return reply.status(403).send({ ok: false, error: 'Invalid key', code: ErrorCode.INVALID_KEY });

    const info = await getRecording(id);
    if (info === false) return reply.status(410).send({ ok: false, error: 'Recording was deleted', code: ErrorCode.RECORDING_DELETED });
    else if (!info) return reply.status(404).send({ ok: false, error: 'Recording not found', code: ErrorCode.RECORDING_NOT_FOUND });
    if (!keyMatches(info, key)) return reply.status(403).send({ ok: false, error: 'Invalid key', code: ErrorCode.INVALID_KEY });

    const existing = await getTranscribeState(id);
    if (existing)
      return reply.status(429).send({ ok: false, error: 'Transcription already in progress', code: ErrorCode.TRANSCRIPTION_IN_PROGRESS });

    const body = request.body as { format?: string; lang?: string };

    if (body.format && !allowedTranscribeFormats.includes(body.format as TranscribeFormat))
      return reply.status(400).send({ ok: false, error: 'Invalid format', code: ErrorCode.INVALID_TRANSCRIBE_FORMAT });
    const format = (body.format as TranscribeFormat) || 'srt';
    const lang = body.lang || undefined;

    // Clear any stale download from a previous run.
    const stale = await getTranscribeDownload(id);
    if (stale) {
      await clearTranscribeDownload(id);
      await removeFile(stale.file);
    }

    try {
      const stream = await transcribe(id, format, lang);

      // Write transcription stdout to a uniquely named file.
      const ext = transcribeFormatExt[format];
      const file = `craig-${id}-${nanoid(15)}.${ext}`;
      await setTranscribeDownload(id, { file, format });

      const writer = fs.createWriteStream(path.join(downloadPath, file));
      writer.on('finish', async () => {
        console.log(`Transcription ${id} written to ${file}`);
        await clearTranscribeState(id).catch(() => {});
      });
      writer.on('error', async () => {
        console.error(`Error writing transcription ${id} to ${file}`);
        await clearTranscribeState(id).catch(() => {});
        await clearTranscribeDownload(id).catch(() => {});
        await removeFile(file);
      });
      stream.pipe(writer);

      return reply.status(200).send({ ok: true });
    } catch (err) {
      await clearTranscribeState(id).catch(() => {});
      withScope((scope) => {
        scope.setTag('recordingID', id);
        captureException(err);
      });
      return reply.status(500).send({ ok: false, error: (err as Error).message });
    }
  }
};
